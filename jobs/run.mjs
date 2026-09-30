// Job runner. Usage: node jobs/run.mjs <job>   (or `all` for the scheduled set)
//
// Every job is idempotent and safely re-runnable: crashes, double-scheduling and manual
// re-runs must not double-send or double-write. Each run is recorded in ops.job_runs with
// a status, so a silent failure is visible in the owner digest rather than invisible forever.
//
// Nothing sends real mail until MAIL_PROVIDER + MAIL_API_KEY are set (see lib/mail.mjs);
// until then every message lands in logs/outbox.log and the flow is fully testable.

import { openDb, today, nowIso, addDays } from "../lib/db.mjs";
import { sendMail, mailConfig } from "../lib/mail.mjs";
import { mintToken } from "../lib/tokens.mjs";
import { askClinicEmail } from "../lib/clinic-emails.mjs";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url)));
const SITE = cfg.domain ? `https://${cfg.domain}` : "http://localhost:8430";
const FRESH_DAYS = 30;
const ASK_AFTER_DAYS = 30;      // re-ask a clinic once its answer is this old
const ASK_AFTER_DAYS_FEATURED = 14;  // "priority re-verification" promised to featured clinics
const featuredNpis = new Set((JSON.parse(readFileSync(new URL("../data/featured.json", import.meta.url))).providers ?? []).map((f) => f.npi));
const ALERT_CAP_PER_SITE = 5;   // families told about one opening — see thundering herd note
const ALERT_COOLDOWN_DAYS = 7;  // max one alert per family per week

const db = openDb();

// Distance matching for family alerts: US Census ZCTA internal points for Texas ZIPs.
const ZIPS = JSON.parse(readFileSync(new URL("../data/tx-zips.json", import.meta.url))).zips;
const zipLL = (z) => ZIPS[String(z || "").trim().slice(0, 5)];
function miles(a, b) {                                // haversine, statute miles
  const R = 3958.8, rad = Math.PI / 180;
  const dLa = (b[0] - a[0]) * rad, dLo = (b[1] - a[1]) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const arg = process.argv[2] || "all";

// ---------- helpers ----------
const respondUrl = (siteKey, action) =>
  `${SITE}/respond.html?t=${encodeURIComponent(mintToken({ siteKey, action }))}`;

function latestAvailability(siteKey) {
  return db.prepare(`SELECT * FROM ops.availability WHERE site_key = ? ORDER BY as_of DESC, id DESC LIMIT 1`).get(siteKey);
}

// ---------- jobs ----------

// Ask clinics whether they still have openings. Only clinics whose email we actually hold
// (from a claim, or captured during a phone call) — we never guess or scrape addresses.
async function askClinics() {
  const cap = mailConfig().maxPerRun;
  const due = db.prepare(`
    SELECT c.site_key, c.email, o.name, s.city
    FROM ops.clinic_contacts c
    JOIN sites s ON s.site_key = c.site_key AND s.active = 1
    JOIN organizations o ON o.npi = s.org_npi AND o.active = 1
    WHERE NOT EXISTS (SELECT 1 FROM ops.suppressions x WHERE x.email = c.email)
      AND (
        NOT EXISTS (SELECT 1 FROM ops.availability a WHERE a.site_key = c.site_key)
        OR (SELECT MAX(as_of) FROM ops.availability a WHERE a.site_key = c.site_key)
           <= date('now', '-' || (CASE WHEN c.site_key IN (SELECT value FROM json_each(?)) THEN ${ASK_AFTER_DAYS_FEATURED} ELSE ${ASK_AFTER_DAYS} END) || ' days')
      )
    LIMIT ?`).all(JSON.stringify([...featuredNpis]), cap);

  let sent = 0, skipped = 0;
  for (const r of due) {
    // Dedupe per clinic per period (a month, or half-month for featured clinics): a re-run
    // today must not send a second ask.
    const half = featuredNpis.has(r.site_key) ? (Number(today().slice(8, 10)) <= 15 ? "-a" : "-b") : "";
    const dedupeKey = `ask:${r.site_key}:${today().slice(0, 7)}${half}`;
    const { subject, text, html } = askClinicEmail({
      name: r.name, siteKey: r.site_key, site: SITE, contact: cfg.correctionsEmail,
      yesUrl: respondUrl(r.site_key, "accepting"), fullUrl: respondUrl(r.site_key, "full"),
      insuranceUrl: `${SITE}/insurance.html?t=${encodeURIComponent(mintToken({ siteKey: r.site_key, action: "insurance" }))}`,
    });
    const res = await sendMail(db, { to: r.email, subject, text, html, dedupeKey, tag: "ask-clinic" });
    if (res.sent || res.logged) sent++; else skipped++;
  }
  return `asked ${sent}, skipped ${skipped}, eligible ${due.length}`;
}

// Tell waiting families when a clinic near them confirms an opening.
//
// THUNDERING HERD: a clinic with two open slots must not receive 400 phone calls, or it stops
// answering us and 398 families are disappointed. So each newly-confirmed opening notifies at
// most ALERT_CAP_PER_SITE families, longest-waiting first, and each family hears about any
// given clinic only once ever and at most one alert per ALERT_COOLDOWN_DAYS.
async function familyAlerts() {
  const openings = db.prepare(`
    SELECT a.site_key, s.city_slug, s.city, s.zip, s.phone, o.name
    FROM ops.availability a
    JOIN sites s ON s.site_key = a.site_key AND s.active = 1
    JOIN organizations o ON o.npi = s.org_npi AND o.active = 1
    WHERE a.accepting = 1
      AND a.as_of >= date('now', '-${FRESH_DAYS} days')
      AND a.id = (SELECT MAX(id) FROM ops.availability b WHERE b.site_key = a.site_key)`).all();

  let notified = 0;
  for (const op of openings) {
    // "Near you" means within the family's own travel radius of their ZIP. Where either ZIP has
    // no location (the registry holds some out-of-state mailing ZIPs) we fall back to the city
    // they signed up from — never to "anywhere in Texas". A plan the clinic has confirmed it does
    // NOT take rules it out; an unconfirmed plan doesn't (most are unconfirmed, and the family
    // can ask when they call).
    const siteLL = zipLL(op.zip);
    const refused = new Set(db.prepare(`SELECT payer FROM ops.payer_acceptance WHERE site_key = ? AND status = 'verified_no'`)
      .all(op.site_key).map((r) => r.payer));
    const subs = db.prepare(`
      SELECT * FROM ops.alert_subscribers
      WHERE unsubscribed_at IS NULL
        AND (last_sent_at IS NULL OR last_sent_at <= datetime('now', '-${ALERT_COOLDOWN_DAYS} days'))
        AND NOT EXISTS (SELECT 1 FROM ops.alert_sends x WHERE x.subscriber_id = alert_subscribers.id AND x.site_key = ?)
        AND NOT EXISTS (SELECT 1 FROM ops.suppressions p WHERE p.email = alert_subscribers.email)
      ORDER BY created_at ASC`).all(op.site_key)
      .map((sub) => {
        const subLL = zipLL(sub.zip);
        const dist = siteLL && subLL ? miles(subLL, siteLL) : null;
        const near = dist != null ? dist <= (sub.radius_miles || 25) : !!sub.city_slug && sub.city_slug === op.city_slug;
        return { ...sub, dist, near };
      })
      .filter((sub) => sub.near && !(sub.payer && refused.has(sub.payer)))
      .slice(0, ALERT_CAP_PER_SITE);                  // longest-waiting first (ORDER BY above)

    for (const sub of subs) {
      const text = `Good news — a clinic near you just confirmed it can take new clients.

${op.name}
${op.city}, TX${sub.dist != null ? ` · ${sub.dist < 1.5 ? "about a mile" : `about ${Math.round(sub.dist)} miles`} from ${sub.zip}` : ""}${op.phone ? `\n${op.phone}` : ""}
${SITE}/providers/${op.site_key}.html

Call soon; openings move fast, and we only tell a handful of families about each one so you
aren't competing with a crowd.

We confirmed this directly with the clinic. If they tell you something different, reply and
we'll re-check the same day — that correction helps every family after you.

— ABA Openings
Stop these alerts: ${SITE}/unsubscribe.html?e=${encodeURIComponent(sub.email)}`;

      const res = await sendMail(db, {
        to: sub.email, subject: `Opening near you: ${op.name} (${op.city})`,
        text, dedupeKey: `alert:${sub.id}:${op.site_key}`, tag: "family-alert",
      });
      if (res.sent || res.logged) {
        db.prepare(`INSERT OR IGNORE INTO ops.alert_sends (subscriber_id, site_key, sent_at) VALUES (?,?,?)`)
          .run(sub.id, op.site_key, nowIso());
        db.prepare(`UPDATE ops.alert_subscribers SET last_sent_at = ? WHERE id = ?`).run(nowIso(), sub.id);
        notified++;
      }
    }
  }
  return `${openings.length} live openings, ${notified} families notified`;
}

// A licence lapsing costs a clinic its verified badge. Telling them is genuinely useful,
// and it is the most natural reason we ever have to email a clinic that hasn't claimed.
async function licenseExpiry() {
  const rows = db.prepare(`
    SELECT c.site_key, c.email, o.name, o.ao_license_no, o.ao_license_expires
    FROM ops.clinic_contacts c
    JOIN organizations o ON o.npi = c.site_key
    WHERE o.active = 1 AND o.ao_license_status = 'active'
      AND o.ao_license_expires BETWEEN date('now') AND date('now', '+30 days')
      AND NOT EXISTS (SELECT 1 FROM ops.suppressions x WHERE x.email = c.email)
    LIMIT ?`).all(mailConfig().maxPerRun);

  let sent = 0;
  for (const r of rows) {
    const text = `Hi ${r.name},

Heads up: the Texas license we verified for your listing (${r.ao_license_no}) is due to expire
on ${r.ao_license_expires}.

Once it lapses in the state roster, the "License verified" badge on your ABA Openings listing
drops off automatically — we only publish verification we can positively confirm. Renewing
restores it at our next weekly sync, no action needed on your side.

Your listing: ${SITE}/providers/${r.site_key}.html

— ABA Openings
${cfg.correctionsEmail} · Reply "stop" and we won't email again.`;
    const res = await sendMail(db, {
      to: r.email, subject: `Your Texas license expires ${r.ao_license_expires}`,
      text, dedupeKey: `expiry:${r.site_key}:${r.ao_license_expires}`, tag: "license-expiry",
    });
    if (res.sent || res.logged) sent++;
  }
  return `${rows.length} expiring soon, ${sent} notified`;
}

// Data anomaly detection. The directory silently emptying is far worse than a job erroring.
async function healthCheck() {
  const problems = [];
  const orgs = db.prepare(`SELECT COUNT(*) c FROM organizations WHERE active=1`).get().c;
  const lic = db.prepare(`SELECT COUNT(*) c FROM clinicians WHERE status='active'`).get().c;
  const stale = db.prepare(`SELECT COUNT(*) c FROM ops.availability WHERE as_of <= date('now','-${FRESH_DAYS} days')`).get().c;
  const fresh = db.prepare(`SELECT COUNT(DISTINCT site_key) c FROM ops.availability WHERE as_of > date('now','-${FRESH_DAYS} days')`).get().c;
  if (orgs < 1000) problems.push(`organization count collapsed to ${orgs}`);
  if (lic < 5000) problems.push(`active licence count collapsed to ${lic}`);
  const failed = db.prepare(`SELECT COUNT(*) c FROM ops.job_runs WHERE status='error' AND started_at > datetime('now','-7 days')`).get().c;
  if (failed) problems.push(`${failed} job failures in the last 7 days`);
  const bounced = db.prepare(`SELECT COUNT(*) c FROM ops.mail_log WHERE status='failed' AND created_at > datetime('now','-7 days')`).get().c;
  if (bounced > 10) problems.push(`${bounced} mail failures in the last 7 days`);
  return problems.length
    ? `PROBLEMS: ${problems.join("; ")} | orgs=${orgs} licences=${lic} fresh=${fresh} stale=${stale}`
    : `healthy | orgs=${orgs} licences=${lic} fresh=${fresh} stale=${stale}`;
}

// Weekly digest so a solo operator can tell at a glance whether the machine is still running.
async function ownerDigest() {
  const s = {
    open: db.prepare(`SELECT COUNT(*) c FROM (SELECT site_key, accepting, as_of, ROW_NUMBER() OVER (PARTITION BY site_key ORDER BY as_of DESC, id DESC) rn FROM ops.availability) WHERE rn=1 AND accepting=1 AND as_of > date('now','-${FRESH_DAYS} days')`).get().c,
    fresh: db.prepare(`SELECT COUNT(DISTINCT site_key) c FROM ops.availability WHERE as_of > date('now','-${FRESH_DAYS} days')`).get().c,
    calls: db.prepare(`SELECT COUNT(*) c FROM ops.call_log WHERE created_at > datetime('now','-7 days')`).get().c,
    leads: db.prepare(`SELECT COUNT(*) c FROM ops.leads WHERE created_at > datetime('now','-7 days')`).get().c,
    claims: db.prepare(`SELECT COUNT(*) c FROM ops.claims WHERE status='pending'`).get().c,
    subs: db.prepare(`SELECT COUNT(*) c FROM ops.alert_subscribers WHERE unsubscribed_at IS NULL`).get().c,
    mail: db.prepare(`SELECT COUNT(*) c FROM ops.mail_log WHERE created_at > datetime('now','-7 days')`).get().c,
  };
  const health = await healthCheck();
  const text = `ABA Openings — week ending ${today()}

  Confirmed openings live:      ${s.open}
  Clinics with fresh status:    ${s.fresh}
  Calls logged this week:       ${s.calls}
  Family inquiries this week:   ${s.leads}
  Claims awaiting review:       ${s.claims}
  Alert subscribers:            ${s.subs}
  Emails sent this week:        ${s.mail}

System: ${health}

Console: npm run ops    Site: ${SITE}/openings.html`;
  await sendMail(db, {
    to: cfg.correctionsEmail, subject: `ABA Openings weekly — ${s.open} openings, ${s.calls} calls`,
    text, dedupeKey: `digest:${today()}`, tag: "owner-digest",
  });
  return `digest: ${s.open} openings, ${s.fresh} fresh, ${s.calls} calls, ${s.subs} subscribers`;
}

const JOBS = {
  "ask-clinics": askClinics,
  "family-alerts": familyAlerts,
  "license-expiry": licenseExpiry,
  "health-check": healthCheck,
  "owner-digest": ownerDigest,
};

async function runOne(name) {
  const fn = JOBS[name];
  if (!fn) { console.error(`unknown job: ${name}. known: ${Object.keys(JOBS).join(", ")}`); process.exitCode = 1; return; }
  const started = nowIso();
  const id = db.prepare(`INSERT INTO ops.job_runs (job, started_at, status) VALUES (?,?,'running')`).run(name, started).lastInsertRowid;
  try {
    const summary = await fn();
    db.prepare(`UPDATE ops.job_runs SET finished_at=?, status='ok', summary=? WHERE id=?`).run(nowIso(), summary, id);
    console.log(`[${name}] ok — ${summary}`);
  } catch (err) {
    db.prepare(`UPDATE ops.job_runs SET finished_at=?, status='error', error=? WHERE id=?`).run(nowIso(), String(err.stack ?? err).slice(0, 1000), id);
    console.error(`[${name}] ERROR — ${err.message}`);
    process.exitCode = 1;
  }
}

const mode = mailConfig().provider === "dryrun" || !mailConfig().apiKey ? "DRY RUN (no mail sent)" : `live via ${mailConfig().provider}`;
console.log(`jobs: ${mode}`);
if (arg === "all") { for (const n of ["ask-clinics", "family-alerts", "license-expiry", "health-check"]) await runOne(n); }
else await runOne(arg);

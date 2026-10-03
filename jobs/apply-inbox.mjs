// Applies queued site events. Usage: node jobs/apply-inbox.mjs   (launchd runs it every 10 min)
//
// The Vercel functions (api/submit.mjs, api/stripe.mjs) only validate and queue: each form
// post, one-click answer and Stripe payment becomes a JSON file in the private repo
// xasdta/abaopenings-inbox. This job owns everything else — rules, database, email — so
// nothing waits on a human except the one step that must: approving a claim.
//
//   respond accepting|full   → availability recorded, listing rebuilt
//   respond claim-confirm    → claimant proved their email → owner gets [Approve] [Reject]
//   respond claim-approve    → claim published, clinic added to the monthly availability loop
//   claim                    → licence + NPI checked, claimant asked to confirm their email
//   insurance                → clinic's ticked plans recorded as confirmed (the rest as not accepted)
//   inquiry                  → forwarded to the clinic (or to the owner if we hold no address)
//   alert / unsubscribe      → subscriber added / suppressed
//   stripe checkout          → NPI, verified licence and city cap checked → published or refunded
//   stripe subscription_ended→ featured card removed
//
// Claims are never published without the owner's click. Nothing in a web form proves who
// someone is — a licence number is public — and publishing on form data alone would let a
// stranger put their own contact details on a competitor's listing.
//
// Every event id is recorded in ops.inbox_applied before its file is deleted, so a crash at
// any point re-runs safely. Any public change triggers generate → commit → push.

import "../lib/env.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openDb, today, nowIso } from "../lib/db.mjs";
import { sendMail, isSuppressed, suppress } from "../lib/mail.mjs";
import { mintToken, verifyToken } from "../lib/tokens.mjs";
import { PAYER_KEYS } from "../api/_payers.mjs";

const root = new URL("../", import.meta.url);
const cfg = JSON.parse(readFileSync(new URL("site.config.json", root)));
const SITE = `https://${cfg.domain}`;
const OWNER = cfg.correctionsEmail;
const REPO_API = "https://api.github.com/repos/xasdta/abaopenings-inbox/contents/events";
const MIN_PAID_CENTS = cfg.featuredPriceMonthly * 100;
const FEATURED = new URL("data/featured.json", root);
const CLAIMS = new URL("data/claims.json", root);

const db = openDb();
const link = (key, action, ttlDays = 45) =>
  `${SITE}/${action === "insurance" ? "insurance" : "respond"}.html?t=${encodeURIComponent(mintToken({ siteKey: String(key), action, ttlDays }))}`;
const readJson = (u) => JSON.parse(readFileSync(u, "utf8"));
const writeJson = (u, v) => writeFileSync(u, JSON.stringify(v, null, 2) + "\n");
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ""));
const safeUrl = (u) => {
  if (!u) return null;
  try { const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); return /^https?:$/.test(x.protocol) ? x.href : null; }
  catch { return null; }
};
// "THOMPSON, JELISIA J" vs "Jelisia Thompson": every name the claimant typed must appear in the
// roster name; initials and word order are ignored.
const nameWords = (s) => String(s || "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
const sameName = (roster, typed) => { const r = new Set(nameWords(roster)), t = nameWords(typed); return t.length >= 2 && t.every((w) => r.has(w)); };
const licDigits = (s) => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
const org = (npi) => db.prepare(`
  SELECT o.*, s.city, s.city_slug, s.phone FROM organizations o JOIN sites s ON s.site_key = o.npi
  WHERE o.npi = ? AND o.active = 1 AND s.active = 1`).get(String(npi || "").replace(/\D/g, ""));
// Where a family's inquiry goes: the address the clinic gave us, else the intake address it
// publishes on its own website (found by research for outreach), unless it opted out or bounced.
const contactFor = (npi) => {
  const c = db.prepare(`SELECT email FROM ops.clinic_contacts WHERE site_key = ?`).get(npi)?.email
    || db.prepare(`SELECT email FROM ops.outreach WHERE npi = ? AND status NOT IN ('unsubscribed','failed')`).get(npi)?.email;
  return c && !isSuppressed(db, c) ? c : null;
};
const mail = (m) => sendMail(db, m);

// ---------- GitHub inbox ----------
function ghToken() {
  if (process.env.INBOX_GH_TOKEN) return process.env.INBOX_GH_TOKEN;
  for (const gh of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]) {
    try { return execFileSync(gh, ["auth", "token"], { encoding: "utf8" }).trim(); } catch {}
  }
  throw new Error("no GitHub token: set INBOX_GH_TOKEN or log in with gh");
}
const GH = { Accept: "application/vnd.github+json", "User-Agent": "abaopenings-apply/1.0" };
async function gh(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...GH, Authorization: `Bearer ${ghToken()}`, ...(opts.headers || {}) } });
  if (r.status === 404 && (!opts.method || opts.method === "GET")) return null;
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

// ---------- handlers: each returns {outcome, publish?} ----------
const H = {};

H.respond = async ({ t }) => {
  const v = verifyToken(t);
  if (!v.ok) return { outcome: `rejected:${v.reason}` };

  if (v.action === "accepting" || v.action === "full") {
    const o = org(v.siteKey);
    if (!o) return { outcome: "unknown_clinic" };
    db.prepare(`INSERT INTO ops.availability (site_key, accepting, as_of, source, collected_by) VALUES (?,?,?,'email','clinic')`)
      .run(o.npi, v.action === "accepting" ? 1 : 0, today());
    return { outcome: `${o.name}: ${v.action}`, publish: true };
  }

  const claim = db.prepare(`SELECT * FROM ops.claims WHERE id = ?`).get(Number(v.siteKey));
  if (!claim) return { outcome: "unknown_claim" };
  const o = org(claim.org_npi);

  if (v.action === "claim-confirm") {
    if (claim.status !== "awaiting_email") return { outcome: `claim ${claim.id} already ${claim.status}` };
    db.prepare(`UPDATE ops.claims SET status='awaiting_approval' WHERE id=?`).run(claim.id);
    // Strong claims (see H.claim) need no owner click once the claimant has proved the address.
    if (/^AUTO-APPROVE/m.test(claim.checks || "") && o) return approveClaim({ ...claim, status: "awaiting_approval" }, o);
    await mail({
      to: OWNER, tag: "claim-approval", dedupeKey: `claim-approval:${claim.id}`,
      subject: `Approve claim? ${o?.name ?? claim.clinic}`,
      text: `${claim.name} (${claim.role || "role not given"}) wants to claim ${o?.name ?? claim.clinic} and has confirmed ${claim.email}.

Automatic checks:
${claim.checks}

Approving publishes a "Claimed profile" badge with ${claim.email} as the intake contact, and
adds that address to the monthly "are you accepting clients?" emails for this listing.

  APPROVE: ${link(claim.id, "claim-approve", 14)}
  Reject:  ${link(claim.id, "claim-reject", 14)}

If the director's licence did not match, the reliable test is a call to the clinic's number on
public record: ${o?.phone ?? "(none)"}.
Listing: ${SITE}/providers/${claim.org_npi}.html`,
    });
    return { outcome: `claim ${claim.id} confirmed, sent for approval` };
  }

  if (v.action === "claim-approve") {
    if (claim.status !== "awaiting_approval") return { outcome: `claim ${claim.id} already ${claim.status}` };
    if (!o) return { outcome: "clinic no longer listed" };
    return approveClaim(claim, o);
  }

  if (v.action === "claim-reject") {
    if (claim.status !== "awaiting_approval") return { outcome: `claim ${claim.id} already ${claim.status}` };
    db.prepare(`UPDATE ops.claims SET status='rejected', decided_at=? WHERE id=?`).run(nowIso(), claim.id);
    await mail({
      to: claim.email, tag: "claim-rejected", dedupeKey: `claim-rejected:${claim.id}`,
      subject: `About your claim for ${o?.name ?? claim.clinic}`,
      text: `Hi ${claim.name},

We weren't able to confirm that you represent ${o?.name ?? claim.clinic}, so the listing hasn't been
changed. If this is a mistake, reply to this email from an address at the clinic and we'll take
another look.

— ${cfg.siteName}`,
    });
    return { outcome: `claim ${claim.id} rejected` };
  }
  return { outcome: `unknown action ${v.action}` };
};

// The clinic ticked the plans it takes. Ticked → accepted, unticked → not accepted, both dated
// and marked as confirmed by the clinic. Re-verified here: the Vercel check is not trusted alone.
H.insurance = async ({ t, accepted }) => {
  const v = verifyToken(t);
  if (!v.ok) return { outcome: `rejected:${v.reason}` };
  if (v.action !== "insurance") return { outcome: "rejected:wrong_link" };
  const plans = Array.isArray(accepted) ? accepted : [];
  if (!plans.every((k) => PAYER_KEYS.includes(k))) return { outcome: "rejected:bad_plans" };
  const o = org(v.siteKey);
  if (!o) return { outcome: "unknown_clinic" };
  const upsert = db.prepare(`
    INSERT INTO ops.payer_acceptance (site_key, payer, status, verified_at, verify_method) VALUES (?,?,?,?, 'clinic')
    ON CONFLICT(site_key, payer) DO UPDATE SET status=excluded.status, verified_at=excluded.verified_at, verify_method='clinic'`);
  db.exec("BEGIN");
  try {
    for (const k of PAYER_KEYS) upsert.run(o.npi, k, plans.includes(k) ? "verified_yes" : "verified_no", today());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { outcome: `${o.name}: accepts ${plans.join(", ") || "none of the listed plans"}`, publish: true };
};

// Publish an approved claim: listing marked claimed, the claimant becomes the intake contact
// (inquiries and the monthly availability ask go to them), and they're emailed the next steps.
async function approveClaim(claim, o) {
  const data = readJson(CLAIMS);
  data.providers = data.providers.filter((c) => c.npi !== o.npi);
  data.providers.push({ npi: o.npi, intake_email: claim.email, claimed_date: today() });
  writeJson(CLAIMS, data);
  db.prepare(`INSERT INTO ops.clinic_contacts (site_key, email, source, confirmed_at, created_at) VALUES (?,?,'claim',?,?)
              ON CONFLICT(site_key) DO UPDATE SET email=excluded.email, source='claim', confirmed_at=excluded.confirmed_at`)
    .run(o.npi, claim.email.toLowerCase(), nowIso(), nowIso());
  db.prepare(`UPDATE ops.claims SET status='approved', decided_at=? WHERE id=?`).run(nowIso(), claim.id);
  await mail({
    to: claim.email, tag: "claim-approved", dedupeKey: `claim-approved:${claim.id}`,
    subject: `${o.name} is now claimed on ${cfg.siteName}`,
    text: `Hi ${claim.name},

Your listing is verified as claimed and will show the "Claimed profile" badge within the hour:
${SITE}/providers/${o.npi}.html

The single most useful thing you can do now: tell families whether you can take new clients.

  Yes, we're accepting:  ${link(o.npi, "accepting")}
  No, we're full:        ${link(o.npi, "full")}

And which insurance plans you take (families filter by plan too):

  Update your plans:     ${link(o.npi, "insurance")}

One click, no login. We'll ask again about once a month so your status never goes stale.

— ${cfg.siteName}
Questions or corrections: just reply to this email.`,
  });
  return { outcome: `claim ${claim.id} approved`, publish: true };
}

// Clinic names as people type them vs the NPI record: "A Gifted Journey (Behavioral, Consulting
// and Advocacy Services)" vs "A GIFTED JOURNEY ( BEHAVIORAL, CONSULTING AND ADVOCACY)".
const LEGAL = new Set(["LLC", "PLLC", "INC", "CORP", "CO", "LP", "LLP", "PA", "PC", "LTD", "THE", "AND", "OF", "SERVICES", "SERVICE"]);
const clinicWords = (s) => [...new Set(String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !LEGAL.has(w)))];
function nameScore(a, b) {
  const x = clinicWords(a), y = new Set(clinicWords(b));
  if (!x.length || !y.size) return 0;
  const shared = x.filter((w) => y.has(w)).length;
  return shared / Math.min(x.length, y.size);
}
const FREEMAIL = /@(gmail|yahoo|outlook|hotmail|aol|icloud|proton|live|msn|me|comcast|att|sbcglobal)\./i;

H.claim = async (d) => {
  const email = d.email.toLowerCase(), domain = email.split("@")[1];
  const signals = [];
  // 1. a real 10-digit NPI (the form carries it from the clinic's page)
  const npiDigits = String(d.npi || "").replace(/\D/g, "");
  let o = npiDigits.length === 10 ? org(npiDigits) : null;
  let how = o ? "NPI" : null;
  // 2. the claimant's email domain matches the address the clinic publishes on its own website
  const byDomain = FREEMAIL.test(email) ? [] : [...new Set(db.prepare(`
      SELECT npi k FROM ops.outreach WHERE lower(email) LIKE ? UNION SELECT site_key k FROM ops.clinic_contacts WHERE lower(email) LIKE ?`)
    .all(`%@${domain}`, `%@${domain}`).map((r) => r.k))];
  if (!o && byDomain.length === 1) { o = org(byDomain[0]); how = "email domain (the clinic's own published address)"; }
  // 3. the licence given is the director's licence on a clinic's NPI record
  const lic = d.license ? db.prepare(`
    SELECT * FROM clinicians WHERE ltrim(substr(license_no, instr(license_no, '-') + 1), '0') = ?
    ORDER BY status = 'active' DESC LIMIT 1`).get(licDigits(d.license)) : null;
  if (!o && lic) {
    const hits = db.prepare(`SELECT npi, ao_license_no FROM organizations WHERE active = 1 AND ao_license_no IS NOT NULL`).all().filter((x) => licDigits(x.ao_license_no) === licDigits(lic.license_no));
    if (hits.length === 1) { o = org(hits[0].npi); how = "director's licence"; }
  }
  // 4. a close clinic-name match, narrowed by the claimant being the official on the NPI record
  let near = [];
  if (d.clinic) {
    near = db.prepare(`SELECT npi, name, ao_name FROM organizations WHERE active = 1`).all()
      .map((x) => ({ ...x, score: nameScore(d.clinic, x.name) })).filter((x) => x.score >= 0.75).sort((x, y) => y.score - x.score);
    if (!o) {
      const strong = near.filter((x) => x.score === 1);
      const pick = strong.length === 1 ? strong[0] : near.filter((x) => sameName(x.ao_name, d.name)).length === 1 ? near.find((x) => sameName(x.ao_name, d.name)) : null;
      if (pick) { o = org(pick.npi); how = "clinic name"; }
    }
  }
  const domainMatch = !!o && byDomain.includes(o.npi);
  const aoMatch = !!o && sameName(o.ao_name, d.name) && o.ao_license_status === "active";
  const licMatch = lic?.status === "active" && sameName(lic.name, d.name);

  const checks = [
    o ? `✅ Listing found by ${how}: ${o.name} (NPI ${o.npi}, ${o.city})` : `✗ No listing matched "${d.clinic}"${d.npi ? ` / "${d.npi}"` : ""}`,
    !d.license ? (aoMatch ? null : "ℹ No licence number given")
      : !lic ? `✗ Licence ${d.license} not found in the TDLR roster`
      : `${lic.status === "active" ? "✅" : "✗"} Licence ${lic.license_no} is ${lic.status} (${lic.name})`,
    lic ? (sameName(lic.name, d.name) ? "✅ Licence holder's name matches the claimant" : `⚠ Licence holder ${lic.name} ≠ claimant ${d.name}`) : null,
    aoMatch ? `✅ Claimant is the official on the clinic's NPI record (${o.ao_name}), licence ${o.ao_license_no} active` : null,
    lic && o && !aoMatch ? (licDigits(o.ao_license_no) === licDigits(lic.license_no)
      ? "✅ Licence is the one on record for this clinic's director"
      : `ℹ Licence is not the clinic director's on record (${o.ao_name || "none on record"}${o.ao_license_no ? ", " + o.ao_license_no : ""})`) : null,
    FREEMAIL.test(email) ? "⚠ Personal email address, not a clinic domain"
      : domainMatch ? `✅ Email domain ${domain} matches the clinic's own published address` : `ℹ Email domain: ${domain}`,
  ];
  // Verified enough to send the confirm link: a listing plus one personal credential or the clinic's own domain.
  const ok = !!o && (licMatch || aoMatch || domainMatch);
  // Strong enough to approve without the owner once the email is confirmed: the clinic's domain AND a credential.
  if (ok && domainMatch && (licMatch || aoMatch)) checks.unshift("AUTO-APPROVE: clinic domain and credential both match; approved when the email is confirmed");
  const checkText = checks.filter(Boolean).join("\n");

  const dup = o && db.prepare(`SELECT id FROM ops.claims WHERE org_npi=? AND lower(email)=? AND created_at > datetime('now','-1 day')`).get(o.npi, email);
  if (dup) return { outcome: `duplicate of claim ${dup.id}` };

  const id = db.prepare(`INSERT INTO ops.claims (org_npi, clinic, name, role, email, license_no, status, checks, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(o?.npi ?? "", d.clinic, d.name, d.role ?? null, email, d.license ?? null, ok ? "awaiting_email" : "unmatched", checkText, nowIso())
    .lastInsertRowid;

  if (!ok) {
    // No "reply to us": offer the closest listings, each with a link that claims that exact one.
    const options = (near.length ? near.slice(0, 3).map((x) => org(x.npi)).filter(Boolean) : []);
    await mail({
      to: email, tag: "claim-unmatched", dedupeKey: `claim-unmatched:${id}`,
      subject: `One more step to claim ${d.clinic}`,
      text: `Hi ${d.name},

Thanks for claiming ${d.clinic}. We verify every claim against public records before anything
changes, and we couldn't match this one automatically.
${options.length ? `
Is your clinic one of these? Open its link and send the short form again; it fills in the clinic for you:

${options.map((x) => `  ${x.name} (${x.city})\n  ${SITE}/for-clinics.html?npi=${x.npi}#claim`).join("\n\n")}
` : `
Find your clinic on ${SITE}, open its page and click "Claim this profile"; the form then knows exactly
which listing is yours.
`}
It also helps to add your Texas behavior-analyst licence number (it starts with BHV-, from the TDLR
licence lookup), or to use your email address at the clinic's own domain.

— ${cfg.siteName}`,
    });
    return { outcome: `claim ${id} unmatched (sent ${options.length} suggestions)` };
  }

  await mail({
    to: email, tag: "claim-confirm", dedupeKey: `claim-confirm:${id}`,
    subject: `Confirm your claim for ${o.name}`,
    text: `Hi ${d.name},

Please confirm this is your email address to continue claiming ${o.name}:

  ${link(id, "claim-confirm", 7)}

${/^AUTO-APPROVE/m.test(checkText) ? "Your details matched the public records, so the listing becomes yours as soon as you confirm." : "Your details matched the public records. Once you confirm, we do a final review (usually the same day)\nand email you when the listing is yours."}

If you didn't request this, ignore this email and nothing will change.

— ${cfg.siteName}`,
  });
  return { outcome: `claim ${id} awaiting email confirmation` };
};

// A family's inquiry. The form promises "We pass your message to the provider", so it goes to
// the clinic whenever we hold an address for it. If we don't yet, the family is told so plainly,
// with the clinic's phone; the clinic jumps the research queue (factory/engine/research.mjs reads
// waiting leads) and forwardWaiting() sends the message once an address turns up, within 7 days.
// The owner sees all of it in the evening summary, not one email per inquiry.
const summaryOf = (d) => `Name:       ${d.name}
Contact:    ${d.contact}
Insurance:  ${d.insurance ?? "(not given)"}
Child's age: ${d.child_age ?? "(not given)"}
${d.message ? `\nMessage:\n${d.message}\n` : ""}`;
async function forwardInquiry(o, d, to, late) {
  await mail({
    to, tag: "inquiry-forward", dedupeKey: `inquiry:${o.npi}:${d.contact}:${late ? "late" : today()}`,
    replyTo: isEmail(d.contact) ? d.contact : undefined,
    subject: `New family inquiry via ${cfg.siteName}`,
    text: `A family asked about availability at ${o.name}${late ? ` (they wrote on ${late}; we've only now found your clinic's email address)` : ""}:\n\n${summaryOf(d)}\nPlease reply to them directly${isEmail(d.contact) ? " (replying to this email reaches them)" : ""}. We don't charge per inquiry and never will.\n\nYour listing: ${SITE}/providers/${o.npi}.html\n\n— ${cfg.siteName}`,
  });
}
H.inquiry = async (d) => {
  const o = org(d.npi);
  if (!o) return { outcome: "unknown clinic" };
  const clinicEmail = contactFor(o.npi);
  db.prepare(`INSERT INTO ops.leads (site_key, payer, child_age, name, contact, message, source_page, created_at, status, forwarded_to, forwarded_at)
              VALUES (?,?,?,?,?,?,'provider',?,?,?,?)`)
    .run(o.npi, d.insurance ?? null, d.child_age ?? null, d.name, d.contact, d.message ?? null, nowIso(),
      clinicEmail ? "forwarded" : "waiting", clinicEmail ?? null, clinicEmail ? nowIso() : null);
  if (clinicEmail) await forwardInquiry(o, d, clinicEmail);
  if (isEmail(d.contact)) {
    await mail({
      to: d.contact, tag: "inquiry-ack", dedupeKey: `inquiry-ack:${o.npi}:${d.contact}:${today()}`,
      subject: clinicEmail ? `We passed your message to ${o.name}` : `About your message to ${o.name}`,
      text: clinicEmail ? `Hi ${d.name},

Your inquiry is on its way to ${o.name}.${o.phone ? ` Clinics can be slow to answer email — if you don't hear back in a couple of days, call them at ${o.phone}.` : ""}

Their listing: ${SITE}/providers/${o.npi}.html

We never sell family contact information and never share it with any other clinic.

— ${cfg.siteName}` : `Hi ${d.name},

Thanks for your message about ${o.name}. We don't have an email address for this clinic yet, so we couldn't send it straight away. We're looking for one now and will pass your message on as soon as we find it (usually within a few days).

The fastest way to reach them is by phone${o.phone ? `: ${o.phone}` : " — their number is on their listing"}.

Their listing: ${SITE}/providers/${o.npi}.html

We never sell family contact information and never share it with any other clinic.

— ${cfg.siteName}`,
    });
  }
  return { outcome: `inquiry for ${o.name} → ${clinicEmail ? "forwarded to clinic" : "waiting for a clinic email (family given the phone)"}` };
};

// Inquiries waiting for a clinic address: forward once research finds one; give up after 7 days.
async function forwardWaiting() {
  const out = [];
  for (const l of db.prepare(`SELECT * FROM ops.leads WHERE status='waiting'`).all()) {
    if (Date.now() - Date.parse(l.created_at) > 7 * 864e5) { db.prepare(`UPDATE ops.leads SET status='expired' WHERE id=?`).run(l.id); out.push(`inquiry ${l.id}: no clinic email within 7 days, stopped`); continue; }
    const to = contactFor(l.site_key), o = org(l.site_key);
    if (!to || !o) continue;
    const d = { name: l.name, contact: l.contact, insurance: l.payer, child_age: l.child_age, message: l.message };
    await forwardInquiry(o, d, to, l.created_at.slice(0, 10));
    db.prepare(`UPDATE ops.leads SET status='forwarded', forwarded_to=?, forwarded_at=? WHERE id=?`).run(to, nowIso(), l.id);
    if (isEmail(l.contact)) await mail({ to: l.contact, tag: "inquiry-ack", dedupeKey: `inquiry-late:${l.id}`,
      subject: `We passed your message to ${o.name}`,
      text: `Hi ${l.name},\n\nGood news: we found an email address for ${o.name} and have passed your message on. They can reply to you directly.${o.phone ? ` If you don't hear back in a couple of days, call them at ${o.phone}.` : ""}\n\n— ${cfg.siteName}` });
    out.push(`inquiry ${l.id}: forwarded to ${o.name} (address found)`);
  }
  return out;
}

H.alert = async (d) => {
  const email = d.email.toLowerCase();
  // Matching uses the ZIP + radius, so both must be sane; the plan must be one we know.
  const zip = String(d.zip ?? "").trim().slice(0, 5);
  if (!/^\d{5}$/.test(zip)) return { outcome: `rejected: bad ZIP ${JSON.stringify(d.zip ?? "")}` };
  const payer = PAYER_KEYS.includes(d.insurance) ? d.insurance : null;
  const radius = [10, 25, 50].includes(parseInt(d.radius, 10)) ? parseInt(d.radius, 10) : 25;
  const city = d.alert_city || null;
  const existing = db.prepare(`SELECT id FROM ops.alert_subscribers WHERE email=? AND coalesce(city_slug,'')=coalesce(?,'') AND unsubscribed_at IS NULL`).get(email, city);
  if (existing) return { outcome: "already subscribed" };
  // Signing up again is an explicit opt-in, so it lifts an earlier unsubscribe (never a bounce).
  db.prepare(`DELETE FROM ops.suppressions WHERE email=? AND reason='unsubscribed'`).run(email);
  db.prepare(`INSERT INTO ops.alert_subscribers (email, zip, city_slug, payer, child_age, radius_miles, confirmed_at, created_at, token)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(email, zip, city, payer, d.child_age ?? null, radius, nowIso(), nowIso(), randomBytes(12).toString("hex"));
  await mail({
    to: email, tag: "alert-welcome", dedupeKey: `alert-welcome:${email}:${city ?? "all"}`,
    subject: `You're on the list for ABA openings${city ? "" : " in Texas"}`,
    text: `We'll email you when a clinic within ${radius} miles of ${zip} confirms it can take a new client — at most one email a week, and only for openings we've confirmed directly with the clinic.${payer ? " We'll skip clinics that have told us they don't take your insurance." : ""}

See what's open right now: ${SITE}/openings.html

— ${cfg.siteName}
Stop these alerts: ${SITE}/unsubscribe.html?e=${encodeURIComponent(email)}`,
  });
  return { outcome: `subscribed ${city ?? "statewide"}` };
};

H.unsubscribe = async (d) => {
  const email = d.email.toLowerCase();
  suppress(db, email, "unsubscribed");
  db.prepare(`UPDATE ops.alert_subscribers SET unsubscribed_at=? WHERE email=? AND unsubscribed_at IS NULL`).run(nowIso(), email);
  return { outcome: "unsubscribed" };
};

// Refunds automatically when STRIPE_API_KEY (a restricted key with Charges + Refunds +
// Subscriptions write) is in .env; otherwise the owner email says exactly what to click.
async function refund(d) {
  const key = process.env.STRIPE_API_KEY;
  if (!key) return false;
  const api = (path, method = "GET", body) => fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body,
  }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status); return j; });
  const s = await api(`checkout/sessions/${d.session}`);
  const charges = await api(`charges?customer=${s.customer}&limit=5`);
  const ch = charges.data.find((c) => c.paid && !c.refunded && c.amount === d.amount_total);
  if (ch) await api("refunds", "POST", new URLSearchParams({ charge: ch.id, reason: "requested_by_customer" }));
  if (d.subscription) await api(`subscriptions/${d.subscription}`, "DELETE");
  return !!ch;
}

H.stripe = async (d) => {
  const featured = readJson(FEATURED);

  if (d.type === "subscription_ended") {
    const gone = featured.providers.filter((f) => f._subscription === d.subscription);
    if (!gone.length) return { outcome: "no card for that subscription" };
    featured.providers = featured.providers.filter((f) => f._subscription !== d.subscription);
    writeJson(FEATURED, featured);
    await mail({
      to: OWNER, tag: "featured-ended", dedupeKey: `featured-ended:${d.subscription}`,
      subject: `Featured card removed — subscription ended`,
      text: gone.map((f) => `NPI ${f.npi} (${f.city}) is no longer featured; a ${f.city} slot is open again.`).join("\n"),
    });
    return { outcome: `unfeatured ${gone.map((f) => f.npi).join(",")}`, publish: true };
  }

  if (d.payment_status !== "paid" || (d.amount_total ?? 0) < MIN_PAID_CENTS)
    return { outcome: `ignored: ${d.payment_status}, ${d.amount_total}` };

  const o = org(d.npi);
  const taken = o ? featured.providers.filter((f) => (f.city ?? "").toLowerCase() === o.city.toLowerCase()).length : 0;
  const problem = !o ? `NPI ${d.npi} doesn't match any listing`
    : featured.providers.some((f) => f.npi === o.npi) ? "already featured"
    : o.ao_license_status !== "active" ? "the clinic's director licence isn't verified as active"
    : taken >= cfg.featuredSlotsPerCity ? `all ${cfg.featuredSlotsPerCity} ${o.city} slots are taken`
    : null;
  const head = `Business: ${d.business ?? "?"}\nEmail:    ${d.email ?? "?"}\nNPI:      ${d.npi ?? "?"}\nPaid:     $${(d.amount_total / 100).toFixed(2)}\nSession:  ${d.session}`;

  if (problem) {
    let refunded = false, refundErr = null;
    try { refunded = await refund(d); } catch (e) { refundErr = e.message; }
    await mail({
      to: OWNER, tag: "featured-flag", dedupeKey: `featured-flag:${d.session}`,
      subject: `${refunded ? "Refunded" : "✗ Refund needed"} — featured purchase: ${d.business ?? d.email}`,
      text: `${head}\n\n✗ Not published: ${problem}.\n\n${refunded
        ? "Refunded and subscription cancelled automatically."
        : `Refund per the guarantee: Stripe → Payments → find the charge → Refund, then cancel the subscription.${refundErr ? `\n(Automatic refund failed: ${refundErr})` : ""}`}`,
    });
    if (isEmail(d.email)) await mail({
      to: d.email, tag: "featured-declined", dedupeKey: `featured-declined:${d.session}`,
      subject: `Your ${cfg.siteName} featured listing`,
      text: `Thanks for signing up. We couldn't activate the featured listing: ${problem}.

As promised, you won't pay for a listing we can't stand behind — ${refunded ? "we've refunded you in full and cancelled the subscription" : "we're refunding you in full and cancelling the subscription within one business day"}.

If you think this is a mistake, reply to this email and we'll sort it out.

— ${cfg.siteName}`,
    });
    return { outcome: `flagged: ${problem}${refunded ? " (refunded)" : ""}` };
  }

  featured.providers.push({
    npi: o.npi, city: o.city,
    blurb: (d.blurb || `License-verified ABA provider in ${o.city}.`).slice(0, 140),
    website: safeUrl(d.website), phone: o.phone ?? null,
    _session: d.session, _subscription: d.subscription, _since: today(),
  });
  writeJson(FEATURED, featured);
  // The payer gets the (priority, every-14-days) availability emails. Only if we hold no address
  // yet: a verified claim contact always wins. A card payment is real accountability, but it is
  // still not proof of identity, so it never replaces one.
  if (isEmail(d.email)) db.prepare(`INSERT OR IGNORE INTO ops.clinic_contacts (site_key, email, source, confirmed_at, created_at)
                                     VALUES (?,?,'featured',?,?)`).run(o.npi, d.email.toLowerCase(), nowIso(), nowIso());
  await mail({
    to: OWNER, tag: "featured-new", dedupeKey: `featured-new:${d.session}`,
    subject: `✅ New featured clinic: ${o.name} (${o.city})`,
    text: `${head}\n\nLicence verified ✅, ${o.city} slot ${taken + 1} of ${cfg.featuredSlotsPerCity}. Published automatically — nothing to do.\n${SITE}/providers/${o.npi}.html`,
  });
  if (isEmail(d.email)) await mail({
    to: d.email, tag: "featured-live", dedupeKey: `featured-live:${d.session}`,
    subject: `${o.name} is now featured on ${cfg.siteName}`,
    text: `Thanks — your license checked out and your featured card goes live on the ${o.city} page within the hour.

Keep it working for you by telling families when you have room:

  Yes, we're accepting:  ${link(o.npi, "accepting")}
  No, we're full:        ${link(o.npi, "full")}
  Your insurance plans:  ${link(o.npi, "insurance")}

Cancel anytime from the receipt Stripe emailed you; the founding rate stays yours while you're subscribed.

— ${cfg.siteName}`,
  });
  return { outcome: `featured ${o.name}`, publish: true };
};

// ---------- publish ----------
function publish() {
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: root.pathname, stdio: "inherit" });
  run(process.execPath, ["scripts/generate.mjs"]);
  const git = (...a) => execFileSync("git", a, { cwd: root.pathname, encoding: "utf8" });
  git("add", "docs", "data/claims.json", "data/featured.json");
  if (!git("diff", "--cached", "--name-only").trim()) return "nothing to commit";
  git("commit", "-q", "-m", `Apply site updates ${nowIso().slice(0, 16)}Z (inbox)`);
  git("pull", "-q", "--rebase", "--autostash", "origin", "main");
  git("push", "-q", "origin", "HEAD:main");
  return "pushed";
}

// ---------- main ----------
const files = ((await gh(REPO_API)) ?? []).filter((f) => f.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
let publishNeeded = false;
const results = [];
for (const f of files) {
  const eventId = f.name.replace(/\.json$/, "");
  try {
    if (!db.prepare(`SELECT 1 FROM ops.inbox_applied WHERE event_id=?`).get(eventId)) {
      const file = await gh(f.url);
      const ev = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      const handler = H[ev.kind];
      const r = handler ? await handler(ev.data || {}) : { outcome: `unknown kind ${ev.kind}` };
      if (r.publish) publishNeeded = true;
      db.prepare(`INSERT INTO ops.inbox_applied (event_id, kind, outcome, applied_at) VALUES (?,?,?,?)`)
        .run(eventId, ev.kind, r.outcome, nowIso());
      results.push(`${ev.kind}: ${r.outcome}`);
    }
    await gh(`${REPO_API}/${f.name}`, { method: "DELETE", body: JSON.stringify({ message: `applied ${eventId}`, sha: f.sha }) });
  } catch (err) {
    // Leave the file for the next run; tell the owner once per event.
    results.push(`${f.name}: ERROR ${err.message}`);
    console.error(`[apply-inbox] ${f.name}:`, err);
    await mail({
      to: OWNER, tag: "inbox-error", dedupeKey: `inbox-error:${eventId}`,
      subject: `✗ ABA Openings automation error`,
      text: `An event could not be applied and will be retried every 10 minutes:\n\n${f.name}\n${err.stack ?? err.message}`,
    }).catch(() => {});
  }
}
try { results.push(...await forwardWaiting()); } catch (e) { results.push(`forwardWaiting: ERROR ${e.message}`); }
// APPLY_NO_PUBLISH=1 applies events without rebuilding or pushing (for testing).
if (publishNeeded) results.push(`publish: ${process.env.APPLY_NO_PUBLISH ? "skipped (APPLY_NO_PUBLISH)" : publish()}`);
console.log(`[${nowIso()}] apply-inbox: ${files.length} queued${results.length ? "\n  " + results.join("\n  ") : ""}`);

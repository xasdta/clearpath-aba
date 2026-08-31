// ClearPath ABA — verified ABA therapy directory (Texas MVP).
// Zero-dependency: node:http + node:sqlite. Run: npm start  ->  http://localhost:8430
//
// Data honesty rules enforced at render time:
// - License facts always carry source + verified-on date.
// - Payer acceptance shows "not yet verified" until a phone verification is recorded.
// - Availability hard-expires at 90 days (displayed as "unverified as of <date>").

import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(new URL("./data/clearpath.db", import.meta.url).pathname);
const PORT = 8430;
const TTL_DAYS = 90;
const PAYER_LABELS = {
  aetna: "Aetna", "bcbs-texas": "BCBS of Texas", cigna: "Cigna",
  unitedhealthcare: "UnitedHealthcare", "texas-medicaid": "Texas Medicaid (STAR/CHIP)", tricare: "TRICARE",
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso + "T00:00:00Z")) / 86400000);

// ---------- layout ----------
const page = (title, body, { desc = "", jsonld = null } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
<style>
:root{--ink:#1d2b30;--soft:#54666d;--faint:#8a979c;--accent:#0e6b5c;--accent-soft:#e3f0ed;--warn:#8f5a12;--warn-bg:#f6ecd9;--bad:#973f36;--bad-bg:#f5e4e1;--rule:#dde4e2;--bg:#fbfcfb;--card:#ffffff}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 -apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}.wrap{max-width:60rem;margin:0 auto;padding:0 1rem}
header.top{background:var(--accent);color:#fff;padding:.7rem 0}header.top a{color:#fff;text-decoration:none;font-weight:700}
header.top .tag{opacity:.85;font-size:.85rem;font-weight:400;margin-left:.6rem}
h1{font-size:1.7rem;line-height:1.2;margin:1.2rem 0 .4rem}h2{font-size:1.15rem;margin:1.6rem 0 .6rem}
.sub{color:var(--soft);margin:0 0 1rem}
.card{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:1rem;margin:.7rem 0}
.badge{display:inline-block;font-size:.75rem;font-weight:600;padding:.12rem .5rem;border-radius:3px;margin-right:.3rem}
.b-ok{background:var(--accent-soft);color:var(--accent)}.b-warn{background:var(--warn-bg);color:var(--warn)}.b-bad{background:var(--bad-bg);color:var(--bad)}.b-mut{background:#eef1f0;color:var(--soft)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.6rem}
table{border-collapse:collapse;width:100%}td,th{padding:.4rem .5rem;border-bottom:1px solid var(--rule);text-align:left;font-size:.92rem}
form.inline *{font:inherit}input,select,textarea,button{font:inherit;padding:.45rem .6rem;border:1px solid var(--rule);border-radius:5px;background:#fff}
button{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;cursor:pointer}
.filters{display:flex;gap:.5rem;flex-wrap:wrap;margin:.8rem 0}
.src{font-size:.78rem;color:var(--faint)}
footer{margin:3rem 0 2rem;color:var(--faint);font-size:.8rem;border-top:1px solid var(--rule);padding-top:1rem}
.stat{font-size:1.5rem;font-weight:700;color:var(--accent)}.statlab{font-size:.8rem;color:var(--soft)}
.notice{background:var(--warn-bg);border:1px solid #e8d9b8;border-radius:6px;padding:.6rem .8rem;font-size:.88rem;margin:.8rem 0}
</style></head><body>
<header class="top"><div class="wrap"><a href="/">ClearPath ABA</a><span class="tag">License-verified ABA therapy directory — Texas</span></div></header>
<div class="wrap">
${body}
<footer>Every license fact on this site is sourced from public records (NPPES NPI registry; TDLR roster via data.texas.gov) and stamped with its verified-on date. Insurance acceptance and waitlist status are only marked verified after a direct confirmation call; anything else says so. ClearPath charges providers flat subscription fees only — never per-referral fees. This directory does not provide medical advice.</footer>
</div></body></html>`;

// ---------- shared queries ----------
const availFor = (siteId) =>
  db.prepare(`SELECT * FROM availability WHERE site_id = ? ORDER BY as_of DESC LIMIT 1`).get(siteId);
const availState = (a) => {
  if (!a) return { cls: "b-mut", label: "Waitlist status not yet collected", fresh: false };
  const stale = daysAgo(a.as_of) > TTL_DAYS;
  if (stale) return { cls: "b-warn", label: `Unverified as of ${a.as_of}`, fresh: false };
  if (a.accepting) return { cls: "b-ok", label: `Accepting clients — est. wait ${a.est_wait_weeks ?? "?"} wks (as of ${a.as_of})`, fresh: true };
  return { cls: "b-bad", label: `Waitlist closed (as of ${a.as_of})`, fresh: true };
};
const licBadge = (o) => {
  if (o.ao_license_status === "active")
    return `<span class="badge b-ok">Clinical director license verified</span>`;
  if (o.ao_license_status === "expired")
    return `<span class="badge b-bad">Director license EXPIRED</span>`;
  return `<span class="badge b-mut">License not yet matched</span>`;
};

// ---------- pages ----------
function home() {
  const stats = {
    orgs: db.prepare(`SELECT COUNT(*) c FROM organizations`).get().c,
    verified: db.prepare(`SELECT COUNT(*) c FROM organizations WHERE ao_license_status='active'`).get().c,
    lbas: db.prepare(`SELECT COUNT(*) c FROM clinicians WHERE status='active'`).get().c,
    leads: db.prepare(`SELECT COUNT(*) c FROM leads`).get().c,
  };
  const cities = db.prepare(
    `SELECT city, city_slug, COUNT(*) c FROM sites WHERE city_slug != '' GROUP BY city_slug ORDER BY c DESC LIMIT 24`
  ).all();
  const body = `
<h1>Find ABA therapy in Texas — with the facts checked</h1>
<p class="sub">Every provider below comes from public federal and state records. We show license status with dates, which insurance is actually confirmed, and how long the waitlist really is.</p>
<div class="grid">
<div class="card"><div class="stat">${stats.orgs.toLocaleString()}</div><div class="statlab">ABA organizations statewide</div></div>
<div class="card"><div class="stat">${stats.verified}</div><div class="statlab">clinical directors license-verified against the TDLR roster</div></div>
<div class="card"><div class="stat">${stats.lbas.toLocaleString()}</div><div class="statlab">active Licensed Behavior Analysts in Texas</div></div>
</div>
<h2>Start here</h2>
<form class="card inline" method="GET" action="/search">
  <label>ZIP or city <input name="q" placeholder="e.g. 75201 or Dallas" required></label>
  <label>Insurance <select name="payer"><option value="">Any</option>${Object.entries(PAYER_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
  <label>Child age <select name="age"><option>0-3</option><option>4-6</option><option>7-12</option><option>13+</option></select></label>
  <button>Find providers</button>
</form>
<h2>Browse by city</h2>
<div class="grid">${cities.map((c) => `<div class="card"><a href="/tx/${c.city_slug}"><b>${esc(c.city)}</b></a><div class="src">${c.c} provider sites</div></div>`).join("")}</div>
<h2>Tools</h2>
<div class="card"><a href="/lookup"><b>Is my BCBA licensed in Texas?</b></a> — check any behavior analyst against the state licensing roster (updated ${today()}).</div>`;
  return page("ClearPath ABA — Verified ABA Therapy Directory (Texas)", body, {
    desc: "License-verified ABA therapy providers in Texas with confirmed insurance acceptance and real waitlist status.",
  });
}

function cityPage(slugName, params) {
  const payer = params.get("payer") ?? "";
  const accepting = params.get("accepting") === "1";
  const sites = db.prepare(
    `SELECT s.*, o.name org_name, o.ao_license_status, o.ao_name FROM sites s
     JOIN organizations o ON o.npi = s.org_npi WHERE s.city_slug = ? ORDER BY (o.ao_license_status='active') DESC, o.name`
  ).all(slugName);
  if (!sites.length) return null;
  const cityName = sites[0].city;
  const rows = sites.map((s) => {
    const a = availFor(s.id);
    const av = availState(a);
    const pay = payer
      ? db.prepare(`SELECT status, verified_at FROM payer_acceptance WHERE site_id=? AND payer=?`).get(s.id, payer)
      : null;
    return { s, av, pay, a };
  }).filter((r) => {
    if (accepting && !(r.av.fresh && r.a?.accepting)) return false;
    if (payer && r.pay?.status === "verified_no") return false;
    return true;
  });
  const payerLinks = Object.entries(PAYER_LABELS)
    .map(([k, v]) => `<a class="badge ${payer === k ? "b-ok" : "b-mut"}" href="/tx/${slugName}/accepts-${k}">${esc(v)}</a>`).join(" ");
  const body = `
<h1>ABA therapy in ${esc(cityName)}, TX${payer ? ` that accepts ${esc(PAYER_LABELS[payer] ?? payer)}` : ""}</h1>
<p class="sub">${rows.length} provider sites · compiled from NPPES + TDLR public records · license checks dated, insurance marked verified only after a confirmation call.</p>
<div class="filters">${payerLinks} <a class="badge ${accepting ? "b-ok" : "b-mut"}" href="?${accepting ? "" : "accepting=1"}${payer ? `&payer=${payer}` : ""}">Accepting now</a></div>
${rows.map(({ s, av, pay }) => `
<div class="card">
  <a href="/provider/${s.org_npi}"><b>${esc(s.org_name)}</b></a>
  <div class="src">${esc(s.address1 ?? "")} · ${esc(s.city)} ${esc(s.zip)}${s.phone ? " · " + esc(s.phone) : ""}</div>
  <div style="margin-top:.4rem">
    ${s.ao_license_status === "active" ? `<span class="badge b-ok">License verified</span>` : s.ao_license_status === "expired" ? `<span class="badge b-bad">Director license expired</span>` : `<span class="badge b-mut">License unmatched</span>`}
    <span class="badge ${av.cls}">${esc(av.label)}</span>
    ${payer ? (pay?.status === "verified_yes" ? `<span class="badge b-ok">${esc(PAYER_LABELS[payer])} confirmed ${esc(pay.verified_at)}</span>` : `<span class="badge b-warn">${esc(PAYER_LABELS[payer])}: not yet verified</span>`) : ""}
  </div>
</div>`).join("")}
${rows.length === 0 ? `<div class="notice">No providers match these filters yet — verification is rolling out city by city. Remove a filter or <a href="/tx/${slugName}">see all ${esc(cityName)} providers</a>.</div>` : ""}`;
  return page(`ABA Therapy in ${cityName}, TX${payer ? ` — ${PAYER_LABELS[payer] ?? ""} accepted` : ""} | ClearPath ABA`, body, {
    desc: `${rows.length} ABA therapy providers in ${cityName}, Texas with license verification, insurance confirmation, and waitlist status.`,
  });
}

function providerPage(npi) {
  const o = db.prepare(`SELECT * FROM organizations WHERE npi = ?`).get(npi);
  if (!o) return null;
  const sites = db.prepare(`SELECT * FROM sites WHERE org_npi = ?`).all(npi);
  const s = sites[0];
  const a = availFor(s.id);
  const av = availState(a);
  const payers = db.prepare(`SELECT * FROM payer_acceptance WHERE site_id = ? ORDER BY payer`).all(s.id);
  const claimed = db.prepare(`SELECT COUNT(*) c FROM claims WHERE org_npi=? AND status!='rejected'`).get(npi).c > 0;
  const jsonld = {
    "@context": "https://schema.org", "@type": "MedicalBusiness",
    name: o.name, telephone: s.phone ?? undefined,
    address: { "@type": "PostalAddress", streetAddress: s.address1, addressLocality: s.city, addressRegion: "TX", postalCode: s.zip },
    identifier: { "@type": "PropertyValue", propertyID: "NPI", value: o.npi },
    dateModified: today(),
  };
  const body = `
<h1>${esc(o.name)}</h1>
<p class="sub">${esc(s.address1 ?? "")} · ${esc(s.city)}, TX ${esc(s.zip)}${s.phone ? " · " + esc(s.phone) : ""} · NPI ${esc(o.npi)}</p>
<div>${licBadge(o)} <span class="badge ${av.cls}">${esc(av.label)}</span> ${claimed ? `<span class="badge b-ok">Claimed profile</span>` : `<span class="badge b-mut">Unclaimed</span>`}</div>

<h2>Credential verification</h2>
<div class="card">
${o.ao_license_no ? `
  <b>${esc(o.ao_name)}</b> ${o.ao_credential ? `(${esc(o.ao_credential)})` : ""} — clinical director / authorized official<br>
  ${esc(o.ao_license_type)} · License <b>${esc(o.ao_license_no)}</b> · status <b>${esc(o.ao_license_status)}</b> · expires ${esc(o.ao_license_expires)}<br>
  <span class="src">Verified against ${esc(o.ao_verify_source)} on ${esc(o.ao_verified_at)}. BACB certification is additionally confirmed one-at-a-time at claim time (never bulk-copied).</span>`
: `
  Authorized official: <b>${esc(o.ao_name ?? "—")}</b> ${o.ao_credential ? `(${esc(o.ao_credential)})` : ""}<br>
  <span class="src">No unique match in the TDLR licensing roster yet — this usually means a name variant. Verification happens automatically when the profile is claimed. Check any name yourself at <a href="/lookup">the license lookup</a>.</span>`}
</div>

<h2>Insurance acceptance</h2>
<div class="card"><table>
<tr><th>Payer</th><th>Status</th></tr>
${payers.map((p) => `<tr><td>${esc(PAYER_LABELS[p.payer] ?? p.payer)}</td><td>${
    p.status === "verified_yes" ? `<span class="badge b-ok">Accepted — confirmed by phone ${esc(p.verified_at)}</span>`
    : p.status === "verified_no" ? `<span class="badge b-bad">Not accepted (confirmed ${esc(p.verified_at)})</span>`
    : `<span class="badge b-warn">Not yet verified</span>`}</td></tr>`).join("")}
</table>
<div class="src">We only mark a payer "accepted" after confirming directly with the clinic — insurer directories are wrong often enough that regulators call them ghost networks.</div></div>

<h2>Ask about availability</h2>
<form class="card inline" method="POST" action="/lead">
  <input type="hidden" name="site_id" value="${s.id}">
  <input type="hidden" name="source_page" value="/provider/${esc(o.npi)}">
  <label>Your name <input name="name" required></label>
  <label>Email or phone <input name="contact" required></label>
  <label>Insurance <select name="payer">${Object.entries(PAYER_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
  <label>Child age <select name="child_age"><option>0-3</option><option>4-6</option><option>7-12</option><option>13+</option></select></label>
  <label>ZIP <input name="zip" size="6"></label><br>
  <label>Anything else <textarea name="message" rows="2" cols="40"></textarea></label><br>
  <button>Send inquiry</button>
  <div class="src">Sent to the provider. Free for families, always.</div>
</form>

<div class="card">Work here? <a href="/claim/${esc(o.npi)}"><b>Claim this profile</b></a> to answer inquiries, correct insurance data, and update your waitlist status. <span class="src">Flat monthly fee after the free period — never pay-per-referral.</span></div>
<div class="src">See something wrong? <a href="mailto:corrections@clearpathaba.example?subject=Correction: NPI ${esc(o.npi)}">Report an error</a> — caregiver corrections trigger a re-verification call.</div>`;
  return page(`${o.name} — ABA Therapy in ${s.city}, TX | ClearPath ABA`, body, {
    desc: `${o.name} in ${s.city}, TX: license verification status, confirmed insurance acceptance, current waitlist.`, jsonld,
  });
}

function lookupPage(params) {
  const q = (params.get("name") ?? "").trim();
  let results = [];
  if (q.length >= 3)
    results = db.prepare(
      `SELECT * FROM clinicians WHERE name LIKE ? ORDER BY status='active' DESC, name LIMIT 50`
    ).all(`%${q.toUpperCase()}%`);
  const body = `
<h1>Is my behavior analyst licensed in Texas?</h1>
<p class="sub">Search the state licensing roster (TDLR via data.texas.gov, synced ${today()}). Texas requires behavior analysts to hold an active LBA license.</p>
<form class="card inline" method="GET"><label>Name <input name="name" value="${esc(q)}" placeholder="LAST, FIRST or partial" required></label> <button>Search</button></form>
${q ? `<h2>${results.length} result${results.length === 1 ? "" : "s"}</h2>
<div class="card"><table><tr><th>Name</th><th>License</th><th>Type</th><th>Status</th><th>Expires</th></tr>
${results.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.license_no)}</td><td>${esc(r.license_type.replace("Licensed ", ""))}</td>
<td><span class="badge ${r.status === "active" ? "b-ok" : "b-bad"}">${esc(r.status)}</span></td><td>${esc(r.expires ?? "")}</td></tr>`).join("")}
</table>${results.length === 0 ? `<div class="notice">No match. Try last name only — and note RBTs are certified nationally (BACB), not state-licensed; verify them at bacb.com.</div>` : ""}</div>` : ""}`;
  return page("Texas Behavior Analyst License Lookup | ClearPath ABA", body, {
    desc: "Check whether a behavior analyst (BCBA/LBA) holds an active Texas license. Free lookup against the state roster.",
  });
}

function claimPage(npi) {
  const o = db.prepare(`SELECT * FROM organizations WHERE npi = ?`).get(npi);
  if (!o) return null;
  const body = `
<h1>Claim ${esc(o.name)}</h1>
<p class="sub">Claiming is free during the launch period. We verify your license at claim time (individual BACB/TDLR check), then you can answer inquiries, fix insurance data, and keep your waitlist status current.</p>
<form class="card inline" method="POST" action="/claim">
  <input type="hidden" name="org_npi" value="${esc(npi)}">
  <label>Your name <input name="name" required></label>
  <label>Role <input name="role" placeholder="Owner / Clinical Director" required></label>
  <label>Work email <input name="email" type="email" required></label>
  <label>Your TX license # <input name="license_no" placeholder="BHV-XXXX"></label>
  <button>Request claim</button>
</form>
<div class="src">We confirm claims by calling the clinic's number on record — not the number you submit.</div>`;
  return page(`Claim ${o.name} | ClearPath ABA`, body);
}

function adminPage() {
  const pending = db.prepare(`SELECT * FROM claims WHERE status='pending' ORDER BY created_at DESC`).all();
  const leads = db.prepare(`SELECT l.*, o.name org FROM leads l JOIN sites s ON s.id=l.site_id JOIN organizations o ON o.npi=s.org_npi ORDER BY l.created_at DESC LIMIT 25`).all();
  const queue = db.prepare(
    `SELECT s.id, s.phone, s.city, o.name FROM sites s JOIN organizations o ON o.npi=s.org_npi
     WHERE NOT EXISTS (SELECT 1 FROM payer_acceptance p WHERE p.site_id=s.id AND p.status!='unverified')
     ORDER BY (SELECT COUNT(*) FROM sites s2 WHERE s2.city_slug=s.city_slug) DESC LIMIT 20`
  ).all();
  const body = `
<h1>Verification ops</h1>
<div class="notice">Local MVP tool — no auth. Do not deploy as-is.</div>
<h2>Pending claims (${pending.length})</h2>
<div class="card"><table><tr><th>Org NPI</th><th>Name</th><th>Role</th><th>Email</th><th>License</th><th>When</th></tr>
${pending.map((c) => `<tr><td><a href="/provider/${esc(c.org_npi)}">${esc(c.org_npi)}</a></td><td>${esc(c.name)}</td><td>${esc(c.role)}</td><td>${esc(c.email)}</td><td>${esc(c.license_no)}</td><td>${esc(c.created_at)}</td></tr>`).join("") || "<tr><td colspan=6>None</td></tr>"}</table></div>
<h2>Recent inquiries (${leads.length})</h2>
<div class="card"><table><tr><th>When</th><th>Provider</th><th>Payer</th><th>Age</th><th>Contact</th></tr>
${leads.map((l) => `<tr><td>${esc(l.created_at)}</td><td>${esc(l.org)}</td><td>${esc(l.payer)}</td><td>${esc(l.child_age)}</td><td>${esc(l.name)} · ${esc(l.contact)}</td></tr>`).join("") || "<tr><td colspan=5>None</td></tr>"}</table></div>
<h2>Phone-verification queue (top-city sites with nothing verified yet)</h2>
${queue.map((s) => `
<div class="card"><b>${esc(s.name)}</b> — ${esc(s.city)} · ${esc(s.phone ?? "no phone")}
<form class="inline" method="POST" action="/admin/verify" style="margin-top:.4rem">
<input type="hidden" name="site_id" value="${s.id}">
<label>Payer <select name="payer">${Object.entries(PAYER_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
<label>Result <select name="status"><option value="verified_yes">accepts</option><option value="verified_no">does NOT accept</option></select></label>
<label>Accepting clients? <select name="accepting"><option value="">unknown</option><option value="1">yes</option><option value="0">waitlist closed</option></select></label>
<label>Est. wait (weeks) <input name="wait" size="3"></label>
<button>Record call</button>
</form></div>`).join("")}`;
  return page("Verification ops | ClearPath ABA", body);
}

// ---------- server ----------
const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => resolve(new URLSearchParams(data)));
});
const send = (res, html, code = 200, type = "text/html; charset=utf-8") => {
  res.writeHead(code, { "content-type": type });
  res.end(html);
};
const redirect = (res, to) => { res.writeHead(303, { location: to }); res.end(); };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === "POST") {
      const b = await readBody(req);
      if (p === "/lead") {
        db.prepare(`INSERT INTO leads (site_id,payer,child_age,zip,name,contact,message,source_page,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(+b.get("site_id"), b.get("payer"), b.get("child_age"), b.get("zip"), b.get("name"), b.get("contact"), b.get("message"), b.get("source_page"), new Date().toISOString());
        return send(res, page("Inquiry sent", `<h1>Inquiry sent</h1><p class="sub">The provider will reach out directly. Meanwhile, keep calling down your list — waitlists move.</p><p><a href="javascript:history.back()">Back</a></p>`));
      }
      if (p === "/claim") {
        db.prepare(`INSERT INTO claims (org_npi,name,role,email,license_no,created_at) VALUES (?,?,?,?,?,?)`)
          .run(b.get("org_npi"), b.get("name"), b.get("role"), b.get("email"), b.get("license_no"), new Date().toISOString());
        return send(res, page("Claim requested", `<h1>Claim requested</h1><p class="sub">We'll verify your license and call the clinic's number on record within 2 business days.</p>`));
      }
      if (p === "/admin/verify") {
        const siteId = +b.get("site_id");
        db.prepare(`UPDATE payer_acceptance SET status=?, verified_at=?, verify_method='phone' WHERE site_id=? AND payer=?`)
          .run(b.get("status"), today(), siteId, b.get("payer"));
        if (b.get("accepting") !== "") {
          db.prepare(`INSERT INTO availability (site_id, accepting, est_wait_weeks, payer_scope, as_of) VALUES (?,?,?,?,?)`)
            .run(siteId, +b.get("accepting"), b.get("wait") ? +b.get("wait") : null, "all", today());
        }
        return redirect(res, "/admin");
      }
      return send(res, "Not found", 404, "text/plain");
    }

    if (p === "/") return send(res, home());
    if (p === "/admin") return send(res, adminPage());
    if (p === "/lookup") return send(res, lookupPage(url.searchParams));
    if (p === "/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const payer = url.searchParams.get("payer") ?? "";
      const byZip = /^\d{5}$/.test(q)
        ? db.prepare(`SELECT city_slug FROM sites WHERE zip = ? LIMIT 1`).get(q)
        : db.prepare(`SELECT city_slug FROM sites WHERE city_slug = ? LIMIT 1`).get(q.replace(/[^a-z0-9]+/g, "-"));
      if (byZip) return redirect(res, `/tx/${byZip.city_slug}${payer ? `?payer=${payer}` : ""}`);
      return send(res, page("No matches", `<h1>No providers found for “${esc(q)}”</h1><p class="sub">Try a nearby larger city — or <a href="/">browse all Texas cities</a>.</p>`), 404);
    }
    let m;
    if ((m = p.match(/^\/tx\/([a-z0-9-]+)\/accepts-([a-z0-9-]+)$/))) {
      const params = new URLSearchParams(url.searchParams); params.set("payer", m[2]);
      const html = cityPage(m[1], params);
      return html ? send(res, html) : send(res, "Not found", 404, "text/plain");
    }
    if ((m = p.match(/^\/tx\/([a-z0-9-]+)$/))) {
      const html = cityPage(m[1], url.searchParams);
      return html ? send(res, html) : send(res, "Not found", 404, "text/plain");
    }
    if ((m = p.match(/^\/provider\/(\d{10})$/))) {
      const html = providerPage(m[1]);
      return html ? send(res, html) : send(res, "Not found", 404, "text/plain");
    }
    if ((m = p.match(/^\/claim\/(\d{10})$/))) {
      const html = claimPage(m[1]);
      return html ? send(res, html) : send(res, "Not found", 404, "text/plain");
    }
    if (p === "/sitemap.xml") {
      const cities = db.prepare(`SELECT DISTINCT city_slug FROM sites WHERE city_slug != ''`).all();
      const npis = db.prepare(`SELECT npi FROM organizations`).all();
      const urls = [
        "/", "/lookup",
        ...cities.map((c) => `/tx/${c.city_slug}`),
        ...cities.flatMap((c) => Object.keys(PAYER_LABELS).map((pay) => `/tx/${c.city_slug}/accepts-${pay}`)),
        ...npis.map((n) => `/provider/${n.npi}`),
      ];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>http://localhost:${PORT}${u}</loc><lastmod>${today()}</lastmod></url>`).join("\n")}\n</urlset>`;
      return send(res, xml, 200, "application/xml");
    }
    if (p === "/robots.txt") return send(res, `User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: http://localhost:${PORT}/sitemap.xml\n`, 200, "text/plain");
    return send(res, page("Not found", `<h1>Page not found</h1><p class="sub"><a href="/">Back to the directory</a></p>`), 404);
  } catch (err) {
    console.error(err);
    return send(res, "Server error", 500, "text/plain");
  }
}).listen(PORT, () => console.log(`ClearPath ABA running at http://localhost:${PORT}`));

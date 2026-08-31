// Static site generator for ClearPath ABA -> docs/ (Vercel serves this directory).
// Reads data/clearpath.db (built by etl.mjs) plus featured.json / claims.json / site.config.json.
//
// PUBLISHING RULE (important, enforced below):
// We publish POSITIVE license verification only. A provider whose authorized official
// uniquely matches an ACTIVE TDLR license gets a dated "verified" badge. Everything else
// renders as "not confirmed" — we never publicly assert that a named business's license is
// expired or invalid on the strength of a heuristic name match.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);
const OUT = new URL("docs/", root);
const cfg = JSON.parse(readFileSync(new URL("site.config.json", root)));
const featured = JSON.parse(readFileSync(new URL("data/featured.json", root))).providers ?? [];
const claims = JSON.parse(readFileSync(new URL("data/claims.json", root))).providers ?? [];
const db = new DatabaseSync(new URL("data/clearpath.db", root).pathname);

const today = new Date().toISOString().slice(0, 10);
const claimBy = new Map(claims.map((c) => [c.npi, c]));
const featuredByCity = new Map();
for (const f of featured) {
  const k = (f.city ?? "").toLowerCase();
  if (!featuredByCity.has(k)) featuredByCity.set(k, []);
  featuredByCity.get(k).push(f);
}

const PAYERS = {
  aetna: "Aetna", "bcbs-texas": "BCBS of Texas", cigna: "Cigna",
  unitedhealthcare: "UnitedHealthcare", "texas-medicaid": "Texas Medicaid (STAR/CHIP)", tricare: "TRICARE",
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const base = cfg.domain ? `https://${cfg.domain}` : "";
const MIN_SITES_FOR_PAYER_PAGE = 4; // avoid thin programmatic pages

// ---------- data ----------
const orgs = db.prepare(`
  SELECT o.*, s.id site_id, s.address1, s.city, s.city_slug, s.zip, s.phone
  FROM organizations o JOIN sites s ON s.org_npi = o.npi ORDER BY o.name`).all();
const cities = db.prepare(`
  SELECT city, city_slug, COUNT(*) n FROM sites WHERE city_slug != ''
  GROUP BY city_slug ORDER BY n DESC`).all();
const licenses = db.prepare(`SELECT name, license_no, license_type, status, expires FROM clinicians ORDER BY name`).all();
const activeLicenses = licenses.filter((l) => l.status === "active");
const verifiedOrgs = orgs.filter((o) => o.ao_license_status === "active");
const availByS = new Map();
for (const a of db.prepare(`SELECT * FROM availability ORDER BY as_of DESC`).all())
  if (!availByS.has(a.site_id)) availByS.set(a.site_id, a);
const payersBySite = new Map();
for (const p of db.prepare(`SELECT * FROM payer_acceptance`).all()) {
  if (!payersBySite.has(p.site_id)) payersBySite.set(p.site_id, []);
  payersBySite.get(p.site_id).push(p);
}

const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso + "T00:00:00Z")) / 86400000);
function availState(siteId) {
  const a = availByS.get(siteId);
  if (!a) return { cls: "mut", label: "Waitlist status not yet collected", fresh: false, accepting: false };
  if (daysAgo(a.as_of) > 90) return { cls: "warn", label: `Waitlist unverified since ${a.as_of}`, fresh: false, accepting: false };
  if (a.accepting) return { cls: "ok", label: `Accepting clients${a.est_wait_weeks != null ? ` — about ${a.est_wait_weeks} week wait` : ""} (confirmed ${a.as_of})`, fresh: true, accepting: true };
  return { cls: "bad", label: `Waitlist closed (confirmed ${a.as_of})`, fresh: true, accepting: false };
}
// POSITIVE-ONLY license rendering (see header rule)
function licBadge(o) {
  return o.ao_license_status === "active"
    ? `<span class="badge ok" title="Matched to an active Texas license on ${esc(o.ao_verified_at)}">License verified</span>`
    : `<span class="badge mut">License not confirmed</span>`;
}
const payerStatus = (siteId, payer) => (payersBySite.get(siteId) ?? []).find((p) => p.payer === payer);

// ---------- layout ----------
function layout(title, body, { desc = "", canonical = "", jsonld = null, depth = 0 } = {}) {
  const up = "../".repeat(depth) || "./";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${base && canonical ? `<link rel="canonical" href="${base}${canonical}">` : ""}
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<link rel="stylesheet" href="${up}style.css?v=3">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><text y=%2226%22 font-size=%2228%22>%E2%9C%93</text></svg>">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
${cfg.vercelAnalytics ? `<script defer src="/_vercel/insights/script.js"></script>` : ""}
</head><body>
<header class="top"><div class="wrap">
  <a class="brand" href="${up}index.html">ClearPath<span>ABA</span></a>
  <nav><a href="${up}texas-aba-access-report.html">Access report</a><a href="${up}lookup.html">License lookup</a><a href="${up}methodology.html">Methodology</a><a class="cta" href="${up}for-clinics.html">For clinics</a></nav>
</div></header>
<main class="wrap">${body}</main>
<footer class="wrap">
  <p><b>How we verify.</b> Provider records come from the federal NPI registry; license status is matched against the Texas TDLR roster published on data.texas.gov and stamped with the date we checked it. Insurance acceptance and waitlist status are marked verified only after we confirm them directly with the clinic — anything unconfirmed says so. We publish license verification only when we can positively match an active license; we never assert that a clinic's license is invalid.</p>
  <p><b>How we make money.</b> Clinics may buy a flat monthly featured listing. Placement in the regular directory is never for sale, and we never take a fee per referral or per enrolled client.</p>
  <p class="fine">ClearPath ABA is an independent directory. It is not medical advice and does not endorse any provider. Data last built ${today}. Corrections: <a href="mailto:${esc(cfg.correctionsEmail)}">${esc(cfg.correctionsEmail)}</a></p>
</footer>
</body></html>`;
}

// form action helper (Web3Forms when configured, mailto fallback so nothing is ever broken)
function formOpen(subject, redirectDepth = 0) {
  const up = "../".repeat(redirectDepth) || "./";
  return cfg.web3formsKey
    ? `<form class="card form" action="https://api.web3forms.com/submit" method="POST">
       <input type="hidden" name="access_key" value="${esc(cfg.web3formsKey)}">
       <input type="hidden" name="subject" value="${esc(subject)}">
       <input type="hidden" name="redirect" value="${base ? base + "/thanks.html" : up + "thanks.html"}">
       <input type="checkbox" name="botcheck" class="hidden" style="display:none">`
    : `<form class="card form" action="mailto:${esc(cfg.contactEmail)}" method="POST" enctype="text/plain">
       <input type="hidden" name="subject" value="${esc(subject)}">`;
}

// ---------- pages ----------
function homePage() {
  const topCities = cities.slice(0, 18);
  const jsonld = {
    "@context": "https://schema.org", "@type": "WebSite", name: cfg.siteName,
    url: base || undefined, description: cfg.tagline,
  };
  const body = `
<h1>ABA therapy in Texas, with the credentials actually checked</h1>
<p class="lede">Most autism-therapy directories list whoever signs up. We start from public records — every provider in the federal registry — then verify licenses against the state roster and confirm insurance and waitlists by phone. When something isn't verified yet, we say so.</p>

<div class="stats">
  <div><b>${orgs.length.toLocaleString()}</b><span>ABA organizations statewide</span></div>
  <div><b>${verifiedOrgs.length}</b><span>with a license-verified clinical director</span></div>
  <div><b>${activeLicenses.length.toLocaleString()}</b><span>active Texas behavior analysts</span></div>
  <div><b>${cities.length}</b><span>cities covered</span></div>
</div>

<section class="card highlight">
  <h2>Find providers near you</h2>
  <form class="finder" action="#" onsubmit="return cpGo(event)">
    <label>City<select id="cpCity">${cities.slice(0, 60).map((c) => `<option value="${c.city_slug}">${esc(c.city)} (${c.n})</option>`).join("")}</select></label>
    <label>Insurance<select id="cpPayer"><option value="">Any</option>${Object.entries(PAYERS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
    <button>Search</button>
  </form>
  <script>function cpGo(e){e.preventDefault();var c=document.getElementById('cpCity').value,p=document.getElementById('cpPayer').value;location.href='tx/'+c+(p?'/accepts-'+p+'.html':'/index.html');return false}</script>
</section>

<h2>Browse by city</h2>
<div class="grid">${topCities.map((c) => `<a class="card tile" href="tx/${c.city_slug}/index.html"><b>${esc(c.city)}</b><span>${c.n} provider${c.n === 1 ? "" : "s"}</span></a>`).join("")}</div>

<h2>Two things no other ABA directory shows you</h2>
<div class="grid two">
  <div class="card"><h3>Whether the license is real and current</h3><p>Texas requires behavior analysts to hold an active LBA license. We match each organization's clinical director against the state roster and show the license number, type, and the date we checked. <a href="lookup.html">Look up any behavior analyst →</a></p></div>
  <div class="card"><h3>Whether they can actually take your child</h3><p>Roughly three in four families end up on a waitlist, averaging months. We ask clinics directly and stamp the answer with a date — and let it visibly expire after 90 days rather than quietly going stale.</p></div>
</div>

<div class="card cta-band">
  <div><b>New report:</b> where Texas families can actually get ABA — provider density, verification rates, and access gaps across 20 metros.</div>
  <a class="btn" href="texas-aba-access-report.html">Read the access report</a>
</div>`;
  return layout(`ClearPath ABA — License-Verified ABA Therapy Directory (Texas)`, body, {
    desc: `${orgs.length.toLocaleString()} Texas ABA therapy providers with license verification, confirmed insurance acceptance, and real waitlist status.`,
    canonical: "/", jsonld,
  });
}

function cityPage(c, payer = null) {
  const sites = orgs.filter((o) => o.city_slug === c.city_slug);
  const feats = (featuredByCity.get(c.city.toLowerCase()) ?? []).slice(0, cfg.featuredSlotsPerCity);
  const ranked = [...sites].sort((a, b) => {
    const av = (o) => (o.ao_license_status === "active" ? 1 : 0);
    const acc = (o) => (availState(o.site_id).accepting ? 1 : 0);
    return acc(b) - acc(a) || av(b) - av(a) || a.name.localeCompare(b.name);
  }).filter((o) => (payer ? payerStatus(o.site_id, payer)?.status !== "verified_no" : true));

  const title = payer
    ? `ABA therapy in ${c.city}, TX that accepts ${PAYERS[payer]}`
    : `ABA therapy providers in ${c.city}, Texas`;
  const body = `
<nav class="crumbs"><a href="../../index.html">Home</a> › ${payer ? `<a href="index.html">${esc(c.city)}</a> › ${esc(PAYERS[payer])}` : esc(c.city)}</nav>
<h1>${esc(title)}</h1>
<p class="lede">${ranked.length} provider${ranked.length === 1 ? "" : "s"} compiled from public records. ${payer ? `Insurance acceptance is confirmed by phone before we show it as accepted — insurer directories are wrong often enough that regulators call them ghost networks.` : `Sorted by confirmed availability, then verified license.`}</p>

${payer ? "" : `<div class="chips">${Object.entries(PAYERS).map(([k, v]) => `<a class="chip" href="accepts-${k}.html">Accepts ${esc(v)}</a>`).join("")}</div>`}

${feats.length ? `<h2 class="fh">Featured providers</h2>
<div class="grid">${feats.map((f) => {
    const o = orgs.find((x) => x.npi === f.npi);
    return o ? `<div class="card feat"><span class="badge feat-b">Featured</span><a href="../../providers/${o.npi}.html"><b>${esc(o.name)}</b></a>
      <p>${esc(f.blurb ?? "")}</p><div class="src">${esc(o.city)}${f.phone ? " · " + esc(f.phone) : ""}</div></div>` : "";
  }).join("")}</div>` : ""}

<h2>All providers${payer ? ` accepting ${esc(PAYERS[payer])}` : ""}</h2>
${ranked.map((o) => {
    const av = availState(o.site_id);
    const p = payer ? payerStatus(o.site_id, payer) : null;
    const claim = claimBy.get(o.npi);
    return `<div class="card row">
  <div class="row-main">
    <a href="../../providers/${o.npi}.html"><b>${esc(o.name)}</b></a>
    <div class="src">${esc(o.address1 ?? "")} · ${esc(o.city)}, TX ${esc(o.zip ?? "")}${o.phone ? ` · ${esc(o.phone)}` : ""}</div>
    <div class="badges">${licBadge(o)}<span class="badge ${av.cls}">${esc(av.label)}</span>${claim ? `<span class="badge ok">Claimed</span>` : ""}${
      payer ? (p?.status === "verified_yes"
        ? `<span class="badge ok">${esc(PAYERS[payer])} confirmed ${esc(p.verified_at)}</span>`
        : `<span class="badge warn">${esc(PAYERS[payer])} not yet verified</span>`) : ""}</div>
  </div>
</div>`;
  }).join("")}

${ranked.length === 0 ? `<div class="notice">No providers listed here yet.</div>` : ""}
<div class="card cta-band"><div>Run a clinic in ${esc(c.city)}? Claim your profile free — correct your insurance list and keep your waitlist current.</div><a class="btn" href="../../for-clinics.html">Claim your listing</a></div>`;

  return layout(`${title} | ClearPath ABA`, body, {
    desc: `${ranked.length} ABA therapy providers in ${c.city}, TX${payer ? ` accepting ${PAYERS[payer]}` : ""} — license-verified, with confirmed insurance and waitlist status.`,
    canonical: `/tx/${c.city_slug}/${payer ? `accepts-${payer}.html` : ""}`, depth: 2,
  });
}

function providerPage(o) {
  const av = availState(o.site_id);
  const claim = claimBy.get(o.npi);
  const pays = payersBySite.get(o.site_id) ?? [];
  const jsonld = {
    "@context": "https://schema.org", "@type": "MedicalBusiness",
    name: o.name, telephone: claim?.phone ?? o.phone ?? undefined, url: claim?.website ?? undefined,
    address: { "@type": "PostalAddress", streetAddress: o.address1, addressLocality: o.city, addressRegion: "TX", postalCode: o.zip, addressCountry: "US" },
    identifier: { "@type": "PropertyValue", propertyID: "US NPI", value: o.npi },
    medicalSpecialty: "Applied Behavior Analysis", dateModified: today,
  };
  const body = `
<nav class="crumbs"><a href="../index.html">Home</a> › <a href="../tx/${o.city_slug}/index.html">${esc(o.city)}</a> › ${esc(o.name)}</nav>
<h1>${esc(o.name)}</h1>
<p class="lede">${esc(o.address1 ?? "")} · ${esc(o.city)}, TX ${esc(o.zip ?? "")}${(claim?.phone ?? o.phone) ? ` · ${esc(claim?.phone ?? o.phone)}` : ""}</p>
<div class="badges big">${licBadge(o)}<span class="badge ${av.cls}">${esc(av.label)}</span>${claim ? `<span class="badge ok">Claimed profile</span>` : `<span class="badge mut">Unclaimed</span>`}</div>

${claim ? `<div class="card claimed"><h2>From the provider</h2>
  ${claim.website ? `<p><a href="${esc(claim.website)}" rel="nofollow">${esc(claim.website)}</a></p>` : ""}
  ${claim.service_area ? `<p><b>Service area:</b> ${esc(claim.service_area)}</p>` : ""}
  ${claim.ages_served ? `<p><b>Ages served:</b> ${esc(claim.ages_served)}</p>` : ""}
  <div class="src">Claimed and identity-verified ${esc(claim.claimed_date)}. Claiming is free and does not affect ranking.</div></div>` : ""}

<h2>Credential verification</h2>
<div class="card">
${o.ao_license_status === "active" ? `
  <p><b>${esc(o.ao_name)}</b>${o.ao_credential ? ` (${esc(o.ao_credential)})` : ""} — authorized official on the federal NPI record.</p>
  <table><tr><th>License</th><td>${esc(o.ao_license_no)}</td></tr>
  <tr><th>Type</th><td>${esc(o.ao_license_type)}</td></tr>
  <tr><th>Status</th><td><span class="badge ok">Active</span></td></tr>
  <tr><th>Expires</th><td>${esc(o.ao_license_expires)}</td></tr></table>
  <div class="src">Matched against the Texas TDLR licensing roster (data.texas.gov dataset 7358-krk7) on ${esc(o.ao_verified_at)}. BACB certification is checked individually at claim time; we never republish the BACB registry.</div>`
: `
  <p>Authorized official on the federal NPI record: <b>${esc(o.ao_name ?? "not listed")}</b>${o.ao_credential ? ` (${esc(o.ao_credential)})` : ""}.</p>
  <p><b>We have not confirmed an active Texas license for this name.</b> That most often means a name variant, a married/maiden name, or a clinical director different from the administrative contact — not that anyone is unlicensed. We publish verification only when we can positively match it.</p>
  <div class="src">You can check any name yourself in the <a href="../lookup.html">state license lookup</a>. Provider: <a href="../for-clinics.html">claim this profile</a> to get verified.</div>`}
</div>

<h2>Insurance</h2>
<div class="card"><table>
<tr><th>Plan</th><th>Status</th></tr>
${pays.map((p) => `<tr><td>${esc(PAYERS[p.payer] ?? p.payer)}</td><td>${
    p.status === "verified_yes" ? `<span class="badge ok">Accepted — confirmed with the clinic ${esc(p.verified_at)}</span>`
    : p.status === "verified_no" ? `<span class="badge bad">Not accepted (confirmed ${esc(p.verified_at)})</span>`
    : `<span class="badge warn">Not yet verified</span>`}</td></tr>`).join("")}
</table>
<div class="src">We mark a plan accepted only after confirming it with the clinic directly. Always re-confirm coverage before your first appointment — plan networks change.</div></div>

<h2>Ask this provider about availability</h2>
${formOpen(`ClearPath inquiry — ${o.name}`, 1)}
  <input type="hidden" name="provider" value="${esc(o.name)} (NPI ${esc(o.npi)})">
  <div class="f2"><label>Your name<input name="name" required></label><label>Email or phone<input name="contact" required></label></div>
  <div class="f2"><label>Insurance<select name="insurance">${Object.values(PAYERS).map((v) => `<option>${esc(v)}</option>`).join("")}<option>Other / self-pay</option></select></label>
  <label>Child's age<select name="child_age"><option>0-3</option><option>4-6</option><option>7-12</option><option>13+</option></select></label></div>
  <label>Anything else<textarea name="message" rows="3"></textarea></label>
  <button>Send inquiry</button>
  <div class="src">Free for families. We pass your message to the provider${cfg.web3formsKey ? "" : " by email"} — we never sell family contact information.</div>
</form>

<div class="card cta-band"><div>Is this your clinic? Claim the profile free to fix your insurance list, add your waitlist, and answer inquiries.</div><a class="btn" href="../for-clinics.html">Claim this profile</a></div>
<p class="src">Something wrong here? <a href="mailto:${esc(cfg.correctionsEmail)}?subject=Correction%20for%20NPI%20${esc(o.npi)}">Report a correction</a> — we re-verify by phone and update the date stamp.</p>`;

  return layout(`${o.name} — ABA Therapy in ${o.city}, TX | ClearPath ABA`, body, {
    desc: `${o.name} in ${o.city}, Texas: license verification, insurance acceptance, and current waitlist status for ABA therapy.`,
    canonical: `/providers/${o.npi}.html`, jsonld, depth: 1,
  });
}

function lookupPage() {
  const body = `
<h1>Is my behavior analyst licensed in Texas?</h1>
<p class="lede">Texas requires behavior analysts to hold an active LBA (or assistant LBA) license through TDLR. Search the state roster below — ${activeLicenses.length.toLocaleString()} active licenses, synced ${today}.</p>
<div class="card">
  <label class="wide">Search by name<input id="q" placeholder="Last name, or last, first" autocomplete="off"></label>
  <div id="out" class="lookup-out"><p class="src">Type at least three letters.</p></div>
</div>
<div class="card"><h2>What this does and doesn't tell you</h2>
<ul><li><b>An active license</b> means the state currently authorizes this person to practice behavior analysis in Texas.</li>
<li><b>No match</b> usually means a name variant or an out-of-state license — not necessarily a problem. Ask the provider directly.</li>
<li><b>RBTs</b> (registered behavior technicians) are certified nationally by the BACB, not licensed by Texas. Verify those at bacb.com.</li>
<li>This roster does not include disciplinary detail. TDLR publishes enforcement actions separately.</li></ul></div>
<script>
let DATA=null;const q=document.getElementById('q'),out=document.getElementById('out');
async function load(){if(!DATA){const r=await fetch('licenses.json');DATA=await r.json()}return DATA}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
let t;q.addEventListener('input',()=>{clearTimeout(t);t=setTimeout(run,150)});
async function run(){const v=q.value.trim().toUpperCase();
 if(v.length<3){out.innerHTML='<p class="src">Type at least three letters.</p>';return}
 const d=await load();const hits=d.filter(r=>r[0].includes(v)).slice(0,60);
 out.innerHTML=hits.length?'<table><tr><th>Name</th><th>License</th><th>Type</th><th>Status</th><th>Expires</th></tr>'+
 hits.map(r=>'<tr><td>'+esc(r[0])+'</td><td>'+esc(r[1])+'</td><td>'+(r[2]==='A'?'Assistant LBA':'LBA')+'</td><td><span class="badge '+(r[3]==='a'?'ok">Active':'bad">Not active')+'</span></td><td>'+esc(r[4]||'')+'</td></tr>').join('')+'</table>'
 :'<p class="src">No match in the Texas roster. Try last name only, or check national BACB certification at bacb.com.</p>'}
</script>`;
  return layout("Texas Behavior Analyst License Lookup (LBA/BCBA) | ClearPath ABA", body, {
    desc: "Free lookup: check whether a behavior analyst holds an active Texas LBA license, straight from the state roster.",
    canonical: "/lookup.html",
  });
}

function forClinicsPage() {
  const payBlock = cfg.stripeFeaturedLink
    ? `<a class="btn big" href="${esc(cfg.stripeFeaturedLink)}">Reserve a founding slot — $${cfg.featuredPriceMonthly}/mo</a>`
    : `<a class="btn big" href="mailto:${esc(cfg.contactEmail)}?subject=Founding%20featured%20slot">Email us to reserve a founding slot</a>`;
  const body = `
<h1>For ABA clinics</h1>
<p class="lede">Families comparing a multi-year, ${"$"}50,000-plus-a-year therapy decision are reading these pages. Make sure yours is accurate — and if you have open capacity, get in front of the families who can actually start.</p>

<div class="grid two">
<div class="card"><h2>Free, always</h2>
<ul><li>Your listing is already here — compiled from public records, not pay-to-play.</li>
<li>Claim it to correct your insurance list, add your website and intake contact, and publish your current waitlist.</li>
<li>Get license-verified: we match your director to the TDLR roster and date-stamp it.</li>
<li>Receive family inquiries at no charge.</li></ul>
<p><b>Claiming never affects your ranking.</b> We sort by confirmed availability and verified credentials — never by who pays.</p>
${formOpen("ClearPath claim request")}
  <div class="f2"><label>Clinic name<input name="clinic" required></label><label>Your name<input name="name" required></label></div>
  <div class="f2"><label>Role<input name="role" placeholder="Owner / Clinical Director" required></label><label>Work email<input name="email" type="email" required></label></div>
  <div class="f2"><label>NPI or city<input name="npi" placeholder="10-digit NPI"></label><label>TX license #<input name="license" placeholder="BHV-XXXX"></label></div>
  <button>Claim our listing (free)</button>
  <div class="src">We verify by matching your license and calling the clinic number on public record — not the number you submit.</div>
</form>
</div>

<div class="card"><h2>Featured listing — founding rate</h2>
<p class="price"><b>$${cfg.featuredPriceMonthly}/month</b>, locked for as long as you stay subscribed. Standard rate will be $${cfg.featuredPriceStandard}.</p>
<ul><li>Top placement on your city page and on the insurance pages you serve.</li>
<li>Only ${cfg.featuredSlotsPerCity} slots per city — we cap them so the page stays useful.</li>
<li>Your blurb, intake phone, and website surfaced above the fold.</li>
<li>Priority waitlist re-verification, so your availability never goes stale.</li></ul>
<p class="src">For scale: agencies report about $45 per lead on paid search for ABA, and $8–$50 a click in Texas metros. One founding slot is roughly four leads' worth of ad spend — and one enrolled client is worth tens of thousands a year.</p>
${payBlock}
<p class="src">Verified first, then billed: we confirm your license and your listing details before your slot goes live. Cancel anytime; no contract.</p>
</div>
</div>

<div class="card"><h2>What we will never do</h2>
<ul><li><b>No pay-for-placement in the regular directory.</b> Featured slots are labeled as featured, everywhere they appear.</li>
<li><b>No per-referral or per-client fees</b>, ever — flat monthly only. That keeps us clean under federal and state anti-kickback rules for clinics with Medicaid volume, and it keeps our rankings honest.</li>
<li><b>No selling family contact data.</b> Inquiries go to the provider the family chose.</li></ul></div>`;
  return layout("For ABA Clinics — Claim Your Listing | ClearPath ABA", body, {
    desc: "Claim your ABA clinic's verified listing free, or take a founding featured slot. Flat monthly pricing, never per-referral fees.",
    canonical: "/for-clinics.html",
  });
}

function methodologyPage() {
  const matchRate = ((verifiedOrgs.length / orgs.length) * 100).toFixed(1);
  const body = `
<h1>How ClearPath is built</h1>
<p class="lede">Everything here traces to a public record or a dated phone call. This page explains exactly where each fact comes from, and what we deliberately do not claim.</p>

<h2>Sources</h2>
<div class="card"><table>
<tr><th>Layer</th><th>Source</th><th>Refresh</th></tr>
<tr><td>Provider organizations</td><td>NPPES / NPI Registry, taxonomy 103K00000X (Behavior Analyst), organizational NPIs in Texas</td><td>Weekly</td></tr>
<tr><td>License status</td><td>Texas TDLR licensing roster published on data.texas.gov (dataset 7358-krk7) — ${licenses.length.toLocaleString()} behavior-analyst records, ${activeLicenses.length.toLocaleString()} active</td><td>Weekly</td></tr>
<tr><td>Insurance acceptance</td><td>Confirmed by phone with the clinic; payer directories used only as a starting list</td><td>Every 6 months, or on claim</td></tr>
<tr><td>Waitlist status</td><td>Asked directly; expires after 90 days by design</td><td>Quarterly</td></tr>
</table></div>

<h2>How license matching works</h2>
<div class="card">
<p>Each organizational NPI record names an authorized official. We normalize that name and look for a <b>unique</b> match in the state licensing roster. A unique match to an active license produces a dated "license verified" badge showing the license number, type, and expiry. Today ${verifiedOrgs.length} of ${orgs.length} organizations (${matchRate}%) are verified this way.</p>
<p><b>What we don't do:</b> we never publish that a clinic's license is expired or invalid on the strength of a name match. Non-matches are shown neutrally as "not confirmed," because the common causes are name variants, a director who differs from the administrative contact, or an out-of-state license — not wrongdoing. Verification improves as clinics claim their profiles.</p>
<p><b>On the BACB registry:</b> the national certification registry's terms prohibit bulk harvesting and commercial republication, so we don't scrape it. We check BACB certification one record at a time during claim verification and store only the fact and date of that check.</p>
</div>

<h2>Ranking</h2>
<div class="card"><p>City pages sort by (1) confirmed current availability, (2) verified license, then (3) alphabetically. Featured slots are paid, capped at ${cfg.featuredSlotsPerCity} per city, and always labeled. Nothing else about payment touches ordering.</p></div>

<h2>Corrections</h2>
<div class="card"><p>Email <a href="mailto:${esc(cfg.correctionsEmail)}">${esc(cfg.correctionsEmail)}</a>. Corrections from families trigger a re-verification call, and we update the date stamp when we confirm. If you are a provider and something is wrong, claiming your profile is the fastest fix.</p></div>`;
  return layout("Methodology — How We Verify | ClearPath ABA", body, {
    desc: "Exactly how ClearPath ABA compiles and verifies Texas ABA provider data: sources, license matching, refresh cadence, and what we refuse to claim.",
    canonical: "/methodology.html",
  });
}

function reportPage() {
  const top = cities.slice(0, 20).map((c) => {
    const sites = orgs.filter((o) => o.city_slug === c.city_slug);
    const ver = sites.filter((o) => o.ao_license_status === "active").length;
    return { ...c, ver, rate: ((ver / sites.length) * 100).toFixed(0) };
  });
  const byYear = {};
  for (const o of orgs) {
    const y = (o.enumeration_date ?? "").slice(0, 4);
    if (y) byYear[y] = (byYear[y] ?? 0) + 1;
  }
  const years = Object.keys(byYear).sort().slice(-12);
  const maxY = Math.max(...years.map((y) => byYear[y]));
  const recent = years.slice(-3).reduce((s, y) => s + byYear[y], 0);
  const expSoon = activeLicenses.filter((l) => l.expires && l.expires <= new Date(Date.now() + 15552e6).toISOString().slice(0, 10)).length;
  const perOrg = (activeLicenses.length / orgs.length).toFixed(1);
  const body = `
<h1>Where Texas families can actually get ABA therapy</h1>
<p class="lede">An access report built from two public datasets: every Texas organization registered under the behavior-analyst taxonomy in the federal NPI registry, and the state's own licensing roster. Built ${today}.</p>

<h2>The headline numbers</h2>
<div class="stats">
  <div><b>${orgs.length.toLocaleString()}</b><span>ABA organizations registered in Texas</span></div>
  <div><b>${activeLicenses.length.toLocaleString()}</b><span>active licensed behavior analysts</span></div>
  <div><b>${perOrg}</b><span>active analysts per organization, statewide</span></div>
  <div><b>${recent.toLocaleString()}</b><span>organizations registered in the last three years</span></div>
</div>

<h2>Provider supply by metro</h2>
<p>Counts are organizational NPIs with a Texas practice address. "Verified" means we matched the organization's authorized official to an active state license.</p>
<div class="card"><table>
<tr><th>City</th><th>Providers</th><th>License-verified</th><th>Verified share</th></tr>
${top.map((c) => `<tr><td><a href="tx/${c.city_slug}/index.html">${esc(c.city)}</a></td><td>${c.n}</td><td>${c.ver}</td><td>${c.rate}%</td></tr>`).join("")}
</table></div>

<h2>How fast the market grew</h2>
<p>New organizational NPI registrations per year — a proxy for clinics opening, and a reminder that most Texas ABA organizations are young.</p>
<div class="card chart">${years.map((y) => `<div class="bar"><span style="height:${Math.round((byYear[y] / maxY) * 100)}%"></span><em>${y.slice(2)}</em><b>${byYear[y]}</b></div>`).join("")}</div>

<h2>What this means if you're looking for care</h2>
<div class="card">
<ul>
<li><b>Provider count is not access.</b> A metro can list dozens of organizations and still have months-long waits, because capacity depends on staffed analysts, not registrations. Statewide there are only about ${perOrg} actively licensed analysts per registered organization.</li>
<li><b>Registration is not verification.</b> Anyone can obtain an NPI; only the state issues a license. Across Texas we could positively verify an active license for ${verifiedOrgs.length} organizations so far — the rest are unconfirmed, which is why we show that distinction rather than hiding it.</li>
<li><b>Check the license expiry.</b> ${expSoon.toLocaleString()} active Texas behavior-analyst licenses come up for renewal within six months. It costs nothing to <a href="lookup.html">look up</a> the analyst who will actually treat your child.</li>
<li><b>Call more clinics than feels reasonable.</b> With most families waiting and waits averaging months, the families who start soonest are the ones who called ten clinics, not three.</li>
</ul>
</div>

<h2>Method and limits</h2>
<div class="card"><p>Organization counts come from the NPPES registry (taxonomy 103K00000X, organizational NPIs, Texas practice address) and will slightly overstate operating clinics, because some registrations are dormant or single-purpose entities. License counts come from the TDLR roster on data.texas.gov. License matching is name-based and requires a unique match, so verified counts are a floor, not a ceiling. Full detail on the <a href="methodology.html">methodology page</a>. Reuse these numbers freely with a link.</p></div>`;
  return layout("Texas ABA Access Report — Provider Supply and Verification | ClearPath ABA", body, {
    desc: `Where Texas families can actually get ABA therapy: ${orgs.length.toLocaleString()} organizations, ${activeLicenses.length.toLocaleString()} licensed analysts, and verification rates across 20 metros.`,
    canonical: "/texas-aba-access-report.html",
  });
}

const thanksPage = () => layout("Thank you | ClearPath ABA", `
<h1>Got it — thank you</h1>
<p class="lede">Your message is on its way. If you asked a provider about availability, they'll reach out directly. If you claimed a listing, we'll verify your license and call the clinic's number on public record, usually within two business days.</p>
<p><a class="btn" href="index.html">Back to the directory</a></p>`, { canonical: "/thanks.html" });

const notFoundPage = () => layout("Page not found | ClearPath ABA", `
<h1>That page doesn't exist</h1>
<p class="lede">It may have moved, or a provider record may have been retired.</p>
<p><a class="btn" href="/index.html">Back to the directory</a> <a class="btn ghost" href="/lookup.html">License lookup</a></p>`);

// ---------- css ----------
const CSS = `:root{--ink:#182529;--soft:#4f6167;--faint:#87979c;--accent:#0d6b5b;--accent-d:#0a5347;--accent-bg:#e5f1ee;
--ok:#0d6b5b;--ok-bg:#e5f1ee;--warn:#8a5a15;--warn-bg:#f7edda;--bad:#94413a;--bad-bg:#f6e5e2;--mut:#5d6d72;--mut-bg:#edf0f0;
--rule:#dde5e3;--bg:#fbfcfb;--card:#fff;--feat:#7a5b12;--feat-bg:#faf1d8}
@media(prefers-color-scheme:dark){:root{--ink:#e7ecea;--soft:#a9b7b8;--faint:#7d8c8f;--accent:#5fbfa8;--accent-d:#7fd0bb;--accent-bg:#12302a;
--ok:#5fbfa8;--ok-bg:#12302a;--warn:#d6ab5f;--warn-bg:#2f2716;--bad:#d1867c;--bad-bg:#331f1d;--mut:#9aa8ab;--mut-bg:#212a2c;
--rule:#2c3739;--bg:#12181a;--card:#182022;--feat:#d9b976;--feat-bg:#2b2515}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:62rem;margin:0 auto;padding:0 1.1rem}
a{color:var(--accent-d)}
header.top{background:var(--card);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:5}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:.7rem;padding-bottom:.7rem;flex-wrap:wrap}
.brand{font-weight:800;font-size:1.15rem;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.brand span{color:var(--accent);margin-left:.25rem}
nav{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
nav a{font-size:.9rem;text-decoration:none;color:var(--soft)}nav a:hover{color:var(--accent-d)}
nav a.cta{background:var(--accent);color:#fff;padding:.35rem .75rem;border-radius:5px;font-weight:600}
main{padding-bottom:3rem}
h1{font-size:clamp(1.6rem,4vw,2.3rem);line-height:1.15;letter-spacing:-.02em;margin:1.6rem 0 .5rem;text-wrap:balance}
h2{font-size:1.25rem;letter-spacing:-.01em;margin:2rem 0 .7rem}
h3{font-size:1.02rem;margin:0 0 .35rem}
.lede{font-size:1.05rem;color:var(--soft);margin:0 0 1.2rem;max-width:44rem}
p{margin:0 0 .9rem}ul{margin:0 0 .9rem;padding-left:1.1rem}li{margin-bottom:.35rem}
.card{background:var(--card);border:1px solid var(--rule);border-radius:9px;padding:1.1rem;margin:.7rem 0}
.card.highlight{border-color:var(--accent);border-width:1px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.7rem}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))}
a.tile{text-decoration:none;color:var(--ink);display:flex;flex-direction:column;gap:.15rem}
a.tile:hover{border-color:var(--accent)}a.tile span{color:var(--faint);font-size:.85rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.7rem;margin:1.2rem 0}
.stats div{background:var(--card);border:1px solid var(--rule);border-radius:9px;padding:.9rem}
.stats b{display:block;font-size:1.7rem;line-height:1.1;color:var(--accent);font-variant-numeric:tabular-nums}
.stats span{font-size:.83rem;color:var(--soft)}
.badge{display:inline-block;font-size:.75rem;font-weight:600;padding:.16rem .5rem;border-radius:4px;margin:0 .3rem .3rem 0}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}.badge.mut{background:var(--mut-bg);color:var(--mut)}
.badge.feat-b{background:var(--feat-bg);color:var(--feat)}
.badges.big .badge{font-size:.82rem;padding:.25rem .6rem}
.row{display:flex;gap:1rem;align-items:flex-start}.row-main{flex:1;min-width:0}
.row a{text-decoration:none;font-size:1.05rem}.row a:hover{text-decoration:underline}
.src{font-size:.82rem;color:var(--faint);margin-top:.25rem}
.crumbs{font-size:.85rem;color:var(--faint);margin-top:1rem}.crumbs a{color:var(--soft)}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.9rem 0}
.chip{font-size:.82rem;text-decoration:none;background:var(--card);border:1px solid var(--rule);padding:.3rem .65rem;border-radius:99px;color:var(--soft)}
.chip:hover{border-color:var(--accent);color:var(--accent-d)}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:700}
.form label{display:block;margin:.6rem 0;font-size:.88rem;color:var(--soft)}
.form .f2{display:grid;grid-template-columns:1fr 1fr;gap:.7rem}
@media(max-width:34rem){.form .f2{grid-template-columns:1fr}}
input,select,textarea{width:100%;font:inherit;padding:.5rem .6rem;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--ink);margin-top:.2rem}
button,.btn{display:inline-block;background:var(--accent);color:#fff;border:1px solid var(--accent);font:inherit;font-weight:600;padding:.55rem 1rem;border-radius:6px;cursor:pointer;text-decoration:none;margin-top:.5rem}
button:hover,.btn:hover{background:var(--accent-d)}
.btn.big{font-size:1.05rem;padding:.7rem 1.3rem;display:block;text-align:center}
.btn.ghost{background:transparent;color:var(--accent-d)}
.cta-band{display:flex;gap:1rem;align-items:center;justify-content:space-between;flex-wrap:wrap;border-color:var(--accent);background:var(--accent-bg)}
.cta-band .btn{margin-top:0;white-space:nowrap}
.price{font-size:1.05rem}.price b{font-size:1.5rem;color:var(--accent)}
.fh{margin-bottom:.4rem}.feat{border-color:var(--feat)}
.claimed{border-color:var(--accent)}
.notice{background:var(--warn-bg);border:1px solid var(--rule);border-radius:8px;padding:.7rem .9rem;font-size:.9rem}
.chart{display:flex;gap:.4rem;align-items:flex-end;height:11rem;padding-top:1rem}
.chart .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;position:relative}
.chart .bar span{display:block;width:100%;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}
.chart .bar em{font-style:normal;font-size:.7rem;color:var(--faint);margin-top:.3rem}
.chart .bar b{position:absolute;top:-1rem;font-size:.7rem;color:var(--soft);font-variant-numeric:tabular-nums}
.lookup-out{margin-top:.8rem;max-height:26rem;overflow:auto}
label.wide{display:block;font-size:.88rem;color:var(--soft)}
footer{border-top:1px solid var(--rule);padding:1.3rem 1.1rem 3rem;font-size:.86rem;color:var(--soft);max-width:62rem;margin:2rem auto 0}
footer .fine{font-size:.78rem;color:var(--faint)}
.finder{display:flex;gap:.7rem;align-items:flex-end;flex-wrap:wrap}
.finder label{font-size:.85rem;color:var(--soft);flex:1;min-width:11rem}
.finder button{margin-top:0;height:2.6rem}
`;

// ---------- write ----------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(new URL("providers/", OUT), { recursive: true });
const w = (rel, html) => writeFileSync(new URL(rel, OUT), html);
let count = 0;

w("style.css", CSS);
w("index.html", homePage()); count++;
w("lookup.html", lookupPage()); count++;
w("for-clinics.html", forClinicsPage()); count++;
w("methodology.html", methodologyPage()); count++;
w("texas-aba-access-report.html", reportPage()); count++;
w("thanks.html", thanksPage()); count++;
w("404.html", notFoundPage()); count++;

// compact license index for client-side lookup: [NAME, LIC, type, status, expires]
w("licenses.json", JSON.stringify(licenses.map((l) => [
  l.name, l.license_no, l.license_type?.includes("Assistant") ? "A" : "L", l.status === "active" ? "a" : "x", l.expires ?? "",
])));

const urls = ["/", "/lookup.html", "/for-clinics.html", "/methodology.html", "/texas-aba-access-report.html"];
for (const c of cities) {
  mkdirSync(new URL(`tx/${c.city_slug}/`, OUT), { recursive: true });
  w(`tx/${c.city_slug}/index.html`, cityPage(c)); count++;
  urls.push(`/tx/${c.city_slug}/`);
  if (c.n >= MIN_SITES_FOR_PAYER_PAGE) {
    for (const p of Object.keys(PAYERS)) {
      w(`tx/${c.city_slug}/accepts-${p}.html`, cityPage(c, p)); count++;
      urls.push(`/tx/${c.city_slug}/accepts-${p}.html`);
    }
  }
}
for (const o of orgs) {
  w(`providers/${o.npi}.html`, providerPage(o)); count++;
  urls.push(`/providers/${o.npi}.html`);
}

w("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${base}${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>`);
w("robots.txt", `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ""}`);

console.log(`Generated ${count} pages in docs/`);
console.log(`  ${orgs.length} providers · ${cities.length} cities · ${urls.length} sitemap URLs`);
console.log(`  license-verified: ${verifiedOrgs.length} (${((verifiedOrgs.length / orgs.length) * 100).toFixed(1)}%)`);
if (!cfg.domain) console.log("  NOTE: site.config.json domain is empty — canonicals/sitemap URLs are relative.");
if (!cfg.stripeFeaturedLink) console.log("  NOTE: no Stripe link configured — featured CTA falls back to email.");
if (!cfg.web3formsKey) console.log("  NOTE: no Web3Forms key — forms fall back to mailto.");

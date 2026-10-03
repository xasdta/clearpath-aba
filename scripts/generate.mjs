// Static site generator for ABA Openings -> docs/ (Vercel serves this directory).
// Reads data/directory.db + data/ops.db (see lib/db.mjs) plus featured.json / claims.json / site.config.json.
//
// PUBLISHING RULE (important, enforced below):
// We publish POSITIVE license verification only. A provider whose authorized official
// uniquely matches an ACTIVE TDLR license gets a dated "verified" badge. Everything else
// renders as "not confirmed" — we never publicly assert that a named business's license is
// expired or invalid on the strength of a heuristic name match.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openDb } from "../lib/db.mjs";
import { displayName } from "../lib/names.mjs";

const root = new URL("../", import.meta.url);
const OUT = new URL("docs/", root);
const cfg = JSON.parse(readFileSync(new URL("site.config.json", root)));
const featured = JSON.parse(readFileSync(new URL("data/featured.json", root))).providers ?? [];
const claims = JSON.parse(readFileSync(new URL("data/claims.json", root))).providers ?? [];
const db = openDb();

const today = new Date().toISOString().slice(0, 10);
// Build provenance: lets anyone (including us) confirm which commit a live page came from.
let buildSha = "unknown";
try { buildSha = execSync("git rev-parse --short HEAD", { cwd: root.pathname }).toString().trim(); } catch {}
const buildStamp = new Date().toISOString();
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
  SELECT o.*, s.site_key, s.address1, s.city, s.city_slug, s.zip, s.phone
  FROM organizations o JOIN sites s ON s.site_key = o.npi
  WHERE o.active = 1 AND s.active = 1 ORDER BY o.name`).all();
const cities = db.prepare(`
  SELECT city, city_slug, COUNT(*) n FROM sites WHERE city_slug != '' AND active = 1
  GROUP BY city_slug ORDER BY n DESC`).all();
// NPPES stores names in capitals; show them the way the clinic writes them. legal_name keeps the
// registry spelling for the provider page, and matching elsewhere is case-insensitive.
for (const o of orgs) { o.legal_name = o.name; o.name = displayName(o.name); o.city = displayName(o.city); }
// A claimed clinic may ask to be shown by its trading name ("ASPIRE" for Autism Spectrum
// Instructional Resources); it lives in claims.json so the weekly NPI refresh never undoes it.
for (const o of orgs) { const n = claimBy.get(o.npi)?.display_name; if (n) o.name = String(n).slice(0, 120); }
for (const c of cities) c.city = displayName(c.city);
const licenses = db.prepare(`SELECT name, license_no, license_type, status, expires FROM clinicians ORDER BY name`).all();
const activeLicenses = licenses.filter((l) => l.status === "active");
const verifiedOrgs = orgs.filter((o) => o.ao_license_status === "active");
const availByS = new Map();
for (const a of db.prepare(`SELECT * FROM ops.availability ORDER BY as_of DESC, id DESC`).all())
  if (!availByS.has(a.site_key)) availByS.set(a.site_key, a);
const payersBySite = new Map();
for (const p of db.prepare(`SELECT * FROM ops.payer_acceptance`).all()) {
  if (!payersBySite.has(p.site_key)) payersBySite.set(p.site_key, []);
  payersBySite.get(p.site_key).push(p);
}

const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso + "T00:00:00Z")) / 86400000);
const FRESH_DAYS = 30;  // authoritative: we say "has openings" only inside this window
const AGING_DAYS = 90;  // shown, but explicitly caveated
const ago = (d) => (d === 0 ? "today" : d === 1 ? "yesterday" : d < 14 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`);

// Availability is the product, so recency is graded rather than binary:
//   fresh (<=30d)  — authoritative, countable as a real opening
//   aging (31-90d) — shown with an explicit "last confirmed" caveat, not countable
//   stale (>90d)   — treated as unknown; we ask again rather than assert
//   none           — never collected
function availState(siteKey) {
  const a = availByS.get(siteKey);
  if (!a) return { tier: "none", cls: "mut", label: "Openings not yet confirmed", accepting: false, countable: false, days: null };
  const d = daysAgo(a.as_of);
  const wait = a.est_wait_weeks != null ? ` — about ${a.est_wait_weeks} week wait` : "";
  if (d > AGING_DAYS)
    return { tier: "stale", cls: "mut", label: `Status needs re-confirming (last checked ${ago(d)})`, accepting: false, countable: false, days: d };
  if (a.accepting) {
    const aging = d > FRESH_DAYS;
    return {
      tier: aging ? "aging" : "fresh", cls: aging ? "warn" : "ok",
      label: aging ? `Was accepting${wait} — last confirmed ${ago(d)}` : `Accepting clients${wait} — confirmed ${ago(d)}`,
      accepting: true, countable: !aging, days: d,
    };
  }
  return {
    tier: d > FRESH_DAYS ? "aging" : "fresh", cls: "bad",
    label: d > FRESH_DAYS ? `Was full — last confirmed ${ago(d)}` : `Waitlist closed — confirmed ${ago(d)}`,
    accepting: false, countable: false, days: d,
  };
}
// Sort key for "who can take my child": fresh openings first, then aging openings,
// then verified-but-unknown, then everything else; ties broken by recency.
function openingsRank(o) {
  const av = availState(o.site_key);
  const tierScore = av.accepting ? (av.tier === "fresh" ? 0 : 1) : av.tier === "none" ? 3 : av.tier === "stale" ? 4 : 5;
  return [tierScore, o.ao_license_status === "active" ? 0 : 1, av.days ?? 999];
}
// One clinic in a list. The whole row is the link; badges sit under the name on phones and to
// the right on wide screens. up = path back to the site root from the page being built.
function providerRow(o, up, extra = "") {
  const av = availState(o.site_key);
  const claim = claimBy.get(o.npi);
  return `<a class="item" href="${up}providers/${o.npi}.html">
  <span class="item-main"><b>${esc(o.name)}</b>
    <span class="meta">${esc(o.address1 ?? "")} · ${esc(o.city)}, TX ${esc(o.zip ?? "")}${o.phone ? ` · ${esc(o.phone)}` : ""}</span></span>
  <span class="badges">${licBadge(o)}<span class="badge ${av.cls}">${esc(av.label)}</span>${claim ? `<span class="badge ok">Claimed</span>` : ""}${extra}</span>
</a>`;
}
const providerList = (rows, up, extra = () => "") => `<div class="list">${rows.map((o) => providerRow(o, up, extra(o))).join("")}</div>`;

// A featured (paid) card. Website only if it is a plain http(s) URL, and marked sponsored so
// search engines don't read it as an editorial link.
const featuredBy = new Map(featured.map((f) => [f.npi, f]));
const httpUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || "")) ? u : null);
function featuredCard(f, up) {
  const o = orgs.find((x) => x.npi === f.npi);
  if (!o) return "";
  const av = availState(o.site_key);
  const phone = f.phone ?? o.phone;
  const site = httpUrl(f.website);
  return `<div class="card feat">
  <div class="feat-top"><span class="badge feat-b">Featured</span>${licBadge(o)}</div>
  <a class="feat-name" href="${up}providers/${o.npi}.html">${esc(o.name)}</a>
  ${f.blurb ? `<p class="feat-blurb">${esc(f.blurb)}</p>` : ""}
  <div class="feat-status"><span class="badge ${av.cls}">${esc(av.label)}</span></div>
  <div class="feat-actions">
    ${phone ? `<a class="btn" href="tel:${esc(String(phone).replace(/[^0-9+]/g, ""))}">Call ${esc(phone)}</a>` : ""}
    ${site ? `<a class="btn ghost" href="${esc(site)}" rel="sponsored nofollow noopener" target="_blank">Website ↗</a>` : ""}
  </div>
</div>`;
}

// POSITIVE-ONLY license rendering (see header rule)
function licBadge(o) {
  return o.ao_license_status === "active"
    ? `<span class="badge ok" title="Matched to an active Texas license on ${esc(o.ao_verified_at)}">License verified</span>`
    : `<span class="badge mut">License not confirmed</span>`;
}
const payerStatus = (siteKey, payer) => (payersBySite.get(siteKey) ?? []).find((p) => p.payer === payer);

// ---------- layout ----------
// Header navigation. The first four are what families come for; the rest sit under "More".
const NAV = [["find", "index.html#find", "Find a clinic"], ["openings", "openings.html", "Openings"], ["cities", "cities.html", "Cities"], ["verified", "verified.html", "Verified clinics"]];
const MORE = [["texas-aba-access-report.html", "Texas access report"], ["lookup.html", "License lookup"], ["methodology.html", "How we verify"]];
const navKey = (canonical) =>
  canonical === "/openings.html" ? "openings"
  : canonical === "/cities.html" || canonical.startsWith("/tx/") ? "cities"
  : canonical === "/verified.html" ? "verified"
  : canonical === "/for-clinics.html" ? "clinics" : "";

// Search box (header, mobile menu and the home page share one script, SEARCH_JS below).
const searchBox = (id, placeholder, big = false) => `<div class="sitesearch ${id}${big ? " big" : ""}" role="search">
    <label class="sr" for="${id}">${esc(placeholder)}</label>
    <input id="${id}" type="search" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="80">
    <ul class="qres" hidden></ul></div>`;

// Every page except home opens with the same band: breadcrumbs, title, summary, and anything
// the page tags as .head-extra. Done here once instead of in fifteen templates.
function wrapHead(body) {
  const m = body.match(/^\s*((?:<nav class="crumbs">[\s\S]*?<\/nav>\s*)?<h1[^>]*>[\s\S]*?<\/h1>\s*(?:<p class="lede"[^>]*>[\s\S]*?<\/p>\s*)?(?:<div class="head-extra">[\s\S]*?<\/div><!--\/head-extra-->\s*)?)/);
  return m ? `<section class="page-head">${m[1]}</section>${body.slice(m[0].length)}` : body;
}

// Client-side clinic search: matches every typed word against name + city in search.json.
// Results are built with textContent only, so no clinic name can ever become markup.
const SEARCH_JS = `(function(){
  var data=null,base=location.pathname.replace(/[^/]*$/,"").replace(/(tx\\/[^/]+\\/|providers\\/)$/,"");
  function norm(s){return s.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\\s+/g," ").trim();}
  function load(){if(data)return Promise.resolve(data);return fetch("/search.json").then(function(r){return r.json();}).then(function(d){data=d.map(function(x){return{npi:x[0],name:x[1],city:x[2],k:norm(x[1]+" "+x[2])};});return data;});}
  document.querySelectorAll(".sitesearch").forEach(function(box){
    var q=box.querySelector("input"),out=box.querySelector(".qres"),t;
    function render(list,term){
      out.textContent="";if(!term){out.hidden=true;return;}
      if(!list.length){var li=document.createElement("li");li.className="none";li.textContent="No clinic matches \\u201c"+term+"\\u201d";out.appendChild(li);}
      list.slice(0,8).forEach(function(x){var li=document.createElement("li"),a=document.createElement("a"),b=document.createElement("b"),s=document.createElement("span");
        a.href="/providers/"+encodeURIComponent(x.npi)+".html";b.textContent=x.name;s.textContent=x.city+", TX";a.appendChild(b);a.appendChild(s);li.appendChild(a);out.appendChild(li);});
      out.hidden=false;}
    function run(){var term=q.value.slice(0,80).trim(),w=norm(term).split(" ").filter(Boolean);if(!w.length){render([],"");return;}
      load().then(function(d){render(d.filter(function(x){return w.every(function(v){return x.k.indexOf(v)!==-1;});}).sort(function(a,b){return (b.k.indexOf(w[0])===0)-(a.k.indexOf(w[0])===0)||a.name.localeCompare(b.name);}),term);}).catch(function(){});}
    q.addEventListener("input",function(){clearTimeout(t);t=setTimeout(run,120);});
    q.addEventListener("keydown",function(e){if(e.key==="Escape"){q.value="";render([],"");}if(e.key==="Enter"){var a=out.querySelector("a");if(a){e.preventDefault();location.href=a.href;}}});
    document.addEventListener("click",function(e){if(!box.contains(e.target))out.hidden=true;});
    var pre=box.classList.contains("big")&&new URLSearchParams(location.search).get("q");if(pre){q.value=pre.slice(0,80);run();}
  });
  document.querySelectorAll("details.more,details.mnav").forEach(function(d){document.addEventListener("click",function(e){if(!d.contains(e.target))d.removeAttribute("open");});});
})();`;

// Stylesheet URL carries a hash of its contents: browsers cache style.css for an hour, so any
// style change must change the URL or visitors keep the old look.
let cssVer = null;
const cssVersion = () => (cssVer ??= createHash("sha256").update(CSS).digest("hex").slice(0, 10));

function layout(title, body, { desc = "", canonical = "", jsonld = null, depth = 0, noindex = false, noReferrer = false } = {}) {
  const up = "../".repeat(depth) || "./";
  const active = navKey(canonical);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">${noindex ? `\n<meta name="robots" content="noindex">` : ""}${noReferrer ? `\n<meta name="referrer" content="no-referrer">` : ""}
${base && canonical ? `<link rel="canonical" href="${base}${canonical}">` : ""}
<meta name="build" content="${esc(buildSha)} ${esc(buildStamp)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<link rel="stylesheet" href="${up}style.css?v=${cssVersion()}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22><text y=%2226%22 font-size=%2228%22>%E2%9C%93</text></svg>">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
${cfg.vercelAnalytics ? `<script defer src="/_vercel/insights/script.js"></script>` : ""}
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="wrap bar">
  <a class="brand" href="${up}index.html" aria-label="${esc(cfg.siteName)} home"><span class="mark" aria-hidden="true">✓</span>ABA<span>Openings</span></a>
  <nav class="primary" aria-label="Main">
    ${NAV.map(([k, href, label]) => `<a href="${up}${href}"${k === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
    <details class="more"><summary>More</summary><div class="menu">${MORE.map(([href, label]) => `<a href="${up}${href}">${label}</a>`).join("")}</div></details>
  </nav>
  ${searchBox("hsearch", "Search clinics or cities")}
  <a class="cta" href="${up}for-clinics.html"${active === "clinics" ? ' aria-current="page"' : ""}>For clinics</a>
  <details class="mnav"><summary aria-label="Menu"><span></span><span></span><span></span></summary>
    <div class="mpanel">
      ${searchBox("msearch", "Search clinics or cities")}
      ${NAV.map(([k, href, label]) => `<a href="${up}${href}"${k === active ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
      ${MORE.map(([href, label]) => `<a href="${up}${href}">${label}</a>`).join("")}
      <a class="btn" href="${up}for-clinics.html">For clinics</a>
    </div>
  </details>
</div></header>
<main class="wrap" id="main">${wrapHead(body)}</main>
<footer class="site">
  <div class="wrap fcols">
    <div><a class="brand" href="${up}index.html"><span class="mark" aria-hidden="true">✓</span>ABA<span>Openings</span></a>
      <p>Which Texas ABA clinics can take a new client — asked directly, dated, and re-checked every 30 days.</p></div>
    <div><h4>Families</h4><a href="${up}index.html#find">Find a clinic</a><a href="${up}openings.html">Confirmed openings</a><a href="${up}cities.html">All cities</a><a href="${up}verified.html">License-verified clinics</a><a href="${up}lookup.html">License lookup</a></div>
    <div><h4>Clinics</h4><a href="${up}for-clinics.html">Claim your listing</a><a href="${up}for-clinics.html#featured">Featured listings</a><a href="mailto:${esc(cfg.correctionsEmail)}">Report a correction</a></div>
    <div><h4>About</h4><a href="${up}methodology.html">How we verify</a><a href="${up}texas-aba-access-report.html">Texas access report</a><a href="mailto:${esc(cfg.correctionsEmail)}">${esc(cfg.correctionsEmail)}</a></div>
  </div>
  <div class="wrap fine">
    <p><b>How we make money.</b> Clinics may buy a flat monthly featured listing, always labeled. Placement in the regular directory is never for sale, and we never take a fee per referral or per enrolled client.</p>
    <p>${esc(cfg.siteName)} is an independent directory built from the federal NPI registry and the Texas TDLR roster. It is not medical advice and does not endorse any provider. Data last built ${today}. <a href="#main">Back to top ↑</a></p>
  </div>
</footer>
<script>${SEARCH_JS}</script>
</body></html>`;
}

// Every form posts to api/submit.mjs, which queues it for jobs/apply-inbox.mjs (see there).
// kind selects the handler; botcheck is a honeypot that real visitors never see.
function formOpen(kind) {
  return `<form class="card form" action="/api/submit" method="POST">
       <input type="hidden" name="kind" value="${esc(kind)}">
       <input type="checkbox" name="botcheck" class="hidden" style="display:none" tabindex="-1" autocomplete="off">`;
}


// ---------- home hero map ----------
// Proportional-symbol map: one dot per city, AREA proportional to provider count (so Houston's
// 207 reads as ~2x Austin's 90, not 4x). One hue — size carries the magnitude, so there is no
// colour scale to decode and no legend box; the caption names the encoding. Each dot is a link
// with a hover/focus tooltip; the city tiles below are the table view of the same numbers.
// Coordinates are public city centroids; the outline is a simplified state border.
const TX_OUTLINE = [[-103.04,36.5],[-100,36.5],[-100,34.56],[-99.6,34.38],[-99.19,34.21],[-98.61,34.16],[-98.1,34.13],[-97.6,33.97],[-97.15,33.72],[-96.63,33.85],[-96.15,33.84],[-95.75,33.89],[-95.23,33.96],[-94.73,33.7],[-94.48,33.64],[-94.04,33.55],[-94.04,33.02],[-94.04,31.99],[-93.82,31.6],[-93.55,31.18],[-93.53,30.93],[-93.71,30.4],[-93.76,30.02],[-93.84,29.69],[-94.37,29.55],[-94.75,29.37],[-95.1,29.1],[-95.52,28.83],[-96.2,28.52],[-96.64,28.3],[-97.03,28.03],[-97.24,27.63],[-97.39,27.25],[-97.37,26.9],[-97.23,26.4],[-97.15,26.02],[-97.4,25.95],[-97.67,26.03],[-98.2,26.07],[-98.67,26.24],[-99.1,26.43],[-99.44,27.02],[-99.53,27.5],[-99.87,27.79],[-100.28,28.28],[-100.64,28.9],[-100.96,29.35],[-101.4,29.77],[-101.7,29.76],[-102.32,29.88],[-102.67,29.74],[-102.87,29.35],[-103.1,29],[-103.28,28.98],[-103.6,29.2],[-104.05,29.34],[-104.45,29.58],[-104.7,29.93],[-104.97,30.43],[-105.4,30.85],[-105.95,31.3],[-106.38,31.73],[-106.53,31.79],[-106.62,32],[-103.06,32]];
const CITY_LL = {
  houston:[29.76,-95.37], austin:[30.27,-97.74], "san-antonio":[29.42,-98.49], dallas:[32.78,-96.8], katy:[29.79,-95.82],
  "fort-worth":[32.76,-97.33], spring:[30.08,-95.42], richmond:[29.58,-95.76], "sugar-land":[29.62,-95.63], cypress:[29.97,-95.69],
  plano:[33.02,-96.7], frisco:[33.15,-96.82], "round-rock":[30.51,-97.68], killeen:[31.12,-97.73], "el-paso":[31.76,-106.49],
  denton:[33.21,-97.13], arlington:[32.74,-97.11], mckinney:[33.2,-96.62], "cedar-park":[30.51,-97.82], "missouri-city":[29.62,-95.54],
  pearland:[29.56,-95.29], irving:[32.81,-96.95], mcallen:[26.2,-98.23], abilene:[32.45,-99.73], allen:[33.1,-96.67],
  grapevine:[32.93,-97.08], lubbock:[33.58,-101.86], bellaire:[29.71,-95.46], carrollton:[32.95,-96.89], edinburg:[26.3,-98.16],
  "harker-heights":[31.08,-97.66], magnolia:[30.21,-95.75], sherman:[33.64,-96.61], "the-woodlands":[30.17,-95.5],
  "wichita-falls":[33.91,-98.49], "league-city":[29.51,-95.09], prosper:[33.24,-96.8], richardson:[32.95,-96.73], conroe:[30.31,-95.46],
  "flower-mound":[33.01,-97.1], humble:[29.99,-95.26], keller:[32.93,-97.25], kingwood:[30.05,-95.19], lewisville:[33.05,-96.99],
  southlake:[32.94,-97.13], "corpus-christi":[27.8,-97.4], amarillo:[35.22,-101.83], midland:[32,-102.08], odessa:[31.85,-102.37],
  laredo:[27.53,-99.49], brownsville:[25.9,-97.5], beaumont:[30.08,-94.13], tyler:[32.35,-95.3], waco:[31.55,-97.15],
  "college-station":[30.63,-96.33], "san-angelo":[31.46,-100.44], longview:[32.5,-94.74], temple:[31.1,-97.34],
  "new-braunfels":[29.7,-98.12], "san-marcos":[29.88,-97.94], victoria:[28.81,-97], harlingen:[26.19,-97.7], bryan:[30.67,-96.37],
  georgetown:[30.63,-97.68], pflugerville:[30.44,-97.62], mansfield:[32.56,-97.14], mesquite:[32.77,-96.6], garland:[32.91,-96.64],
  "grand-prairie":[32.75,-97], texarkana:[33.43,-94.05], nacogdoches:[31.6,-94.66], kerrville:[30.05,-99.14], "del-rio":[29.36,-100.9],
};
// Suburbs sit within a few pixels of their core city, so drawn separately they pile into an
// unreadable cluster. Roll them into one metro dot that links to the core city's page; the
// tooltip says how many cities the dot covers.
const METROS = {
  houston: ["Houston area", ["katy","spring","richmond","sugar-land","cypress","missouri-city","pearland","bellaire","magnolia","the-woodlands","league-city","conroe","humble","kingwood","tomball","friendswood","pasadena","stafford","fulshear","baytown"]],
  dallas: ["Dallas–Fort Worth", ["fort-worth","plano","frisco","denton","arlington","mckinney","irving","allen","grapevine","carrollton","prosper","richardson","flower-mound","keller","lewisville","southlake","mansfield","mesquite","garland","grand-prairie","coppell","euless","bedford","hurst","rockwall","little-elm","the-colony","wylie","murphy","colleyville","north-richland-hills","addison","farmers-branch","desoto","cedar-hill","rowlett","sachse","celina","forney","burleson","weatherford","midlothian","waxahachie"]],
  austin: ["Austin area", ["round-rock","cedar-park","georgetown","pflugerville","san-marcos","leander","kyle","buda","hutto","lakeway","dripping-springs"]],
  "san-antonio": ["San Antonio area", ["new-braunfels","boerne","schertz","converse","helotes","live-oak","universal-city","cibolo"]],
  killeen: ["Killeen–Temple", ["harker-heights","temple","belton","copperas-cove"]],
  mcallen: ["Rio Grande Valley", ["edinburg","harlingen","brownsville","mission","pharr","weslaco"]],
};
function texasMap() {
  const W = 480, H = 440, PAD = 14;
  const kx = Math.cos((31 * Math.PI) / 180);             // equirectangular, scaled at Texas's mid-latitude
  const xs = TX_OUTLINE.map(([lo]) => lo * kx), ys = TX_OUTLINE.map(([, la]) => la);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sc = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
  const px = (lo, la) => [PAD + (lo * kx - x0) * sc, PAD + (y1 - la) * sc];
  const outline = TX_OUTLINE.map(([lo, la], i) => `${i ? "L" : "M"}${px(lo, la).map((v) => v.toFixed(1)).join(",")}`).join("") + "Z";
  const memberOf = new Map();
  for (const [core, [, subs]] of Object.entries(METROS)) for (const sub of subs) memberOf.set(sub, core);
  const groups = new Map();                                  // core slug -> {c, n, open, members}
  for (const c of cities) {
    const core = memberOf.get(c.city_slug) ?? c.city_slug;
    if (!CITY_LL[core]) continue;
    const g = groups.get(core) ?? { slug: core, name: METROS[core]?.[0] ?? c.city, n: 0, open: 0, members: 0 };
    g.n += c.n; g.members += 1;
    g.open += orgs.filter((o) => o.city_slug === c.city_slug && availState(o.site_key).countable).length;
    groups.set(core, g);
  }
  const dots = [...groups.values()]
    .map((g) => {
      const [la, lo] = CITY_LL[g.slug];
      const [x, y] = px(lo, la);
      return { c: { city_slug: g.slug, city: g.name, n: g.n }, x, y, r: Math.max(4, 1.35 * Math.sqrt(g.n)), open: g.open, members: g.members };
    })
    .sort((a, b) => b.r - a.r);                            // big first, so small dots stay on top and clickable
  const LABEL = { houston: [0, 1], dallas: [1, -1], austin: [-1, 0], "san-antonio": [-1, 1], "el-paso": [1, 0], mcallen: [1, 0] };
  const mapped = dots.reduce((a, d) => a + d.c.n, 0);
  return `<figure class="txmap">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="txmap-t txmap-d">
  <title id="txmap-t">ABA providers across Texas</title>
  <desc id="txmap-d">One dot per city, sized by number of ABA providers. Largest: ${dots.slice(0, 4).map((d) => `${d.c.city} ${d.c.n}`).join(", ")}.</desc>
  <path class="tx" d="${outline}"/>
  ${dots.map((d) => `<a href="tx/${d.c.city_slug}/index.html" class="dot" data-city="${esc(d.c.city)}" data-n="${d.c.n}" data-open="${d.open}" data-cities="${d.members}" aria-label="${esc(d.c.city)}: ${d.c.n} providers${d.open ? `, ${d.open} accepting` : ""}"><circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}"/><circle class="hit" cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${Math.max(d.r, 9).toFixed(1)}"/></a>`).join("\n  ")}
  ${dots.filter((d) => LABEL[d.c.city_slug]).map((d) => {
    const [hx, vy] = LABEL[d.c.city_slug];
    // hx: -1 left, 1 right, 0 centred below the dot (for dots near the right edge)
    const tx = d.x + hx * (d.r + 5), ty = hx === 0 ? d.y + d.r + 14 : d.y + vy * (d.r * 0.6) + 4;
    return `<text class="lbl" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${hx > 0 ? "start" : hx < 0 ? "end" : "middle"}">${esc(d.c.city)}</text>`;
  }).join("\n  ")}
</svg>
<figcaption>Each dot is a city or metro area, sized by how many ABA providers it has — ${mapped.toLocaleString()} of ${orgs.length.toLocaleString()} shown. Tap one to see its clinics.</figcaption>
<div class="maptip" role="status" hidden></div>
<script>
(function(){
  var fig=document.currentScript.parentNode,tip=fig.querySelector(".maptip");
  function show(e){
    var a=e.target.closest("a.dot"); if(!a) return;
    var n=+a.dataset.n,o=+a.dataset.open,b=document.createElement("b");
    tip.textContent="";b.textContent=a.dataset.city;tip.appendChild(b);
    var m=+a.dataset.cities;tip.appendChild(document.createTextNode(" · "+n+" provider"+(n===1?"":"s")+(m>1?" in "+m+" cities":"")+(o?" · "+o+" accepting":"")));
    var fr=fig.getBoundingClientRect(),cr=a.querySelector("circle").getBoundingClientRect();
    tip.style.left=(cr.left+cr.width/2-fr.left)+"px";tip.style.top=(cr.top-fr.top)+"px";tip.hidden=false;
  }
  function hide(){tip.hidden=true;}
  fig.addEventListener("mouseover",show);fig.addEventListener("focusin",show);
  fig.addEventListener("mouseout",hide);fig.addEventListener("focusout",hide);
})();
</script>
</figure>`;
}

// ---------- pages ----------
function homePage() {
  const topCities = cities.slice(0, 18);
  const openCount = orgs.filter((o) => availState(o.site_key).countable).length;
  const askedCount = orgs.filter((o) => availState(o.site_key).tier !== "none").length;
  const jsonld = {
    "@context": "https://schema.org", "@type": "WebSite", name: cfg.siteName,
    url: base || undefined, description: cfg.tagline,
  };
  const body = `
<section class="hero">
  <div class="hero-text">
    <p class="eyebrow">${orgs.length.toLocaleString()} Texas ABA providers · ${verifiedOrgs.length} license-verified</p>
    <h1>Which Texas ABA clinics can actually take your child right now</h1>
    <p class="lede">Most autism-therapy directories list whoever signs up and never ask again, so you call ten clinics and hear "we have a six-month waitlist" ten times. We ask the clinics whether they can take a new client and publish the answer with the date we got it — then re-ask every 30 days and retire anything we can't re-confirm.</p>
    <div class="hero-cta"><a class="btn big" href="#find">Find a clinic</a><a class="btn ghost big" href="openings.html">See confirmed openings</a></div>
  </div>
  ${texasMap()}
</section>



<section class="card highlight" id="find">
  <h2>Find clinics near you</h2>
  ${searchBox("q", "Search by clinic name or city", true)}
  <p class="src or">or narrow by city and insurance:</p>
  <form class="finder" action="#" onsubmit="return cpGo(event)">
    <label>City<select id="cpCity">${cities.slice(0, 60).map((c) => `<option value="${c.city_slug}">${esc(c.city)} (${c.n})</option>`).join("")}</select></label>
    <label>Insurance<select id="cpPayer"><option value="">Any</option>${Object.entries(PAYERS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
    <label class="chk"><input type="checkbox" id="cpOpen"> Only show clinics accepting now</label>
    <button>Search</button>
  </form>
  <script>function cpGo(e){e.preventDefault();var c=document.getElementById('cpCity').value,p=document.getElementById('cpPayer').value,o=document.getElementById('cpOpen').checked;location.href='tx/'+c+'/'+(o?'accepting-now.html':(p?'accepts-'+p+'.html':'index.html'));return false}</script>
  <p class="src" style="margin-top:.6rem">Or see <a href="openings.html"><b>every confirmed opening in Texas</b></a> on one page.</p>
</section>

<div class="stats">
  <a class="stat" href="openings.html"><b>${openCount}</b><span>clinics with confirmed openings</span><em>${openCount ? "See openings →" : "How it works →"}</em></a>
  <a class="stat" href="openings.html#answered"><b>${askedCount.toLocaleString()}</b><span>clinics asked so far</span><em>See who answered →</em></a>
  <a class="stat" href="cities.html"><b>${orgs.length.toLocaleString()}</b><span>ABA organizations statewide</span><em>Browse all cities →</em></a>
  <a class="stat" href="verified.html"><b>${verifiedOrgs.length}</b><span>with a license-verified director</span><em>See verified clinics →</em></a>
</div>

<h2>Browse by city</h2>
<div class="grid">${topCities.map((c) => {
    const n = orgs.filter((o) => o.city_slug === c.city_slug && availState(o.site_key).countable).length;
    return `<a class="tile card" href="tx/${c.city_slug}/index.html"><b>${esc(c.city)}</b><span>${c.n} provider${c.n === 1 ? "" : "s"}${n ? ` · <strong>${n} accepting</strong>` : ""}</span></a>`;
  }).join("")}</div>
<p class="more"><a href="cities.html">All ${cities.length} Texas cities →</a></p>

${alertSignup(null, null, 0)}

<h2>What makes this different</h2>
<div class="grid two">
  <div class="card"><h3>We ask, and we date the answer</h3><p>Roughly three in four families end up waiting, and the average wait runs months. Nobody else publishes who has room. We collect it by phone, stamp it with the date, and let it visibly expire rather than quietly going stale.</p></div>
  <div class="card"><h3>We check the license against the state</h3><p>Texas requires behavior analysts to hold an active LBA license. We match each organization's clinical director against the state roster and show what we found — and say plainly when we could not confirm it. <a href="lookup.html">Look up any analyst →</a></p></div>
</div>

<div class="card cta-band">
  <div><b>New report:</b> where Texas families can actually get ABA — provider density, verification rates, and access gaps across 20 metros.</div>
  <a class="btn" href="texas-aba-access-report.html">Read the access report</a>
</div>`;
  return layout(`${cfg.siteName} — Which Texas ABA Clinics Are Accepting New Clients`, body, {
    desc: `${openCount} Texas ABA clinics with confirmed openings, dated and re-checked every 30 days, plus license verification for ${orgs.length.toLocaleString()} providers.`,
    canonical: "/", jsonld,
  });
}

function cityPage(c, payer = null, openOnly = false) {
  const sites = orgs.filter((o) => o.city_slug === c.city_slug);
  // A paid card must never contradict the page it sits on: not on an insurance page for a plan
  // the clinic has said it doesn't take, and not on "accepting now" unless it currently is.
  const feats = (featuredByCity.get(c.city.toLowerCase()) ?? [])
    .filter((f) => {
      if (payer && payerStatus(f.npi, payer)?.status === "verified_no") return false;
      if (openOnly && !availState(f.npi).accepting) return false;
      return true;
    })
    .slice(0, cfg.featuredSlotsPerCity);
  const ranked = [...sites]
    .filter((o) => (payer ? payerStatus(o.site_key, payer)?.status !== "verified_no" : true))
    .filter((o) => (openOnly ? availState(o.site_key).accepting : true))
    .sort((a, b) => {
      const [ra, rb] = [openingsRank(a), openingsRank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.name.localeCompare(b.name);
    });
  const openCount = sites.filter((o) => availState(o.site_key).countable).length;

  const title = openOnly
    ? `ABA therapy in ${c.city}, TX accepting new clients`
    : payer
    ? `ABA therapy in ${c.city}, TX that accepts ${PAYERS[payer]}`
    : `ABA therapy providers in ${c.city}, Texas`;
  const body = `
<nav class="crumbs"><a href="../../index.html">Home</a> › ${payer || openOnly ? `<a href="index.html">${esc(c.city)}</a> › ${openOnly ? "Accepting now" : esc(PAYERS[payer])}` : esc(c.city)}</nav>
<h1>${esc(title)}</h1>
<p class="lede">${openOnly
    ? (ranked.length
        ? `${ranked.length} clinic${ranked.length === 1 ? "" : "s"} in ${esc(c.city)} told us they can take new clients. Each one is dated — we re-ask every 30 days, and we never leave an old answer standing as if it were current.`
        : `No ${esc(c.city)} clinic has confirmed openings with us in the last 90 days. That is an honest gap in our data, not proof that everyone is full — we are working down the call list. Set an alert below and we will email you the moment one opens.`)
    : `${ranked.length} provider${ranked.length === 1 ? "" : "s"} compiled from public records${openCount ? `, ${openCount} with confirmed openings right now` : ""}. ${payer ? `Insurance acceptance is confirmed by phone before we show it as accepted — insurer directories are wrong often enough that regulators call them ghost networks.` : `Sorted so clinics that can actually take your child come first.`}`}</p>

<div class="head-extra">
<div class="pills"><span class="pill"><b>${sites.length}</b> providers</span><span class="pill"><b>${sites.filter((o) => o.ao_license_status === "active").length}</b> license-verified</span><span class="pill ${openCount ? "ok" : ""}"><b>${openCount}</b> accepting now</span></div>
</div><!--/head-extra-->
${openOnly ? "" : `<div class="chips sticky"><a class="chip open" href="accepting-now.html">✓ Accepting new clients${openCount ? ` (${openCount})` : ""}</a>${payer || c.n < MIN_SITES_FOR_PAYER_PAGE ? "" : Object.entries(PAYERS).map(([k, v]) => `<a class="chip" href="accepts-${k}.html">Accepts ${esc(v)}</a>`).join("")}</div>`}

${feats.length ? `<h2 class="fh">Featured providers <span class="src">· paid placement, always labeled</span></h2>
<div class="grid feats">${feats.map((f) => featuredCard(f, "../../")).join("")}</div>` : ""}

<div class="listhead" id="list">
  <h2>${openOnly ? "Confirmed openings" : `All providers${payer ? ` accepting ${esc(PAYERS[payer])}` : ""}`} <span class="src">(<span class="fcount">${ranked.length}</span>)</span></h2>
  ${ranked.length > 8 ? `<div class="filterbox"><label class="sr" for="f-list">Filter this list</label><input id="f-list" type="search" placeholder="Filter by name, street or ZIP" autocomplete="off" maxlength="60"></div>` : ""}
</div>
${providerList(ranked, "../../", (o) => {
    if (!payer) return "";
    const p = payerStatus(o.site_key, payer);
    return p?.status === "verified_yes"
      ? `<span class="badge ok">${esc(PAYERS[payer])} confirmed ${esc(p.verified_at)}</span>`
      : `<span class="badge warn">${esc(PAYERS[payer])} not yet verified</span>`;
  })}

<p class="notice fnone" hidden>No clinic in this list matches that filter.</p>
${ranked.length === 0 && !openOnly ? `<div class="notice">No providers listed here yet.</div>` : ""}
<script>(function(){var f=document.getElementById("f-list");if(!f)return;var rows=[].slice.call(document.querySelectorAll(".list a.item")),c=document.querySelector(".fcount"),none=document.querySelector(".fnone");
f.addEventListener("input",function(){var w=f.value.toLowerCase().trim().split(/\s+/).filter(Boolean),n=0;rows.forEach(function(r){var k=r.textContent.toLowerCase(),ok=w.every(function(x){return k.indexOf(x)!==-1;});r.hidden=!ok;if(ok)n++;});c.textContent=n;none.hidden=n>0;});})();</script>
${alertSignup(c.city, c.city_slug, 2)}
<div class="card cta-band"><div>Run a clinic in ${esc(c.city)}? Claim your profile free, then keep your openings current so families can find you.</div><a class="btn" href="../../for-clinics.html">Claim your listing</a></div>`;

  return layout(`${title} | ${cfg.siteName}`, body, {
    desc: openOnly
      ? `ABA clinics in ${c.city}, Texas confirmed to be accepting new clients, each with the date we checked.`
      : `${ranked.length} ABA therapy providers in ${c.city}, TX${payer ? ` accepting ${PAYERS[payer]}` : ""} — license-verified, with confirmed insurance and openings status.`,
    canonical: `/tx/${c.city_slug}${openOnly ? "/accepting-now.html" : payer ? `/accepts-${payer}.html` : ""}`, depth: 2,
  });
}

// Family alert signup — the owned-audience asset and the honest answer when a page has no openings.
function alertSignup(cityLabel, citySlug, depth) {
  return `<div class="card highlight" id="alerts">
<h2>Get told when a clinic opens up${cityLabel ? ` in ${esc(cityLabel)}` : ""}</h2>
<p>Waitlists move without warning. Tell us what you need and we will email you when a clinic within your travel distance confirms an opening — no more calling ten clinics a month to ask. We skip clinics that have told us they don't take your insurance.</p>
${formOpen("alert")}
  <input type="hidden" name="alert_city" value="${esc(citySlug ?? "")}">
  <div class="f2"><label>Email<input name="email" type="email" required></label>
  <label>ZIP code<input name="zip" required inputmode="numeric" pattern="[0-9]{5}" maxlength="5" title="5-digit ZIP code"></label></div>
  <div class="f2"><label>Insurance<select name="insurance"><option value="" selected>Any / not sure</option>${Object.entries(PAYERS).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}<option value="other">Other / self-pay</option></select></label>
  <label>Child's age<select name="child_age"><option value="" selected>Prefer not to say</option><option>0-3</option><option>4-6</option><option>7-12</option><option>13+</option></select></label></div>
  <label>How far will you travel?<select name="radius"><option value="10">10 miles</option><option value="25" selected>25 miles</option><option value="50">50 miles</option></select></label>
  <button>Email me when a spot opens</button>
  <div class="src">One email per matching opening, at most one a week. Unsubscribe in a click. We never sell your information, and we never share it with clinics unless you contact them yourself.</div>
</form></div>`;
}

function providerPage(o) {
  const av = availState(o.site_key);
  const claim = claimBy.get(o.npi);
  const pays = payersBySite.get(o.site_key) ?? [];
  const jsonld = {
    "@context": "https://schema.org", "@type": "MedicalBusiness",
    name: o.name, telephone: claim?.phone ?? o.phone ?? undefined, url: claim?.website ?? undefined,
    address: { "@type": "PostalAddress", streetAddress: o.address1, addressLocality: o.city, addressRegion: "TX", postalCode: o.zip, addressCountry: "US" },
    identifier: { "@type": "PropertyValue", propertyID: "US NPI", value: o.npi },
    medicalSpecialty: "Applied Behavior Analysis", dateModified: today,
  };
  const body = `
<nav class="crumbs"><a href="../index.html">Home</a> › <a href="../tx/${o.city_slug}/index.html">${esc(o.city)}</a> › <span>${esc(o.name)}</span></nav>
<h1>${esc(o.name)}</h1>
<p class="lede">${esc(o.address1 ?? "")} · ${esc(o.city)}, TX ${esc(o.zip ?? "")}</p>
<div class="head-extra">
<div class="pills">${featuredBy.has(o.npi) ? `<span class="pill feat">Featured</span>` : ""}<span class="pill ${av.cls}">${esc(av.label)}</span>${o.ao_license_status === "active" ? `<span class="pill ok">License verified</span>` : `<span class="pill">License not confirmed</span>`}${claim ? `<span class="pill ok">Claimed</span>` : ""}</div>
</div><!--/head-extra-->
<nav class="sectnav" aria-label="On this page"><a href="#availability">Availability</a><a href="#credentials">Credentials</a><a href="#insurance">Insurance</a><a href="#ask">Ask the clinic</a></nav>
<div class="pgrid">
<div class="pmain">
<h2 id="credentials">Credential verification</h2>
${o.legal_name !== o.name.toUpperCase() ? `<p class="src">Registered with the NPI registry as ${esc(o.legal_name)}.</p>` : ""}
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
  <div class="src">You can check any name yourself in the <a href="../lookup.html">state license lookup</a>. Provider: <a href="../for-clinics.html?npi=${esc(o.npi)}#claim">claim this profile</a> to get verified.</div>`}
</div>

<h2 id="insurance">Insurance</h2>
<div class="card"><table>
<tr><th>Plan</th><th>Status</th></tr>
${pays.map((p) => `<tr><td>${esc(PAYERS[p.payer] ?? p.payer)}</td><td>${
    p.status === "verified_yes" ? `<span class="badge ok">Accepted — confirmed with the clinic ${esc(p.verified_at)}</span>`
    : p.status === "verified_no" ? `<span class="badge bad">Not accepted (confirmed ${esc(p.verified_at)})</span>`
    : `<span class="badge warn">Not yet verified</span>`}</td></tr>`).join("")}
</table>
<div class="src">We mark a plan accepted only after confirming it with the clinic directly. Always re-confirm coverage before your first appointment — plan networks change.</div></div>

<h2 id="ask">Ask this provider about availability</h2>
${formOpen("inquiry")}
  <input type="hidden" name="npi" value="${esc(o.npi)}">
  <input type="hidden" name="provider" value="${esc(o.name)}">
  <div class="f2"><label>Your name<input name="name" required></label><label>Email or phone<input name="contact" required></label></div>
  <div class="f2"><label>Insurance<select name="insurance"><option value="" selected>Not sure yet</option>${Object.values(PAYERS).map((v) => `<option>${esc(v)}</option>`).join("")}<option>Other / self-pay</option></select></label>
  <label>Child's age<select name="child_age"><option value="" selected>Prefer not to say</option><option>0-3</option><option>4-6</option><option>7-12</option><option>13+</option></select></label></div>
  <label>Anything else<textarea name="message" rows="3" maxlength="2000"></textarea></label>
  <button>Send inquiry</button>
  <div class="src">Free for families. We pass your message to the provider — we never sell family contact information.</div>
</form>

</div>
<aside class="pside"><div class="card summary" id="availability">
  <div class="summary-status">
    <span class="label">Taking new clients?</span>
    <span class="status ${av.cls}">${esc(av.label)}</span>
    <div class="badges">${featuredBy.has(o.npi) ? `<span class="badge feat-b">Featured</span>` : ""}${licBadge(o)}${claim ? `<span class="badge ok">Claimed profile</span>` : `<span class="badge mut">Unclaimed</span>`}</div>
    ${featuredBy.get(o.npi)?.blurb ? `<p class="feat-blurb">${esc(featuredBy.get(o.npi).blurb)}</p>` : ""}
  </div>
  <div class="summary-actions">
    ${(claim?.phone ?? o.phone) ? `<a class="btn" href="tel:${esc(String(claim?.phone ?? o.phone).replace(/[^0-9+]/g, ""))}">Call ${esc(claim?.phone ?? o.phone)}</a>` : ""}
    ${httpUrl(featuredBy.get(o.npi)?.website) ? `<a class="btn ghost" href="${esc(featuredBy.get(o.npi).website)}" rel="sponsored nofollow noopener" target="_blank">Website ↗</a>` : ""}
    <a class="btn ghost" href="#ask">Ask about availability</a>
  </div>
</div>

${claim ? `<div class="card claimed"><h2>From the provider</h2>
  ${claim.website ? `<p><a href="${esc(claim.website)}" rel="nofollow">${esc(claim.website)}</a></p>` : ""}
  ${claim.service_area ? `<p><b>Service area:</b> ${esc(claim.service_area)}</p>` : ""}
  ${claim.ages_served ? `<p><b>Ages served:</b> ${esc(claim.ages_served)}</p>` : ""}
  <div class="src">Claimed and identity-verified ${esc(claim.claimed_date)}. Claiming is free and does not affect ranking.</div></div>` : ""}
<div class="card side-claim"><b>Is this your clinic?</b><p>Claim it free to keep your openings and insurance current and receive family inquiries.</p><a class="btn ghost" href="../for-clinics.html?npi=${esc(o.npi)}#claim">Claim this profile</a></div>
</aside>
</div>
<p class="src">Something wrong here? <a href="mailto:${esc(cfg.correctionsEmail)}?subject=Correction%20for%20NPI%20${esc(o.npi)}">Report a correction</a> — we re-verify with the clinic and update the date stamp.</p>`;

  return layout(`${o.name} — ABA Therapy in ${o.city}, TX | ${cfg.siteName}`, body, {
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
  return layout(`Texas Behavior Analyst License Lookup (LBA/BCBA) | ${cfg.siteName}`, body, {
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
<div id="claim"></div>
<p class="src" id="claimfor" hidden></p>
${formOpen("claim")}
  <div class="f2"><label>Clinic name<input name="clinic" id="claimclinic" required></label><label>Your name<input name="name" required></label></div>
  <div class="f2"><label>Role<input name="role" placeholder="Owner / Clinical Director" required></label><label>Work email (at your clinic's domain if you have one)<input name="email" type="email" required></label></div>
  <div class="f2"><label>Clinic NPI (10 digits, optional)<input name="npi" id="claimnpi" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" placeholder="Filled in from your listing"></label><label>Your TX licence # (optional)<input name="license" placeholder="BHV-1234"></label></div>
  <button>Claim our listing (free)</button>
  <div class="src">We match your claim to the public records (NPI, TDLR licence roster, your clinic's website domain), confirm your email, and only then change anything on your listing.</div>
</form>
<script>
(function(){
  var n=(new URLSearchParams(location.search).get("npi")||"").replace(/\D/g,"").slice(0,10);
  if(n.length!==10)return;
  var f=document.getElementById("claimnpi");f.value=n;f.readOnly=true;
  fetch("search.json").then(function(r){return r.json();}).then(function(list){
    var hit=(list||[]).find(function(x){return String(x[0]||x.npi||"")===n;});
    var name=hit?(hit[1]||hit.name):"";
    if(name){var c=document.getElementById("claimclinic");if(!c.value)c.value=name;var p=document.getElementById("claimfor");p.textContent="Claiming: "+name;p.hidden=false;}
  }).catch(function(){});
})();
</script>
</div>

<div class="card" id="featured"><h2>Featured listing — founding rate</h2>
<p class="price"><b>$${cfg.featuredPriceMonthly}/month</b>, locked for as long as you stay subscribed. Standard rate will be $${cfg.featuredPriceStandard}.</p>
<ul><li>Top placement on your city page and on the insurance pages you serve.</li>
<li>Only ${cfg.featuredSlotsPerCity} slots per city — we cap them so the page stays useful.</li>
<li>Your blurb, intake phone, and website surfaced above the fold.</li>
<li>Priority waitlist re-verification, so your availability never goes stale.</li></ul>
<p class="src">For scale: agencies report about $45 per lead on paid search for ABA, and $8–$50 a click in Texas metros. One founding slot is roughly four leads' worth of ad spend — and one enrolled client is worth tens of thousands a year.</p>
${payBlock}
<p class="src">Your card goes live automatically once we confirm your director's license is active in the TDLR roster. If it can't be verified, you're refunded in full. Cancel anytime; no contract.</p>
</div>
</div>

<div class="card"><h2>What we will never do</h2>
<ul><li><b>No pay-for-placement in the regular directory.</b> Featured slots are labeled as featured, everywhere they appear.</li>
<li><b>No per-referral or per-client fees</b>, ever — flat monthly only. That keeps us clean under federal and state anti-kickback rules for clinics with Medicaid volume, and it keeps our rankings honest.</li>
<li><b>No selling family contact data.</b> Inquiries go to the provider the family chose.</li></ul></div>`;
  return layout(`For ABA Clinics — Claim Your Listing | ${cfg.siteName}`, body, {
    desc: "Claim your ABA clinic's verified listing free, or take a founding featured slot. Flat monthly pricing, never per-referral fees.",
    canonical: "/for-clinics.html",
  });
}

function methodologyPage() {
  const matchRate = ((verifiedOrgs.length / orgs.length) * 100).toFixed(1);
  const body = `
<h1>How ${esc(cfg.siteName)} is built</h1>
<p class="lede">Everything here traces to a public record or a dated phone call. This page explains exactly where each fact comes from, and what we deliberately do not claim.</p>

<h2>Sources</h2>
<div class="card"><table>
<tr><th>Layer</th><th>Source</th><th>Refresh</th></tr>
<tr><td>Provider organizations</td><td>NPPES / NPI Registry, taxonomy 103K00000X (Behavior Analyst), organizational NPIs in Texas</td><td>Weekly</td></tr>
<tr><td>License status</td><td>Texas TDLR licensing roster published on data.texas.gov (dataset 7358-krk7) — ${licenses.length.toLocaleString()} behavior-analyst records, ${activeLicenses.length.toLocaleString()} active</td><td>Weekly</td></tr>
<tr><td>Insurance acceptance</td><td>Confirmed directly with the clinic — by phone, or through a signed one-click link we email to the clinic\'s verified address</td><td>Whenever the clinic updates it</td></tr>
<tr><td>Waitlist status</td><td>Asked directly, by phone or a one-click email; shown as current for 30 days and dropped after 90</td><td>Every 30 days (14 for featured clinics)</td></tr>
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
  return layout(`Methodology — How We Verify | ${cfg.siteName}`, body, {
    desc: "Exactly how ABA Openings compiles and verifies Texas ABA provider data: sources, license matching, refresh cadence, and what we refuse to claim.",
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
  return layout(`Texas ABA Access Report — Provider Supply and Verification | ${cfg.siteName}`, body, {
    desc: `Where Texas families can actually get ABA therapy: ${orgs.length.toLocaleString()} organizations, ${activeLicenses.length.toLocaleString()} licensed analysts, and verification rates across 20 metros.`,
    canonical: "/texas-aba-access-report.html",
  });
}

// Statewide openings page — the shareable asset for parent groups and the physician mailer.
function citiesPage() {
  const byLetter = new Map();
  for (const c of [...cities].sort((a, b) => a.city.localeCompare(b.city))) {
    const k = c.city[0].toUpperCase();
    if (!byLetter.has(k)) byLetter.set(k, []);
    byLetter.get(k).push(c);
  }
  const body = `
<nav class="crumbs"><a href="index.html">Home</a> › All cities</nav>
<h1>ABA providers in every Texas city</h1>
<p class="lede">${orgs.length.toLocaleString()} ABA organizations across ${cities.length} cities, from the federal NPI registry. Pick a city to see its clinics, with confirmed openings first.</p>
<p class="letters">${[...byLetter.keys()].map((k) => `<a href="#l-${k}">${k}</a>`).join("")}</p>
${[...byLetter.entries()].map(([k, list]) => `<h2 id="l-${k}">${k}</h2>
<div class="grid dense">${list.map((c) => {
    const n = orgs.filter((o) => o.city_slug === c.city_slug && availState(o.site_key).countable).length;
    return `<a class="tile card" href="tx/${c.city_slug}/index.html"><b>${esc(c.city)}</b><span>${c.n} provider${c.n === 1 ? "" : "s"}${n ? ` · <strong>${n} accepting</strong>` : ""}</span></a>`;
  }).join("")}</div>`).join("")}`;
  return layout(`ABA Therapy Providers in Every Texas City | ${cfg.siteName}`, body, {
    desc: `Browse ${orgs.length.toLocaleString()} Texas ABA therapy providers across ${cities.length} cities, with license verification and confirmed openings.`,
    canonical: "/cities.html",
  });
}

function verifiedPage() {
  const byCity = new Map();
  for (const o of [...verifiedOrgs].sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name))) {
    if (!byCity.has(o.city)) byCity.set(o.city, []);
    byCity.get(o.city).push(o);
  }
  const top = [...byCity.entries()].sort((a, b) => b[1].length - a[1].length);
  const body = `
<nav class="crumbs"><a href="index.html">Home</a> › License-verified clinics</nav>
<h1>Texas ABA clinics with a license-verified director</h1>
<p class="lede">${verifiedOrgs.length} of ${orgs.length.toLocaleString()} organizations have a clinical director we matched to an active behavior-analyst license in the Texas TDLR roster, each stamped with the date we checked. The rest are not necessarily unlicensed — usually the names just didn't match cleanly, so we don't claim either way.</p>
<p class="letters">${top.slice(0, 12).map(([city, rows]) => `<a href="#c-${esc(rows[0].city_slug)}">${esc(city)} (${rows.length})</a>`).join("")}</p>
${[...byCity.entries()].map(([city, rows]) => `<h2 id="c-${esc(rows[0].city_slug)}">${esc(city)} <span class="src">(${rows.length})</span></h2>
${providerList(rows, "")}`).join("")}`;
  return layout(`License-Verified ABA Clinics in Texas | ${cfg.siteName}`, body, {
    desc: `${verifiedOrgs.length} Texas ABA clinics whose clinical director holds an active, verified TDLR behavior-analyst license.`,
    canonical: "/verified.html",
  });
}

function openingsPage() {
  const open = orgs.map((o) => ({ o, av: availState(o.site_key) }))
    .filter((r) => r.av.accepting)
    .sort((a, b) => (a.av.days ?? 999) - (b.av.days ?? 999));
  const byCity = new Map();
  for (const r of open) {
    if (!byCity.has(r.o.city)) byCity.set(r.o.city, []);
    byCity.get(r.o.city).push(r);
  }
  const checkedCount = orgs.filter((o) => availState(o.site_key).tier !== "none").length;
  const answered = orgs.filter((o) => availState(o.site_key).tier !== "none")
    .sort((a, b) => (availState(a.site_key).days ?? 999) - (availState(b.site_key).days ?? 999));
  const body = `
<h1>Texas ABA clinics accepting new clients</h1>
<p class="lede">Every clinic below told us directly that they can take new clients, and every entry is dated. We re-ask every 30 days and retire any answer we cannot re-confirm — an old "yes" is worse than no answer at all when you are the one making the calls.</p>

<div class="stats">
  <div class="stat"><b>${open.length}</b><span>clinics with confirmed openings</span></div>
  <div class="stat"><b>${byCity.size}</b><span>cities with an opening</span></div>
  <a class="stat" href="#answered"><b>${checkedCount}</b><span>of ${orgs.length.toLocaleString()} clinics asked so far</span><em>See who answered →</em></a>
</div>

${open.length === 0 ? `<div class="notice"><b>We have not confirmed any openings yet.</b> Availability is collected by calling clinics one at a time, and we are early in that work — so this page is empty rather than padded with guesses. Set an alert below and you will hear the moment that changes.</div>` : ""}

${[...byCity.entries()].map(([city, rows]) => `
<h2>${esc(city)} <span class="src">(${rows.length})</span></h2>
${providerList(rows.map((r) => r.o), "")}`).join("")}

<h2 id="answered">Every clinic that has answered <span class="src">(${answered.length})</span></h2>
${answered.length
    ? `<p class="src">Openings above, plus clinics that told us they are full or whose answer is getting old — so you can see who has been asked, not just who said yes.</p>${providerList(answered, "")}`
    : `<div class="notice">No clinic has answered yet. We are early in asking — this list fills in as clinics reply, each answer dated.</div>`}

${alertSignup(null, null, 0)}

<div class="card"><h2>How this list stays honest</h2>
<ul><li><b>Dated, not assumed.</b> Every entry shows when we last confirmed it, in plain language.</li>
<li><b>Openings expire.</b> After 30 days an answer stops counting as current; after 90 we drop the claim entirely and ask again.</li>
<li><b>Empty beats wrong.</b> If we have not asked a city yet, this page says so instead of guessing.</li>
<li><b>Clinics cannot buy their way onto this list.</b> Featured placement is labeled and sold separately; it never changes whether a clinic appears here.</li></ul></div>`;
  return layout(`Texas ABA Clinics Accepting New Clients | ${cfg.siteName}`, body, {
    desc: `${open.length} Texas ABA clinics confirmed to be accepting new clients, each dated and re-checked every 30 days.`,
    canonical: "/openings.html",
  });
}


// Response page for the buttons in clinic emails. Opening the link changes nothing: the page
// shows the answer the button stands for and records it only when a person presses Confirm.
// Corporate mail scanners (Microsoft Defender Safe Links, Mimecast, Proofpoint…) open — and
// often run the scripts on — every link in an email before the recipient sees it; when this page
// posted on load, a scanner "answered" both Accepting and Full for one clinic within 3 seconds
// (2026-09-30). The token's answer is read here only for display; the signature is checked
// when the response is applied, so a forged link still changes nothing.
function respondPage() {
  const body = `
<h1 id="hd">Confirm your answer</h1>
<p class="lede" id="msg">One moment.</p>
<div id="ask" hidden><p><button class="btn" id="go" type="button">Confirm</button></p>
  <p class="src">Nothing is recorded until you press the button.</p></div>
<div class="card" id="detail" hidden>
  <p><b>Thank you</b> — your listing will show this within the hour, stamped with today's date.</p>
  <p class="src">We ask again in about a month. Families filter for clinics that can actually take a new client, so an up-to-date answer means fewer wasted calls for your intake team — and no calls at all when you're full.</p>
  <p><a class="btn" href="index.html">See the directory</a></p>
</div>
<div class="card" id="oops" hidden>
  <p><b>That link didn't work.</b> It may have expired, or been copied incompletely.</p>
  <p>Email <a href="mailto:${esc(cfg.correctionsEmail)}">${esc(cfg.correctionsEmail)}</a> with your clinic name and whether you're accepting clients, and we'll update it by hand.</p>
</div>
<script>
(function(){
  ${TOKEN_GRAB}
  var ASK={
    "accepting":["Yes, we're accepting new clients","Your listing will show families that you have room."],
    "full":["We're full right now","Your listing will show families that your waitlist is closed."],
    "claim-confirm":["Confirm this is my email address","This continues the claim on your listing."],
    "claim-approve":["Approve this claim","The clinic will be marked as claimed and emailed."],
    "claim-reject":["Reject this claim","The claimant will be told politely; nothing on the listing changes."]
  };
  var DONE={
    "accepting":["Marked as accepting new clients","Families searching your city will see that you have room within the hour.",1],
    "full":["Marked as full","We will show your waitlist as closed, so families do not call for a slot you cannot fill.",1],
    "claim-confirm":["Email confirmed","Thanks. We do a final review of every claim, usually the same day, and will email you when your listing is yours.",0],
    "claim-approve":["Claim approved","Publishing now; the clinic has been emailed.",0],
    "claim-reject":["Claim rejected","The claimant has been told politely. Nothing on the listing changed.",0]
  };
  var hd=document.getElementById("hd"),msg=document.getElementById("msg");
  function show(id){document.getElementById(id).hidden=false;}
  function fail(){hd.textContent="That link didn't work";msg.textContent="";document.getElementById("ask").hidden=true;show("oops");}
  var a="";try{a=JSON.parse(atob(t.split(".")[0].replace(/-/g,"+").replace(/_/g,"/"))).a||"";}catch(e){}
  var q=ASK[a]; if(!t||!q){fail();return;}
  hd.textContent=q[0]+"?"; msg.textContent=q[1]; show("ask");
  var go=document.getElementById("go"); go.textContent="Confirm: "+q[0];
  go.addEventListener("click",function(){
    go.disabled=true; go.textContent="Saving…";
    fetch("/api/submit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"respond",t:t})})
      .then(function(r){return r.json();})
      .then(function(r){
        var m=r&&r.ok&&DONE[r.action]; if(!m){fail();return;}
        document.getElementById("ask").hidden=true; hd.textContent=m[0]; msg.textContent=m[1];
        if(m[2]) show("detail");
      }).catch(fail);
  });
})();
</script>`;
  return layout(`Confirm your answer | ${cfg.siteName}`, body, { canonical: "/respond.html", noindex: true, noReferrer: true });
}

const TOKEN_GRAB = `var t=new URLSearchParams(location.search).get("t")||"";if(t&&history.replaceState)history.replaceState(null,"",location.pathname);`;

// Clinic insurance form, reached only from the "Update our insurance plans" email button.
// The signed token (action "insurance", one clinic, 45-day expiry) is the only credential:
// checked by /api/submit before the form shows and again on the Mac before anything is written.
// Everything rendered from the network goes through textContent — never innerHTML.
function insurancePage() {
  const body = `
<h1 id="hd">Update your insurance plans</h1>
<p class="lede" id="msg">Checking your link…</p>
<form class="card form" id="f" hidden>
  <p><b id="clinic"></b></p>
  <p class="src">Tick every plan you currently accept for new clients. Unticked plans will show as <b>not accepted</b>, dated today.</p>
  <div class="plans">${Object.entries(PAYERS).map(([k, v]) => `<label class="chk"><input type="checkbox" name="accepted" value="${esc(k)}"> ${esc(v)}</label>`).join("")}</div>
  <button type="submit" id="go">Save our plans</button>
  <div class="src">Families see "Accepted — confirmed with the clinic" and the date. Always free; no login.</div>
</form>
<div class="card" id="oops" hidden>
  <p><b>That link didn't work.</b> It may have expired or been copied incompletely.</p>
  <p>Email <a href="mailto:${esc(cfg.correctionsEmail)}">${esc(cfg.correctionsEmail)}</a> with your clinic name and the plans you accept, and we'll update it for you.</p>
</div>
<script>
(function(){
  ${TOKEN_GRAB}
  var $=function(id){return document.getElementById(id);};
  function fail(){$("hd").textContent="That link didn't work";$("msg").textContent="";$("f").hidden=true;$("oops").hidden=false;}
  function post(body){return fetch("/api/submit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();});}
  if(!t){fail();return;}
  post({kind:"insurance-check",t:t}).then(function(r){
    if(!r||!r.ok||!/^\\d{10}$/.test(r.npi||"")){fail();return;}
    $("msg").textContent="One step: tick the plans you take and save. Your listing updates within the hour.";
    $("f").hidden=false;
    fetch("/providers/"+r.npi+".html").then(function(x){return x.ok?x.text():"";}).then(function(h){
      var n=h&&new DOMParser().parseFromString(h,"text/html").querySelector("h1");
      $("clinic").textContent=n?n.textContent:"NPI "+r.npi;
    }).catch(function(){});
    fetch("/payers.json").then(function(x){return x.json();}).then(function(all){
      var cur=all[r.npi]||{};
      Array.prototype.forEach.call(document.querySelectorAll('input[name="accepted"]'),function(c){c.checked=cur[c.value]==="verified_yes";});
    }).catch(function(){});
  }).catch(fail);
  $("f").addEventListener("submit",function(e){
    e.preventDefault();$("go").disabled=true;$("go").textContent="Saving…";
    var acc=Array.prototype.map.call(document.querySelectorAll('input[name="accepted"]:checked'),function(c){return c.value;});
    post({kind:"insurance",t:t,accepted:acc}).then(function(r){
      if(!r||!r.ok){fail();return;}
      $("f").hidden=true;$("hd").textContent="Thank you — plans saved";
      $("msg").textContent=acc.length?"Your listing will show these as confirmed within the hour.":"Your listing will show that you don't take any of the listed plans, within the hour.";
    }).catch(function(){$("go").disabled=false;$("go").textContent="Save our plans";$("msg").textContent="Couldn't save just now — please try again in a minute.";});
  });
})();
</script>`;
  return layout(`Update your insurance plans | ${cfg.siteName}`, body, { canonical: "/insurance.html", noindex: true, noReferrer: true });
}

function unsubscribePage() {
  const body = `
<h1>Unsubscribe</h1>
<p class="lede">Enter the address that receives the alerts and we will stop them. No confirmation email, no "are you sure" — one submit and it is done.</p>
${formOpen("unsubscribe")}
  <label>Email address<input name="email" type="email" id="e" required></label>
  <button>Stop sending me alerts</button>
  <div class="src">We keep the address only on a suppression list, so nothing starts it again by accident.</div>
</form>
<script>var e=new URLSearchParams(location.search).get('e'); if(e){document.getElementById('e').value=e;}</script>`;
  return layout(`Unsubscribe | ${cfg.siteName}`, body, { canonical: "/unsubscribe.html" });
}

const thanksPage = () => layout(`Thank you | ${cfg.siteName}`, `
<h1 id="hd">Got it — thank you</h1>
<p class="lede" id="msg">Your message is on its way. If you asked a provider about availability, we've passed it to them and emailed you a copy.</p>
<script>(function(){var q=new URLSearchParams(location.search),h=document.getElementById("hd"),m=document.getElementById("msg");
if(q.get("claim")){h.textContent="Check your email";m.textContent="We've checked your license against the Texas roster and sent you a link to confirm your email address. Click it to finish claiming your listing.";}
else if(q.get("unsub")){h.textContent="You're unsubscribed";m.textContent="We won't send you any more alerts.";}
else if(q.get("missing")){h.textContent="Something was missing";m.textContent="Please go back and fill in the required fields.";}})();</script>
<p><a class="btn" href="index.html">Back to the directory</a></p>`, { canonical: "/thanks.html" });

const notFoundPage = () => layout("Page not found | ${cfg.siteName}", `
<h1>That page doesn't exist</h1>
<p class="lede">It may have moved, or a provider record may have been retired.</p>
<p><a class="btn" href="/index.html">Back to the directory</a> <a class="btn ghost" href="/lookup.html">License lookup</a></p>`);

// ---------- css ----------
const CSS = `:root{--ink:#182529;--soft:#4f6167;--faint:#87979c;--accent:#0d6b5b;--accent-d:#0a5347;--accent-bg:#e5f1ee;
--ok:#0d6b5b;--ok-bg:#e5f1ee;--warn:#8a5a15;--warn-bg:#f7edda;--bad:#94413a;--bad-bg:#f6e5e2;--mut:#5d6d72;--mut-bg:#edf0f0;
--rule:#dde5e3;--bg:#fbfcfb;--card:#fff;--feat:#7a5b12;--feat-bg:#faf1d8;--shadow:0 1px 2px rgba(24,37,41,.05),0 2px 8px rgba(24,37,41,.04);--shadow-lg:0 12px 32px rgba(24,37,41,.14);--viz:#0a8a6c;--land:#eef4f2;--hero:linear-gradient(160deg,#e5f1ee 0%,#fbfcfb 60%)}
@media(prefers-color-scheme:dark){:root{--ink:#e7ecea;--soft:#a9b7b8;--faint:#7d8c8f;--accent:#5fbfa8;--accent-d:#7fd0bb;--accent-bg:#12302a;
--ok:#5fbfa8;--ok-bg:#12302a;--warn:#d6ab5f;--warn-bg:#2f2716;--bad:#d1867c;--bad-bg:#331f1d;--mut:#9aa8ab;--mut-bg:#212a2c;
--rule:#2c3739;--bg:#12181a;--card:#182022;--feat:#d9b976;--feat-bg:#2b2515;--shadow:0 1px 2px rgba(0,0,0,.25);--shadow-lg:0 14px 36px rgba(0,0,0,.45);--viz:#22a883;--land:#1a2426;--hero:linear-gradient(160deg,#153029 0%,#12181a 65%)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:68rem;margin:0 auto;padding:0 1.1rem}
a{color:var(--accent-d)}
header.top{background:var(--card);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:5}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-top:.7rem;padding-bottom:.7rem;flex-wrap:wrap}
.brand{font-weight:800;font-size:1.15rem;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.brand span{color:var(--accent);margin-left:.25rem}
header nav{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
header nav a{font-size:.9rem;text-decoration:none;color:var(--soft)}header nav a:hover{color:var(--accent-d)}
header nav a.cta{background:var(--accent);color:#fff;padding:.35rem .75rem;border-radius:5px;font-weight:600}
main{padding-bottom:3rem}
h1{font-size:clamp(1.6rem,4vw,2.3rem);line-height:1.15;letter-spacing:-.02em;margin:1.6rem 0 .5rem;text-wrap:balance}
h2{font-size:1.25rem;letter-spacing:-.01em;margin:2rem 0 .7rem}
h3{font-size:1.02rem;margin:0 0 .35rem}
.lede{font-size:1.05rem;color:var(--soft);margin:0 0 1.2rem;max-width:44rem}
p{margin:0 0 .9rem}ul{margin:0 0 .9rem;padding-left:1.1rem}li{margin-bottom:.35rem}
.card{background:var(--card);border:1px solid var(--rule);border-radius:9px;padding:1.1rem;margin:.7rem 0}
.card.highlight{border-color:var(--accent);border-width:1px}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr));gap:.7rem}
.grid>.card,.grid>a.card{margin:0}
.grid.dense{grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))}
@media(max-width:34rem){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.grid.two{grid-template-columns:1fr}}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(20rem,1fr))}
a.tile{text-decoration:none;color:var(--ink);display:flex;flex-direction:column;gap:.15rem}
a.tile{position:relative;transition:border-color .15s,transform .15s}
a.tile:hover{border-color:var(--accent);transform:translateY(-1px)}a.tile span{color:var(--faint);font-size:.85rem}
a.tile strong{color:var(--ok);font-weight:600}
a.tile::after{content:"→";position:absolute;right:1rem;top:50%;transform:translateY(-50%);color:var(--faint);transition:color .15s,right .15s}
a.tile:hover::after{color:var(--accent-d);right:.8rem}
.more{margin:.8rem 0 0;font-size:.92rem}.more a{font-weight:600;text-decoration:none}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.7rem;margin:1.2rem 0}
.stats .stat{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--rule);border-radius:9px;padding:.9rem;text-decoration:none;color:var(--ink)}
a.stat{transition:border-color .15s,transform .15s}a.stat:hover{border-color:var(--accent);transform:translateY(-1px)}
.stats em{font-style:normal;font-size:.8rem;font-weight:600;color:var(--accent-d);margin-top:auto;padding-top:.45rem}
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
.crumbs{font-size:.85rem;color:var(--faint);margin-top:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crumbs a{color:var(--soft)}
.chips{display:flex;flex-wrap:wrap;gap:.4rem;margin:.9rem 0}
.chip{font-size:.82rem;text-decoration:none;background:var(--card);border:1px solid var(--rule);padding:.3rem .65rem;border-radius:99px;color:var(--soft)}
.chip:hover{border-color:var(--accent);color:var(--accent-d)}
.chip.open{border-color:var(--accent);color:var(--accent-d);font-weight:600;background:var(--accent-bg)}
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
.fh{margin-bottom:.4rem}.fh .src{font-weight:400;font-size:.8rem}
.feat{border-color:var(--feat);background:linear-gradient(180deg,var(--feat-bg),var(--card) 55%);display:flex;flex-direction:column;gap:.45rem}
.feat-top{display:flex;flex-wrap:wrap}.feat-top .badge{margin:0 .3rem 0 0}
.feat-name{font-size:1.1rem;font-weight:700;text-decoration:none;color:var(--ink);line-height:1.3}.feat-name:hover{color:var(--accent-d)}
.feat-blurb{margin:0;color:var(--soft)}.feat-status .badge{margin:0}
.feat-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:auto;padding-top:.3rem}.feat-actions .btn{margin-top:0;padding:.45rem .85rem;font-size:.92rem}
.grid.feats{grid-template-columns:repeat(auto-fill,minmax(min(18rem,100%),1fr))}
.claimed{border-color:var(--accent)}
.notice{background:var(--warn-bg);border:1px solid var(--rule);border-radius:8px;padding:.7rem .9rem;font-size:.9rem}
.chart{display:flex;gap:.4rem;align-items:flex-end;height:11rem;padding-top:1rem}
.chart .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;position:relative}
.chart .bar span{display:block;width:100%;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px}
.chart .bar em{font-style:normal;font-size:.7rem;color:var(--faint);margin-top:.3rem}
.chart .bar b{position:absolute;top:-1rem;font-size:.7rem;color:var(--soft);font-variant-numeric:tabular-nums}
.lookup-out{margin-top:.8rem;max-height:26rem;overflow:auto}
label.wide{display:block;font-size:.88rem;color:var(--soft)}
.finder{display:flex;gap:.7rem;align-items:flex-end;flex-wrap:wrap}
.finder label{font-size:.85rem;color:var(--soft);flex:1;min-width:11rem}
/* One control height for the whole row so dropdowns, the checkbox and the button share a baseline */
.finder select{height:2.75rem;margin-top:.3rem}
.finder button{margin-top:0;height:2.75rem;padding:0 1.3rem}
.finder label.chk{display:flex;align-items:center;gap:.5rem;flex:0 0 auto;min-width:0;white-space:nowrap;height:2.75rem;padding:0 .9rem;border:1px solid var(--rule);border-radius:6px;background:var(--bg);color:var(--ink);cursor:pointer}
.finder label.chk:hover{border-color:var(--accent)}
.finder label.chk input{width:1rem;height:1rem;margin:0;accent-color:var(--accent)}
@media(max-width:34rem){.finder label.chk,.finder button{flex:1 1 100%;justify-content:center}}

/* ---- 2026-09 redesign ---- */
html{scroll-behavior:smooth;scroll-padding-top:5.5rem}
body{font-size:16.5px;line-height:1.65}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px;top:.5rem;background:var(--accent);color:#fff;padding:.4rem .8rem;border-radius:6px;z-index:20}.skip:focus{left:.5rem}
header.top{background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px)}
header.top .bar{display:flex;align-items:center;gap:1.1rem;padding-top:.6rem;padding-bottom:.6rem;flex-wrap:nowrap}
.brand{display:inline-flex;align-items:center;gap:.1rem;flex:0 0 auto}
.brand .mark{display:inline-grid;place-items:center;width:1.7rem;height:1.7rem;margin-right:.45rem;border-radius:7px;background:var(--accent);color:#fff;font-size:.95rem;font-weight:800}
nav.primary{display:flex;align-items:center;gap:.2rem;margin-left:.6rem}
nav.primary a,nav.primary summary{font-size:.92rem;color:var(--soft);text-decoration:none;padding:.4rem .65rem;border-radius:7px;cursor:pointer;list-style:none}
nav.primary summary::-webkit-details-marker{display:none}nav.primary summary::after{content:"▾";font-size:.75em;margin-left:.3rem}
nav.primary a:hover,nav.primary summary:hover{background:var(--accent-bg);color:var(--accent-d)}
nav.primary a[aria-current]{color:var(--accent-d);background:var(--accent-bg);font-weight:600}
details.more{position:relative;display:flex;align-items:center;margin:0}
nav.primary>a,nav.primary summary{display:inline-flex;align-items:center;height:2.1rem;margin:0;line-height:1}
details.more .menu{position:absolute;top:calc(100% + .4rem);left:0;min-width:13rem;background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:.35rem;box-shadow:var(--shadow-lg);z-index:30;display:flex;flex-direction:column}
details.more .menu a{padding:.5rem .7rem}
.sitesearch{position:relative}
.sitesearch input{margin:0}
.hsearch{flex:1;max-width:17rem;margin-left:auto}
.hsearch input{padding:.42rem .7rem .42rem 2rem;font-size:.9rem;border-radius:99px;background:var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%2387979c' stroke-width='2'%3E%3Ccircle cx='7' cy='7' r='5'/%3E%3Cpath d='m11 11 4 4'/%3E%3C/svg%3E") no-repeat .65rem 50%}
.sitesearch .qres{position:absolute;left:0;right:0;top:calc(100% + .35rem);z-index:40;box-shadow:var(--shadow-lg);min-width:18rem}
.sitesearch.big .qres{position:static;box-shadow:none}
.sitesearch.big input{font-size:1.05rem;padding:.75rem .9rem .75rem 2.4rem;background:var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' fill='none' stroke='%2387979c' stroke-width='2'%3E%3Ccircle cx='8' cy='8' r='6'/%3E%3Cpath d='m12.5 12.5 4 4'/%3E%3C/svg%3E") no-repeat .8rem 50%}
header.top .cta{flex:0 0 auto;background:var(--accent);color:#fff;padding:.42rem .85rem;border-radius:8px;font-weight:600;font-size:.9rem;text-decoration:none}
header.top .cta:hover{background:var(--accent-d)}
details.mnav{display:none;margin-left:auto}
details.mnav summary{list-style:none;cursor:pointer;display:flex;flex-direction:column;gap:4px;padding:.55rem .5rem;border:1px solid var(--rule);border-radius:8px}
details.mnav summary::-webkit-details-marker{display:none}
details.mnav summary span{display:block;width:18px;height:2px;background:var(--ink);border-radius:2px}
details.mnav .mpanel{position:absolute;left:0;right:0;top:100%;background:var(--card);border-bottom:1px solid var(--rule);box-shadow:var(--shadow-lg);padding:.8rem 1.1rem 1.1rem;display:flex;flex-direction:column;gap:.1rem}
details.mnav .mpanel a{padding:.6rem .2rem;border-bottom:1px solid var(--rule);color:var(--ink);text-decoration:none}
details.mnav .mpanel a[aria-current]{color:var(--accent-d);font-weight:600}
details.mnav .mpanel .btn{margin-top:.8rem;border:0;text-align:center;color:#fff}
details.mnav .sitesearch{margin-bottom:.4rem}
@media(max-width:62rem){nav.primary,.hsearch{display:none}details.mnav{display:block}header.top .bar{gap:.6rem}header.top .cta{margin-left:auto}details.mnav{margin-left:0}}
@media(max-width:26rem){header.top .cta{display:none}details.mnav{margin-left:auto}}
.page-head{margin:1rem 0 1.4rem;padding:1.3rem 1.5rem 1.4rem;border:1px solid var(--rule);border-radius:14px;background:var(--hero)}
.page-head .crumbs{margin:0 0 .3rem}.page-head h1{margin:.2rem 0 .4rem}.page-head .lede{margin-bottom:.2rem}
.head-extra{margin-top:.8rem}
.pills{display:flex;flex-wrap:wrap;gap:.4rem}
.pill{font-size:.84rem;padding:.28rem .7rem;border-radius:99px;background:var(--card);border:1px solid var(--rule);color:var(--soft)}
.pill b{color:var(--ink)}.pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--rule))}
.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}.pill.mut{color:var(--mut)}.pill.feat{color:var(--feat);border-color:var(--feat)}
.card{border-radius:12px;box-shadow:var(--shadow)}
h2{font-size:1.3rem;margin-top:2.2rem}
.chips.sticky{position:sticky;top:3.6rem;z-index:4;background:var(--bg);padding:.5rem 0;margin:.2rem 0 .6rem;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
.chips.sticky::-webkit-scrollbar{display:none}.chips.sticky .chip{white-space:nowrap}
.listhead{display:flex;align-items:flex-end;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:1.6rem}
.listhead h2{margin:0}.filterbox{flex:0 1 20rem}.filterbox input{margin:0;border-radius:99px;padding:.45rem .9rem}
.list{box-shadow:var(--shadow);border-radius:12px}
.sectnav{position:sticky;top:3.6rem;z-index:4;display:flex;gap:.3rem;overflow-x:auto;scrollbar-width:none;background:var(--bg);padding:.45rem 0;margin:-.4rem 0 .4rem;border-bottom:1px solid var(--rule)}
.sectnav a{white-space:nowrap;font-size:.88rem;text-decoration:none;color:var(--soft);padding:.35rem .75rem;border-radius:99px}
.sectnav a:hover{background:var(--accent-bg);color:var(--accent-d)}
.pgrid{display:grid;grid-template-columns:minmax(0,1fr) 20rem;gap:1.4rem;align-items:start}
.pmain>h2:first-child{margin-top:1rem}
.pside{position:sticky;top:7rem;display:flex;flex-direction:column;gap:.8rem;margin-top:1rem}
.pside .summary{flex-direction:column;align-items:stretch;margin:0}
.pside .summary-actions{flex-direction:column}.pside .summary-actions .btn{text-align:center}
.side-claim{margin:0}.side-claim p{font-size:.9rem;color:var(--soft);margin:.3rem 0 .6rem}.side-claim .btn{margin:0}
@media(max-width:56rem){.pgrid{grid-template-columns:1fr}.pside{position:static;order:-1;margin-top:.4rem}}
footer.site{border-top:1px solid var(--rule);margin-top:3.5rem;padding:2.2rem 0 2.5rem;background:var(--card)}
.fcols{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:1.5rem}
.fcols p{font-size:.88rem;color:var(--soft);margin-top:.6rem;max-width:22rem}
.fcols h4{margin:0 0 .5rem;font-size:.78rem;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.fcols a:not(.brand){display:block;font-size:.9rem;color:var(--soft);text-decoration:none;padding:.18rem 0}.fcols a:not(.brand):hover{color:var(--accent-d)}
footer.site .fine{margin-top:1.6rem;padding-top:1.1rem;border-top:1px solid var(--rule);font-size:.8rem;color:var(--faint)}
footer.site .fine p{margin:0 0 .5rem}
@media(max-width:46rem){.fcols{grid-template-columns:1fr 1fr}.fcols>div:first-child{grid-column:1/-1}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
.list{background:var(--card);border:1px solid var(--rule);border-radius:9px;overflow:hidden;margin:.7rem 0}
.list a.item{display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.8rem 1rem;text-decoration:none;color:var(--ink);border-top:1px solid var(--rule)}
.list a.item:first-child{border-top:0}.list a.item:hover{background:var(--accent-bg)}
.item-main{display:flex;flex-direction:column;min-width:0}.item-main b{color:var(--accent-d)}
.item .meta{font-size:.82rem;color:var(--faint)}.item .badges{flex:0 0 auto;text-align:right}.item .badge{margin:.15rem 0 .15rem .3rem}
@media(max-width:40rem){.list a.item{flex-direction:column;align-items:flex-start;gap:.35rem}.item .badges{text-align:left}.item .badge{margin:0 .3rem .2rem 0}}
.summary{display:flex;gap:1rem;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:1rem}
.summary .label{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:700}
.summary .status{display:inline-block;font-size:1.15rem;font-weight:700;margin:.15rem 0 .4rem}
.status.ok{color:var(--ok)}.status.warn{color:var(--warn)}.status.bad{color:var(--bad)}.status.mut{color:var(--mut)}
.summary-actions{display:flex;gap:.5rem;flex-wrap:wrap}.summary-actions .btn{margin-top:0}
.btn.ghost{border-color:var(--accent)}
.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:1.5rem;align-items:center;margin:1.2rem 0 .4rem;padding:1.6rem;border:1px solid var(--rule);border-radius:14px;background:var(--hero)}
.hero h1{margin-top:.2rem}.hero .lede{margin-bottom:1rem}
.eyebrow{font-size:.78rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--accent-d);margin:0}
.hero-cta{display:flex;gap:.6rem;flex-wrap:wrap}.hero-cta .btn{margin-top:0;display:inline-block}
.txmap{margin:0;position:relative}.txmap svg{width:100%;height:auto;display:block}
.txmap .tx{fill:var(--land);stroke:var(--rule);stroke-width:1.5;stroke-linejoin:round}
.txmap .dot circle{fill:var(--viz);fill-opacity:.85;stroke:var(--card);stroke-width:2;transition:fill-opacity .15s}
.txmap .dot circle.hit{fill:transparent;stroke:none}
.txmap .dot:hover circle:first-child,.txmap .dot:focus circle:first-child{fill-opacity:1;stroke:var(--ink)}
.txmap .dot:focus{outline:none}
.txmap .lbl{font-size:12px;font-weight:600;fill:var(--soft);paint-order:stroke;stroke:var(--card);stroke-width:3px;pointer-events:none}
.txmap figcaption{font-size:.8rem;color:var(--faint);margin-top:.4rem;text-align:center}
.maptip{position:absolute;transform:translate(-50%,calc(-100% - 8px));background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:.3rem .55rem;font-size:.82rem;white-space:nowrap;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.18);color:var(--ink)}
@media(max-width:46rem){.hero{grid-template-columns:1fr;padding:1.1rem}.txmap{max-width:26rem;margin:0 auto}}
.search{display:block;font-size:.85rem;color:var(--soft);margin-bottom:.2rem}
.search input{font-size:1.05rem;padding:.65rem .8rem}
.qres{list-style:none;margin:.3rem 0 0;padding:0;border:1px solid var(--rule);border-radius:8px;overflow:hidden;background:var(--bg)}
.qres li{margin:0;border-top:1px solid var(--rule)}.qres li:first-child{border-top:0}
.qres a{display:flex;justify-content:space-between;gap:1rem;padding:.6rem .8rem;text-decoration:none;color:var(--ink)}
.qres a:hover,.qres a:focus{background:var(--accent-bg)}.qres b{color:var(--accent-d);font-weight:600}.qres span{color:var(--faint);font-size:.85rem;white-space:nowrap}
.qres li.none{padding:.6rem .8rem;color:var(--faint);font-size:.9rem}
.or{margin:.8rem 0 .2rem}
.plans{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.2rem .8rem;margin:.6rem 0}
.plans label.chk{display:flex;align-items:center;gap:.5rem;font-size:.95rem;color:var(--ink);margin:.35rem 0}
.plans input{width:auto;margin:0}
.letters{display:flex;flex-wrap:wrap;gap:.35rem .8rem;font-size:.92rem}.letters a{text-decoration:none;font-weight:600}
@media(max-width:34rem){header.top .wrap{gap:.4rem}header nav{gap:.25rem .8rem;width:100%}header nav a.cta{margin-left:auto}}
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
w("openings.html", openingsPage()); count++;
w("cities.html", citiesPage()); count++;
w("verified.html", verifiedPage()); count++;
w("respond.html", respondPage()); count++;
w("insurance.html", insurancePage()); count++;
w("search.json", JSON.stringify(orgs.map((o) => [o.npi, o.name, o.city])));
// Confirmed plans only (the same facts the provider pages already show), for the insurance form.
{
  const confirmed = {};
  for (const [site, rows] of payersBySite)
    for (const r of rows) if (r.status !== "unverified") (confirmed[site] ??= {})[r.payer] = r.status;
  w("payers.json", JSON.stringify(confirmed));
}
w("featured-thanks.html", layout(`You're featured | ${cfg.siteName}`, `
<h1>Thank you — you're almost live</h1>
<p class="lede">We're checking your director's license against the Texas roster now. Once it's confirmed your featured card goes live automatically, usually within the hour, and we'll email you. If it can't be verified, you're refunded in full.</p>
<p><a class="btn" href="for-clinics.html">Back to For clinics</a></p>`, { canonical: "/featured-thanks.html" })); count++;
// docs/ is the Vercel root, so the serverless functions ship inside it (api/_* are helpers, not routes).
mkdirSync(new URL("api/", OUT), { recursive: true });
for (const f of readdirSync(new URL("api/", root)).filter((n) => n.endsWith(".mjs")))
  copyFileSync(new URL(`api/${f}`, root), new URL(`api/${f}`, OUT));
w("unsubscribe.html", unsubscribePage()); count++;
w("404.html", notFoundPage()); count++;

// compact license index for client-side lookup: [NAME, LIC, type, status, expires]
w("licenses.json", JSON.stringify(licenses.map((l) => [
  l.name, l.license_no, l.license_type?.includes("Assistant") ? "A" : "L", l.status === "active" ? "a" : "x", l.expires ?? "",
])));

const urls = ["/", "/openings.html", "/cities.html", "/verified.html", "/lookup.html", "/for-clinics.html", "/methodology.html", "/texas-aba-access-report.html"];
for (const c of cities) {
  mkdirSync(new URL(`tx/${c.city_slug}/`, OUT), { recursive: true });
  w(`tx/${c.city_slug}/index.html`, cityPage(c)); count++;
  urls.push(`/tx/${c.city_slug}`);
  w(`tx/${c.city_slug}/accepting-now.html`, cityPage(c, null, true)); count++;
  urls.push(`/tx/${c.city_slug}/accepting-now.html`);
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
// IndexNow ownership key, shared with the directory network (factory/engine/indexnow.mjs).
w("8638c5397484efc819f14077791423ee.txt", "8638c5397484efc819f14077791423ee");
w("robots.txt", `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ""}`);

// docs/ IS the Vercel deploy root (Root Directory = docs), so this config lives here.
// Keeping it inside the generated output means the deployed tree is always self-describing.
w("vercel.json", JSON.stringify({
  $schema: "https://openapi.vercel.sh/vercel.json",
  cleanUrls: false,
  trailingSlash: false,
  headers: [
    { source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Clickjacking: nothing on this site may be framed, least of all the one-click pages.
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    ]},
    { source: "/(respond|insurance).html", headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
    ]},
    { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    { source: "/style.css", headers: [{ key: "Cache-Control", value: "public, max-age=3600" }] },
    { source: "/licenses.json", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] },
    { source: "/search.json", headers: [{ key: "Cache-Control", value: "public, max-age=3600" }] },
  ],
}, null, 2));

console.log(`Generated ${count} pages in docs/`);
console.log(`  ${orgs.length} providers · ${cities.length} cities · ${urls.length} sitemap URLs`);
console.log(`  license-verified: ${verifiedOrgs.length} (${((verifiedOrgs.length / orgs.length) * 100).toFixed(1)}%)`);
if (!cfg.domain) console.log("  NOTE: site.config.json domain is empty — canonicals/sitemap URLs are relative.");
if (!cfg.stripeFeaturedLink) console.log("  NOTE: no Stripe link configured — featured CTA falls back to email.");

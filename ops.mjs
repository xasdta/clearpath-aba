// Verification console — the tool that produces the openings data.
// Local only, no auth, never deployed. Run: npm run ops -> http://localhost:8430
//
// Designed for speed: one clinic per screen, click-to-call, single-key answers, auto-advance.
// A full call is ~45 seconds: dial, ask two questions, press one key.
//
// Queue priority: biggest metros first, license-verified first (best sales prospects),
// never-asked before re-asks, and anything past its retry date.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { openDb, today, nowIso, addDays } from "./lib/db.mjs";

const db = openDb();
const cfg = JSON.parse(readFileSync(new URL("./site.config.json", import.meta.url)));
const PORT = 8430;
const FRESH_DAYS = 30;
const PAYERS = {
  aetna: "Aetna", "bcbs-texas": "BCBS TX", cigna: "Cigna",
  unitedhealthcare: "UHC", "texas-medicaid": "TX Medicaid", tricare: "TRICARE",
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- queue ----------
// Sites needing a call: no availability record, or one older than FRESH_DAYS,
// and not deferred by a recent no-answer.
const QUEUE_SQL = `
  SELECT s.site_key, s.address1, s.city, s.city_slug, s.zip, s.phone,
         o.npi, o.name, o.ao_name, o.ao_license_status, o.ao_license_no,
         (SELECT COUNT(*) FROM sites s2 WHERE s2.city_slug = s.city_slug AND s2.active=1) city_size,
         a.as_of last_asked, a.accepting last_accepting,
         (SELECT COUNT(*) FROM ops.call_log cl WHERE cl.site_key = s.site_key) attempts
  FROM sites s
  JOIN organizations o ON o.npi = s.org_npi
  LEFT JOIN (
    SELECT site_key, as_of, accepting,
           ROW_NUMBER() OVER (PARTITION BY site_key ORDER BY as_of DESC, id DESC) rn
    FROM ops.availability
  ) a ON a.site_key = s.site_key AND a.rn = 1
  WHERE s.active = 1 AND o.active = 1 AND s.phone IS NOT NULL AND s.phone != ''
    AND (a.as_of IS NULL OR julianday('now') - julianday(a.as_of) > ${FRESH_DAYS})
    AND NOT EXISTS (
      SELECT 1 FROM ops.call_log cl WHERE cl.site_key = s.site_key
        AND cl.next_attempt_after IS NOT NULL AND cl.next_attempt_after > date('now')
    )
    AND NOT EXISTS (
      SELECT 1 FROM ops.call_log cl WHERE cl.site_key = s.site_key AND cl.outcome IN ('bad_number','refused')
    )
  ORDER BY city_size DESC, (o.ao_license_status = 'active') DESC, a.as_of IS NOT NULL, attempts, o.name
  LIMIT 1 OFFSET ?`;

const stats = () => ({
  total: db.prepare(`SELECT COUNT(*) c FROM sites WHERE active=1 AND phone IS NOT NULL AND phone != ''`).get().c,
  fresh: db.prepare(`SELECT COUNT(DISTINCT site_key) c FROM ops.availability WHERE julianday('now') - julianday(as_of) <= ${FRESH_DAYS}`).get().c,
  open: db.prepare(`SELECT COUNT(*) c FROM (SELECT site_key, accepting, ROW_NUMBER() OVER (PARTITION BY site_key ORDER BY as_of DESC, id DESC) rn, as_of FROM ops.availability) WHERE rn=1 AND accepting=1 AND julianday('now') - julianday(as_of) <= ${FRESH_DAYS}`).get().c,
  callsToday: db.prepare(`SELECT COUNT(*) c FROM ops.call_log WHERE date(created_at) = date('now')`).get().c,
  reachedToday: db.prepare(`SELECT COUNT(*) c FROM ops.call_log WHERE date(created_at) = date('now') AND outcome='reached'`).get().c,
});

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Verification console</title><style>
:root{--ink:#182529;--soft:#54666d;--faint:#8a979c;--accent:#0d6b5b;--ok:#0d6b5b;--okbg:#e5f1ee;--bad:#94413a;--badbg:#f6e5e2;--warn:#8a5a15;--warnbg:#f7edda;--rule:#dde5e3;--bg:#f7f9f8;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:52rem;margin:0 auto;padding:1rem}
.bar{display:flex;gap:1rem;flex-wrap:wrap;background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:.7rem 1rem;margin-bottom:1rem;font-size:.85rem}
.bar b{font-size:1.2rem;color:var(--accent);display:block;font-variant-numeric:tabular-nums}
.card{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:1.2rem;margin-bottom:1rem}
h1{font-size:1.5rem;margin:0 0 .2rem}h2{font-size:1rem;margin:1.2rem 0 .5rem;color:var(--soft)}
.meta{color:var(--soft);font-size:.9rem}
a.tel{display:inline-block;font-size:1.6rem;font-weight:700;color:var(--accent);text-decoration:none;margin:.5rem 0}
.badge{display:inline-block;font-size:.75rem;font-weight:600;padding:.15rem .5rem;border-radius:4px;margin-right:.3rem}
.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}.warn{background:var(--warnbg);color:var(--warn)}.mut{background:#eef1f0;color:var(--soft)}
.keys{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0}
.keys button{font:inherit;font-weight:600;padding:.6rem 1rem;border-radius:7px;border:1px solid var(--rule);background:#fff;cursor:pointer}
.keys button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.keys button.danger{background:#fff;border-color:var(--bad);color:var(--bad)}
kbd{font:600 .7rem ui-monospace,monospace;background:#eef1f0;border-radius:3px;padding:.05rem .3rem;margin-left:.3rem;color:var(--soft)}
label{display:block;font-size:.85rem;color:var(--soft);margin:.5rem 0 .1rem}
input,select,textarea{font:inherit;padding:.45rem .6rem;border:1px solid var(--rule);border-radius:6px;width:100%}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}
.pay{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.3rem}
.pay label{display:flex;align-items:center;gap:.3rem;background:#fff;border:1px solid var(--rule);border-radius:99px;padding:.25rem .6rem;margin:0;cursor:pointer;font-size:.85rem;color:var(--ink)}
.pay input{width:auto}
.hint{font-size:.8rem;color:var(--faint);margin-top:.8rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}td,th{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--rule)}
.script{background:#f2f6f5;border-left:3px solid var(--accent);padding:.6rem .8rem;font-size:.9rem;border-radius:0 6px 6px 0}
</style></head><body><div class="wrap">${body}</div></body></html>`;

function consolePage(offset = 0) {
  const s = stats();
  const c = db.prepare(QUEUE_SQL).get(offset);
  const bar = `<div class="bar">
    <div><b>${s.open}</b>confirmed openings</div>
    <div><b>${s.fresh}</b>fresh (&le;${FRESH_DAYS}d)</div>
    <div><b>${s.total - s.fresh}</b>need a call</div>
    <div><b>${s.callsToday}</b>calls today</div>
    <div><b>${s.reachedToday}</b>reached today</div>
    <div style="margin-left:auto"><a href="/inbox">Claims &amp; leads →</a></div>
  </div>`;
  if (!c) return page(bar + `<div class="card"><h1>Queue is clear</h1><p class="meta">Every clinic with a phone number has been asked within the last ${FRESH_DAYS} days, or is deferred. Rebuild the site with <code>npm run build</code> to publish.</p></div>`);

  const payers = db.prepare(`SELECT * FROM ops.payer_acceptance WHERE site_key = ? ORDER BY payer`).all(c.site_key);
  const prior = db.prepare(`SELECT * FROM ops.call_log WHERE site_key = ? ORDER BY created_at DESC LIMIT 3`).all(c.site_key);
  return page(bar + `
<div class="card">
  <h1>${esc(c.name)}</h1>
  <div class="meta">${esc(c.address1 ?? "")} · ${esc(c.city)}, TX ${esc(c.zip ?? "")} · NPI ${esc(c.npi)}</div>
  <div style="margin:.4rem 0">
    ${c.ao_license_status === "active" ? `<span class="badge ok">License verified · ${esc(c.ao_license_no)}</span>` : `<span class="badge mut">License not confirmed</span>`}
    ${c.last_asked ? `<span class="badge warn">Last asked ${esc(c.last_asked)}${c.last_accepting ? " (was open)" : " (was full)"}</span>` : `<span class="badge mut">Never asked</span>`}
    ${c.attempts ? `<span class="badge mut">${c.attempts} prior attempt${c.attempts === 1 ? "" : "s"}</span>` : ""}
  </div>
  <a class="tel" href="tel:${esc((c.phone ?? "").replace(/[^0-9+]/g, ""))}">${esc(c.phone)}</a>
  <div class="script">"Hi — I run a free directory of Texas ABA providers that families use to find care.
  Two quick questions: <b>are you taking new clients right now</b>, and roughly <b>how long is the wait</b>?
  And which insurance do you accept?"</div>
</div>

<form class="card" method="POST" action="/record" id="f">
  <input type="hidden" name="site_key" value="${esc(c.site_key)}">
  <input type="hidden" name="offset" value="${offset}">
  <input type="hidden" name="outcome" id="outcome" value="reached">

  <h2>Did you reach someone?</h2>
  <div class="keys">
    <button type="button" class="danger" onclick="quick('no_answer')">No answer<kbd>N</kbd></button>
    <button type="button" class="danger" onclick="quick('voicemail')">Voicemail<kbd>V</kbd></button>
    <button type="button" class="danger" onclick="quick('bad_number')">Bad number<kbd>B</kbd></button>
    <button type="button" onclick="skip()">Skip<kbd>S</kbd></button>
  </div>

  <h2>Accepting new clients?</h2>
  <div class="keys">
    <button type="button" class="primary" onclick="setAcc(1)" id="bY">Yes, accepting<kbd>A</kbd></button>
    <button type="button" onclick="setAcc(0)" id="bN">Full / waitlist closed<kbd>F</kbd></button>
  </div>
  <input type="hidden" name="accepting" id="accepting" value="">

  <div class="row">
    <div><label>Estimated wait (weeks)<input name="wait" id="wait" type="number" min="0" max="200" placeholder="e.g. 8"></label></div>
    <div><label>Notes<input name="notes" placeholder="optional"></label></div>
  </div>

  <h2>Insurance accepted <span style="font-weight:400;color:var(--faint)">(check what they confirm)</span></h2>
  <div class="pay">${Object.entries(PAYERS).map(([k, v]) => {
    const cur = payers.find((p) => p.payer === k);
    return `<label><input type="checkbox" name="pay_${k}" ${cur?.status === "verified_yes" ? "checked" : ""}> ${esc(v)}</label>`;
  }).join("")}</div>
  <div class="hint">Unchecked payers are recorded as "not confirmed", never as "not accepted" — we only publish a negative when the clinic says so explicitly.</div>

  <div class="keys" style="margin-top:1rem">
    <button class="primary" type="submit">Save &amp; next<kbd>↵</kbd></button>
  </div>
</form>

${prior.length ? `<div class="card"><h2>Prior attempts</h2><table>${prior.map((p) => `<tr><td>${esc(p.created_at.slice(0, 16).replace("T", " "))}</td><td>${esc(p.outcome)}</td><td>${esc(p.notes ?? "")}</td></tr>`).join("")}</table></div>` : ""}

<script>
function setAcc(v){document.getElementById('accepting').value=v;
  document.getElementById('bY').classList.toggle('primary',v===1);
  document.getElementById('bN').classList.toggle('primary',v===0);
  if(v===1)document.getElementById('wait').focus();}
function quick(o){document.getElementById('outcome').value=o;document.getElementById('accepting').value='';document.getElementById('f').submit();}
function skip(){location.href='/?offset=${offset + 1}';}
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'){if(e.key==='Enter')document.getElementById('f').submit();return}
  var k=e.key.toLowerCase();
  if(k==='a')setAcc(1); else if(k==='f')setAcc(0);
  else if(k==='n')quick('no_answer'); else if(k==='v')quick('voicemail');
  else if(k==='b')quick('bad_number'); else if(k==='s')skip();
  else if(k==='enter')document.getElementById('f').submit();
});
</script>`);
}

function inboxPage() {
  const claims = db.prepare(`SELECT * FROM ops.claims ORDER BY created_at DESC LIMIT 40`).all();
  const leads = db.prepare(`SELECT l.*, o.name org FROM ops.leads l JOIN sites s ON s.site_key=l.site_key JOIN organizations o ON o.npi=s.org_npi ORDER BY l.created_at DESC LIMIT 40`).all();
  return page(`<p><a href="/">← Console</a></p>
<div class="card"><h1>Claims (${claims.length})</h1><table><tr><th>When</th><th>NPI</th><th>Name</th><th>Email</th><th>License</th><th>Status</th></tr>
${claims.map((c) => `<tr><td>${esc((c.created_at ?? "").slice(0, 10))}</td><td>${esc(c.org_npi)}</td><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.license_no ?? "")}</td><td>${esc(c.status)}</td></tr>`).join("") || "<tr><td colspan=6>None yet</td></tr>"}</table></div>
<div class="card"><h1>Family inquiries (${leads.length})</h1><table><tr><th>When</th><th>Provider</th><th>Payer</th><th>Age</th><th>Contact</th></tr>
${leads.map((l) => `<tr><td>${esc((l.created_at ?? "").slice(0, 10))}</td><td>${esc(l.org)}</td><td>${esc(l.payer ?? "")}</td><td>${esc(l.child_age ?? "")}</td><td>${esc(l.name ?? "")} · ${esc(l.contact ?? "")}</td></tr>`).join("") || "<tr><td colspan=5>None yet</td></tr>"}</table></div>`);
}

// ---------- server ----------
const readBody = (req) => new Promise((resolve) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(new URLSearchParams(d)));
});
const send = (res, html, code = 200) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8" }); res.end(html); };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/record") {
      const b = await readBody(req);
      const siteKey = b.get("site_key");
      const outcome = b.get("outcome") || "reached";
      const accepting = b.get("accepting");
      const offset = +(b.get("offset") ?? 0);

      // Retry policy: unreachable numbers come back in 3 days, voicemail in 7,
      // bad numbers and refusals never (the queue filters them out entirely).
      const defer = { no_answer: 3, voicemail: 7, bad_number: 3650, refused: 3650 }[outcome];
      db.prepare(`INSERT INTO ops.call_log (site_key, outcome, notes, created_at, next_attempt_after) VALUES (?,?,?,?,?)`)
        .run(siteKey, outcome, b.get("notes") || null, nowIso(), defer ? addDays(defer) : null);

      if (outcome === "reached" && accepting !== "" && accepting !== null) {
        const waitRaw = b.get("wait");
        db.prepare(`INSERT INTO ops.availability (site_key, accepting, est_wait_weeks, payer_scope, as_of, source, collected_by)
                    VALUES (?,?,?,?,?,'phone','ops-console')`)
          .run(siteKey, +accepting, waitRaw ? +waitRaw : null, "all", today());
        for (const k of Object.keys(PAYERS)) {
          if (b.get(`pay_${k}`) != null) {
            db.prepare(`UPDATE ops.payer_acceptance SET status='verified_yes', verified_at=?, verify_method='phone' WHERE site_key=? AND payer=?`)
              .run(today(), siteKey, k);
          }
        }
      }
      // Stay at the same offset: this site has dropped out of the queue, so offset 0 is the next one.
      res.writeHead(303, { location: outcome === "reached" ? "/" : `/?offset=${offset}` });
      return res.end();
    }
    if (url.pathname === "/inbox") return send(res, inboxPage());
    if (url.pathname === "/") return send(res, consolePage(+(url.searchParams.get("offset") ?? 0)));
    return send(res, page(`<div class="card"><h1>Not found</h1><p><a href="/">Console</a></p></div>`), 404);
  } catch (err) {
    console.error(err);
    return send(res, page(`<div class="card"><h1>Error</h1><pre>${esc(err.message)}</pre><p><a href="/">Back</a></p></div>`), 500);
  }
}).listen(PORT, () => {
  const s = stats();
  console.log(`Verification console → http://localhost:${PORT}`);
  console.log(`  ${s.total} callable sites · ${s.fresh} fresh · ${s.total - s.fresh} need a call · ${s.open} confirmed openings`);
  console.log(`  Keys: A=accepting  F=full  N=no answer  V=voicemail  B=bad number  S=skip  Enter=save`);
});

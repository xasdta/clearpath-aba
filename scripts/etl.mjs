// Build the ABA Openings directory database from raw NPPES + TDLR pulls.
//
// Writes ONLY derived public-record data (organizations, sites, clinicians) into
// directory.db. Operational data lives in ops.db and is never touched here.
//
// Organizations and sites are UPSERTED and keyed by NPI, never dropped and re-inserted.
// A clinic that vanishes from NPPES is marked inactive rather than deleted, so the
// availability we collected by phone still has something to point at (and so a bad
// upstream fetch cannot silently wipe the directory).

import { readFileSync } from "node:fs";
import { openDb, today } from "../lib/db.mjs";

const db = openDb();

db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  npi TEXT PRIMARY KEY, name TEXT NOT NULL, alt_name TEXT,
  ao_name TEXT, ao_credential TEXT,
  ao_license_no TEXT, ao_license_type TEXT, ao_license_status TEXT,
  ao_license_expires TEXT, ao_verified_at TEXT, ao_verify_source TEXT,
  enumeration_date TEXT, active INTEGER NOT NULL DEFAULT 1, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS sites (
  site_key TEXT PRIMARY KEY,          -- = NPI (stable federal id), never an autoincrement
  org_npi TEXT NOT NULL,
  address1 TEXT, city TEXT, city_slug TEXT, state TEXT, zip TEXT, phone TEXT,
  active INTEGER NOT NULL DEFAULT 1, last_seen TEXT
);
CREATE INDEX IF NOT EXISTS idx_sites_city ON sites(city_slug);
DROP TABLE IF EXISTS clinicians;
CREATE TABLE clinicians (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, license_no TEXT UNIQUE,
  license_type TEXT, expires TEXT, status TEXT, source TEXT, source_date TEXT
);
`);

// ---- clinicians (TDLR licensing roster) ----
const tdlr = JSON.parse(readFileSync(new URL("../data/raw/tdlr-behavior-analysts.json", import.meta.url)));
const parseExpiry = (mdy) => {
  if (!mdy) return null;
  const [m, d, y] = mdy.split("/").map(Number);
  return y ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
};
const insClin = db.prepare(
  `INSERT OR IGNORE INTO clinicians (name, license_no, license_type, expires, status, source, source_date)
   VALUES (?, ?, ?, ?, ?, 'TDLR via data.texas.gov (dataset 7358-krk7)', ?)`);
let active = 0;
for (const r of tdlr) {
  const expires = parseExpiry(r.license_expiration_date_mmddccyy);
  const status = expires && expires >= today() ? "active" : "expired";
  if (status === "active") active++;
  insClin.run(r.owner_name ?? "", r.license_number ?? null, r.license_type ?? "", expires, status, today());
}
console.log(`clinicians: ${tdlr.length} loaded (${active} active licenses)`);

// name key "LAST, FIRST M" -> LAST|FIRST; only unique keys are match-eligible
const norm = (s) => (s ?? "").toUpperCase().replace(/[^A-Z ,]/g, "").replace(/\s+/g, " ").trim();
const keyOf = (last, first) => `${norm(last)}|${norm(first).split(" ")[0]}`;
const byKey = new Map();
for (const r of tdlr) {
  const [last, rest] = (r.owner_name ?? "").split(",");
  if (!last || !rest) continue;
  const k = keyOf(last, rest);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(r);
}

// ---- organizations + sites (NPPES), upserted ----
const orgs = JSON.parse(readFileSync(new URL("../data/raw/nppes-tx-orgs.json", import.meta.url)));
if (orgs.length < 100) {
  // Guard against a truncated or failed upstream fetch quietly emptying the directory.
  throw new Error(`Refusing to run: NPPES pull returned only ${orgs.length} organizations`);
}
const upsertOrg = db.prepare(`
  INSERT INTO organizations (npi, name, alt_name, ao_name, ao_credential, ao_license_no,
    ao_license_type, ao_license_status, ao_license_expires, ao_verified_at, ao_verify_source,
    enumeration_date, active, last_seen)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
  ON CONFLICT(npi) DO UPDATE SET
    name=excluded.name, alt_name=excluded.alt_name, ao_name=excluded.ao_name,
    ao_credential=excluded.ao_credential, ao_license_no=excluded.ao_license_no,
    ao_license_type=excluded.ao_license_type, ao_license_status=excluded.ao_license_status,
    ao_license_expires=excluded.ao_license_expires, ao_verified_at=excluded.ao_verified_at,
    ao_verify_source=excluded.ao_verify_source, enumeration_date=excluded.enumeration_date,
    active=1, last_seen=excluded.last_seen`);
const upsertSite = db.prepare(`
  INSERT INTO sites (site_key, org_npi, address1, city, city_slug, state, zip, phone, active, last_seen)
  VALUES (?,?,?,?,?,?,?,?,1,?)
  ON CONFLICT(site_key) DO UPDATE SET
    address1=excluded.address1, city=excluded.city, city_slug=excluded.city_slug,
    state=excluded.state, zip=excluded.zip, phone=excluded.phone,
    active=1, last_seen=excluded.last_seen`);
const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const titleCase = (s) => (s ?? "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

let matched = 0;
for (const o of orgs) {
  const b = o.basic ?? {};
  const loc = (o.addresses ?? []).find((a) => a.address_purpose === "LOCATION") ?? o.addresses?.[0] ?? {};
  const aoFirst = b.authorized_official_first_name ?? "";
  const aoLast = b.authorized_official_last_name ?? "";
  let lic = { no: null, type: null, status: null, expires: null, at: null, src: null };
  if (aoLast) {
    const cands = byKey.get(keyOf(aoLast, aoFirst)) ?? [];
    if (cands.length === 1) {
      const c = cands[0];
      const expires = parseExpiry(c.license_expiration_date_mmddccyy);
      lic = { no: c.license_number, type: c.license_type,
        status: expires && expires >= today() ? "active" : "expired",
        expires, at: today(), src: "TDLR license roster via data.texas.gov" };
      matched++;
    }
  }
  upsertOrg.run(o.number, b.organization_name ?? "(unnamed)",
    (o.other_names ?? [])[0]?.organization_name ?? null,
    aoLast ? `${aoLast}, ${aoFirst}` : null, b.authorized_official_credential ?? null,
    lic.no, lic.type, lic.status, lic.expires, lic.at, lic.src,
    b.enumeration_date ?? null, today());
  upsertSite.run(o.number, o.number, titleCase(loc.address_1), titleCase(loc.city),
    slug(loc.city), loc.state ?? "TX", (loc.postal_code ?? "").slice(0, 5),
    loc.telephone_number ?? null, today());
}
// Anything not present in this pull is retired, not deleted — ops history stays valid.
const goneOrgs = db.prepare(`UPDATE organizations SET active=0 WHERE last_seen != ?`).run(today()).changes;
const goneSites = db.prepare(`UPDATE sites SET active=0 WHERE last_seen != ?`).run(today()).changes;
console.log(`organizations: ${orgs.length} upserted; ${matched} authorized officials license-matched`);
if (goneOrgs || goneSites) console.log(`retired: ${goneOrgs} organizations, ${goneSites} sites no longer in NPPES`);

// ---- payer seed rows live in ops.db (verification status is earned data) ----
const PAYERS = [["aetna","commercial"],["bcbs-texas","commercial"],["cigna","commercial"],
  ["unitedhealthcare","commercial"],["texas-medicaid","medicaid"],["tricare","tricare"]];
const seedPayer = db.prepare(`INSERT OR IGNORE INTO ops.payer_acceptance (site_key, payer, plan_type) VALUES (?,?,?)`);
let seeded = 0;
for (const { site_key } of db.prepare(`SELECT site_key FROM sites WHERE active=1`).all())
  for (const [p, t] of PAYERS) seeded += seedPayer.run(site_key, p, t).changes;
console.log(`payer_acceptance: ${seeded} new seed rows (existing verifications untouched)`);
console.log(`directory.db ready`);

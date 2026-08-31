// Build the ClearPath SQLite database from raw NPPES + TDLR pulls.
// - organizations/sites backbone from NPPES (public record)
// - clinicians (license layer) from TDLR via data.texas.gov (public record)
// - authorized-official license matching: an org whose NPPES authorized official
//   uniquely matches a TDLR licensee gets a dated license-verified flag
// - payer_acceptance seeded as 'unverified' for the major Texas payers; only the
//   admin verification flow (phone call) can mark rows verified
// Availability rows carry a 90-day TTL enforced at render time, never here.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const dbPath = new URL("../data/clearpath.db", import.meta.url).pathname;
const db = new DatabaseSync(dbPath);
const today = new Date().toISOString().slice(0, 10);

db.exec(`
PRAGMA journal_mode = WAL;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS clinicians;
DROP TABLE IF EXISTS payer_acceptance;
CREATE TABLE organizations (
  npi TEXT PRIMARY KEY, name TEXT NOT NULL, alt_name TEXT,
  ao_name TEXT, ao_credential TEXT,
  ao_license_no TEXT, ao_license_type TEXT, ao_license_status TEXT,
  ao_license_expires TEXT, ao_verified_at TEXT, ao_verify_source TEXT,
  enumeration_date TEXT
);
CREATE TABLE sites (
  id INTEGER PRIMARY KEY, org_npi TEXT NOT NULL REFERENCES organizations(npi),
  address1 TEXT, city TEXT, city_slug TEXT, state TEXT, zip TEXT, phone TEXT
);
CREATE TABLE clinicians (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, license_no TEXT UNIQUE,
  license_type TEXT, expires TEXT, status TEXT, source TEXT, source_date TEXT
);
CREATE TABLE payer_acceptance (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id),
  payer TEXT NOT NULL, plan_type TEXT,
  status TEXT NOT NULL DEFAULT 'unverified',  -- unverified | verified_yes | verified_no
  verified_at TEXT, verify_method TEXT,
  UNIQUE(site_id, payer)
);
CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL,
  accepting INTEGER, est_wait_weeks INTEGER, payer_scope TEXT, as_of TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL, payer TEXT, child_age TEXT,
  zip TEXT, name TEXT, contact TEXT, message TEXT, source_page TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY, org_npi TEXT NOT NULL, name TEXT, role TEXT, email TEXT,
  license_no TEXT, status TEXT DEFAULT 'pending', created_at TEXT
);
CREATE INDEX idx_sites_city ON sites(city_slug);
CREATE INDEX idx_payer_site ON payer_acceptance(site_id);
`);

// ---- clinicians (TDLR) ----
const tdlr = JSON.parse(readFileSync(new URL("../data/raw/tdlr-behavior-analysts.json", import.meta.url)));
const insClin = db.prepare(
  `INSERT OR IGNORE INTO clinicians (name, license_no, license_type, expires, status, source, source_date)
   VALUES (?, ?, ?, ?, ?, 'TDLR via data.texas.gov (dataset 7358-krk7)', ?)`
);
function parseExpiry(mdy) {
  if (!mdy) return null;
  const [m, d, y] = mdy.split("/").map(Number);
  if (!y) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
let active = 0;
for (const r of tdlr) {
  const expires = parseExpiry(r.license_expiration_date_mmddccyy);
  const status = expires && expires >= today ? "active" : "expired";
  if (status === "active") active++;
  insClin.run(r.owner_name ?? "", r.license_number ?? null, r.license_type ?? "", expires, status, today);
}
console.log(`clinicians: ${tdlr.length} loaded (${active} active licenses)`);

// name key: "LAST, FIRST M" -> LAST|FIRST. Only unique keys are match-eligible.
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

// ---- organizations + sites (NPPES) ----
const orgs = JSON.parse(readFileSync(new URL("../data/raw/nppes-tx-orgs.json", import.meta.url)));
const insOrg = db.prepare(
  `INSERT OR REPLACE INTO organizations
   (npi, name, alt_name, ao_name, ao_credential, ao_license_no, ao_license_type,
    ao_license_status, ao_license_expires, ao_verified_at, ao_verify_source, enumeration_date)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insSite = db.prepare(
  `INSERT INTO sites (org_npi, address1, city, city_slug, state, zip, phone) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const title = (s) => (s ?? "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

let matched = 0;
for (const o of orgs) {
  const b = o.basic ?? {};
  const loc = (o.addresses ?? []).find((a) => a.address_purpose === "LOCATION") ?? o.addresses?.[0] ?? {};
  const aoFirst = b.authorized_official_first_name ?? "";
  const aoLast = b.authorized_official_last_name ?? "";
  const aoName = aoLast ? `${aoLast}, ${aoFirst}` : null;

  let lic = { no: null, type: null, status: null, expires: null, at: null, src: null };
  if (aoLast) {
    const candidates = byKey.get(keyOf(aoLast, aoFirst)) ?? [];
    if (candidates.length === 1) {
      const c = candidates[0];
      const expires = parseExpiry(c.license_expiration_date_mmddccyy);
      lic = {
        no: c.license_number,
        type: c.license_type,
        status: expires && expires >= today ? "active" : "expired",
        expires,
        at: today,
        src: "TDLR license roster via data.texas.gov",
      };
      matched++;
    }
  }

  const altName = (o.other_names ?? [])[0]?.organization_name ?? null;
  insOrg.run(
    o.number, b.organization_name ?? "(unnamed)", altName, aoName,
    b.authorized_official_credential ?? null,
    lic.no, lic.type, lic.status, lic.expires, lic.at, lic.src,
    b.enumeration_date ?? null
  );
  insSite.run(
    o.number, title(loc.address_1), title(loc.city), slug(loc.city), loc.state ?? "TX",
    (loc.postal_code ?? "").slice(0, 5), loc.telephone_number ?? null
  );
}
console.log(`organizations: ${orgs.length} loaded; ${matched} authorized officials license-matched via TDLR`);

// ---- payer seeds ----
const PAYERS = [
  ["aetna", "commercial"], ["bcbs-texas", "commercial"], ["cigna", "commercial"],
  ["unitedhealthcare", "commercial"], ["texas-medicaid", "medicaid"], ["tricare", "tricare"],
];
const insPay = db.prepare(
  `INSERT OR IGNORE INTO payer_acceptance (site_id, payer, plan_type) VALUES (?, ?, ?)`
);
const siteIds = db.prepare(`SELECT id FROM sites`).all();
for (const { id } of siteIds) for (const [p, t] of PAYERS) insPay.run(id, p, t);
console.log(`payer_acceptance: seeded ${siteIds.length} sites x ${PAYERS.length} payers (all unverified)`);
console.log(`DB ready: ${dbPath}`);

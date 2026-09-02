// Build the sales prospect list: license-verified clinics in the biggest metros, with phones.
// These are the warmest featured-listing targets because their profile already shows a
// verified badge — the pitch is "your listing is live and verified; here's what it's doing."
// Writes outreach/prospects.csv (gitignored — contains no secrets, but it's a working file).

import { writeFileSync, mkdirSync } from "node:fs";
import { openDb } from "../lib/db.mjs";

const root = new URL("../", import.meta.url);
const db = openDb();

const rows = db.prepare(`
  SELECT o.npi, o.name, o.ao_name, o.ao_license_no, o.ao_license_expires,
         s.city, s.zip, s.phone,
         (SELECT COUNT(*) FROM sites s2 WHERE s2.city_slug = s.city_slug AND s2.active=1) AS city_size
  FROM organizations o JOIN sites s ON s.site_key = o.npi
  WHERE o.active = 1 AND s.active = 1 AND o.ao_license_status = 'active'
    AND s.phone IS NOT NULL AND s.phone != ''
  ORDER BY city_size DESC, o.name
`).all();

const esc = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = "npi,clinic,city,zip,phone,director,license,license_expires,city_providers,profile_url,status,last_contact,notes";
const csv = [header, ...rows.map((r) => [
  r.npi, r.name, r.city, r.zip, r.phone, r.ao_name, r.ao_license_no, r.ao_license_expires,
  r.city_size, `/providers/${r.npi}.html`, "not_contacted", "", "",
].map(esc).join(","))].join("\n");

mkdirSync(new URL("outreach/", root), { recursive: true });
writeFileSync(new URL("outreach/prospects.csv", root), csv + "\n");
console.log(`prospects: ${rows.length} license-verified clinics with phone numbers -> outreach/prospects.csv`);
console.log(`  top metros: ${[...new Set(rows.slice(0, 200).map((r) => r.city))].slice(0, 8).join(", ")}`);

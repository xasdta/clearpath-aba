// Shared database access + additive, idempotent migrations.
//
// TWO DATABASES, deliberately:
//
//   data/directory.db  — DERIVED public-record data (organizations, sites, clinicians).
//                        Rebuilt from scratch by etl.mjs on every refresh. Disposable.
//   data/ops.db        — EARNED operational data (availability, verified payers, leads,
//                        claims, call log, alert subscribers). Never rebuilt, never
//                        committed. This is the moat; losing it means re-calling 1,379 clinics.
//
// They are separate because the ETL drops and recreates the derived tables, and because
// ops.db accumulates family contact details that must never land in a public git repo.
// ops.db is ATTACHed as schema `ops`, so a single connection can join across both.
//
// Sites are keyed by NPI (a stable federal identifier), never by autoincrement rowid.
// An earlier version used autoincrement, which meant a weekly refresh could silently
// re-point a clinic's confirmed availability at a different business.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

const DATA_DIR = new URL("../data/", import.meta.url).pathname;
export const PUBLIC_DB = `${DATA_DIR}directory.db`;
export const OPS_DB = `${DATA_DIR}ops.db`;

// Operational schema. Every table keys sites by TEXT npi. Cross-database foreign keys
// are not supported by SQLite, so integrity is maintained by the ETL never deleting NPIs
// that ops rows reference (it upserts; see etl.mjs).
const OPS_MIGRATIONS = [
  ["001_core", `
    CREATE TABLE IF NOT EXISTS ops.payer_acceptance (
      site_key TEXT NOT NULL, payer TEXT NOT NULL, plan_type TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',   -- unverified | verified_yes | verified_no
      verified_at TEXT, verify_method TEXT,
      PRIMARY KEY (site_key, payer)
    );
    CREATE TABLE IF NOT EXISTS ops.availability (
      id INTEGER PRIMARY KEY, site_key TEXT NOT NULL,
      accepting INTEGER, est_wait_weeks INTEGER, payer_scope TEXT,
      as_of TEXT NOT NULL, source TEXT DEFAULT 'phone', collected_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ops.idx_avail_site ON availability(site_key, as_of DESC);
    CREATE TABLE IF NOT EXISTS ops.leads (
      id INTEGER PRIMARY KEY, site_key TEXT NOT NULL, payer TEXT, child_age TEXT,
      zip TEXT, name TEXT, contact TEXT, message TEXT, source_page TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ops.claims (
      id INTEGER PRIMARY KEY, org_npi TEXT NOT NULL, name TEXT, role TEXT, email TEXT,
      license_no TEXT, status TEXT DEFAULT 'pending', created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ops.call_log (
      id INTEGER PRIMARY KEY, site_key TEXT NOT NULL,
      outcome TEXT NOT NULL,        -- reached | voicemail | no_answer | bad_number | refused
      notes TEXT, created_at TEXT NOT NULL, next_attempt_after TEXT
    );
    CREATE INDEX IF NOT EXISTS ops.idx_call_site ON call_log(site_key);
    CREATE INDEX IF NOT EXISTS ops.idx_call_next ON call_log(next_attempt_after);
  `],
  ["002_alert_subscribers", `
    CREATE TABLE IF NOT EXISTS ops.alert_subscribers (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL, zip TEXT, city_slug TEXT,
      payer TEXT, child_age TEXT, radius_miles INTEGER DEFAULT 25,
      confirmed_at TEXT, unsubscribed_at TEXT, last_sent_at TEXT,
      created_at TEXT NOT NULL, token TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS ops.idx_subs_active ON alert_subscribers(unsubscribed_at, city_slug);
  `],
];

export function openDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(PUBLIC_DB);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`ATTACH DATABASE '${OPS_DB}' AS ops`);
  db.exec(`CREATE TABLE IF NOT EXISTS ops.schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare(`SELECT name FROM ops.schema_migrations`).all().map((r) => r.name));
  for (const [name, sql] of OPS_MIGRATIONS) {
    if (applied.has(name)) continue;
    db.exec(sql);
    db.prepare(`INSERT INTO ops.schema_migrations (name, applied_at) VALUES (?, ?)`).run(name, new Date().toISOString());
  }
  return db;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();
export const addDays = (n, from = new Date()) =>
  new Date(from.getTime() + n * 86400000).toISOString().slice(0, 10);

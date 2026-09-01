// Shared database access + additive, idempotent migrations.
// Every consumer (etl, generator, ops console, automation engine) opens the DB through here,
// so schema changes land in exactly one place and are always safe to re-run.

import { DatabaseSync } from "node:sqlite";

const DB_PATH = new URL("../data/clearpath.db", import.meta.url).pathname;

// Each migration is (name, sql). Applied once, recorded in schema_migrations.
// Never edit a shipped migration — add a new one.
const MIGRATIONS = [
  ["001_call_log", `
    CREATE TABLE IF NOT EXISTS call_log (
      id INTEGER PRIMARY KEY,
      site_id INTEGER NOT NULL,
      outcome TEXT NOT NULL,            -- reached | voicemail | no_answer | bad_number | refused
      notes TEXT,
      created_at TEXT NOT NULL,
      next_attempt_after TEXT           -- ISO date; queue skips the site until then
    );
    CREATE INDEX IF NOT EXISTS idx_call_log_site ON call_log(site_id);
    CREATE INDEX IF NOT EXISTS idx_call_log_next ON call_log(next_attempt_after);
  `],
  ["002_availability_provenance", `
    ALTER TABLE availability ADD COLUMN source TEXT DEFAULT 'phone';
    ALTER TABLE availability ADD COLUMN collected_by TEXT;
  `],
  ["003_availability_index", `
    CREATE INDEX IF NOT EXISTS idx_availability_site_asof ON availability(site_id, as_of DESC);
  `],
];

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare(`SELECT name FROM schema_migrations`).all().map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // ALTER TABLE ADD COLUMN throws if the column already exists (e.g. a DB built before
      // migrations were tracked). That is a no-op, not a failure — anything else is real.
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
    db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
      .run(name, new Date().toISOString());
  }
  return db;
}

export const today = () => new Date().toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();
export const addDays = (n, from = new Date()) =>
  new Date(from.getTime() + n * 86400000).toISOString().slice(0, 10);

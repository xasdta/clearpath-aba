// First-contact outreach to listed clinics. Usage:
//   node jobs/outreach.mjs import <file.json>   add researched addresses (npi, email, source_url)
//   node jobs/outreach.mjs send                  today's batch (launchd runs this weekdays 10:00)
//   node jobs/outreach.mjs status                where every clinic is in the sequence
//   node jobs/outreach.mjs stop <email|npi>      stop someone by hand (e.g. they replied "unsubscribe")
//
// Two emails at most per clinic: the ask, then one follow-up FOLLOW_UP_DAYS later if they
// haven't answered — then we stop for good. A clinic that answers (availability, insurance,
// a claim) or unsubscribes leaves the sequence immediately, and an answer promotes its address
// to ops.clinic_contacts so the monthly availability ask takes over.
//
// Deliverability is the constraint, not reach: a new domain that suddenly sends hundreds of
// cold emails lands in spam — and takes the claim/alert mail down with it. So the daily cap
// starts small and only grows while failures stay rare.
//
// Addresses must come from the clinic's own website (source_url is required on import). We
// never guess or buy addresses. CAN-SPAM: sender, postal address and unsubscribe in every mail.

import "../lib/env.mjs";
import { readFileSync } from "node:fs";
import { openDb, today, nowIso } from "../lib/db.mjs";
import { sendMail, isSuppressed, suppress } from "../lib/mail.mjs";
import { clinicOutreach } from "../lib/outreach-email.mjs";

const cfg = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url)));
const FOLLOW_UP_DAYS = 5;
const START_CAP = Number(process.env.OUTREACH_DAILY_CAP || 20);   // grows by +5/day of clean sending, max 60
const MAX_CAP = 60;
const db = openDb();
const [cmd = "status", arg] = process.argv.slice(2);

if (!cfg.postalAddress) throw new Error("site.config.json postalAddress is required (CAN-SPAM)");
const sender = { name: cfg.senderName, title: cfg.senderTitle };
const org = (npi) => db.prepare(`SELECT o.*, s.city FROM organizations o JOIN sites s ON s.site_key = o.npi WHERE o.npi = ? AND o.active = 1`).get(npi);

// Did the clinic answer anything since we first wrote? Then it has left the sequence.
function answered(npi, since) {
  return db.prepare(`SELECT 1 FROM ops.availability WHERE site_key = ? AND source = 'email' AND as_of >= substr(?,1,10)
             UNION SELECT 1 FROM ops.payer_acceptance WHERE site_key = ? AND verify_method = 'clinic' AND verified_at >= substr(?,1,10)
             UNION SELECT 1 FROM ops.claims WHERE org_npi = ? AND created_at >= ? LIMIT 1`).get(npi, since, npi, since, npi, since);
}

function reconcile() {
  const rows = db.prepare(`SELECT * FROM ops.outreach WHERE status IN ('queued','active')`).all();
  let moved = 0;
  for (const r of rows) {
    if (isSuppressed(db, r.email)) {
      db.prepare(`UPDATE ops.outreach SET status='unsubscribed', stopped_reason='suppressed' WHERE npi=?`).run(r.npi); moved++; continue;
    }
    if (r.last_sent_at && answered(r.npi, r.last_sent_at)) {
      db.prepare(`UPDATE ops.outreach SET status='responded', stopped_reason='clinic answered' WHERE npi=?`).run(r.npi);
      // The address is the clinic's own published one and the clinic acted on the email sent to
      // it, so it becomes the contact for the monthly ask (unless a verified claim already set one).
      db.prepare(`INSERT OR IGNORE INTO ops.clinic_contacts (site_key, email, source, confirmed_at, created_at) VALUES (?,?,'outreach',?,?)`)
        .run(r.npi, r.email.toLowerCase(), nowIso(), nowIso());
      moved++;
    }
  }
  return moved;
}

// Cap grows +5 for each earlier sending day with zero failures, never past MAX_CAP.
function dailyCap() {
  // Only finished days count: today can't raise today's own limit.
  const days = db.prepare(`SELECT substr(created_at,1,10) d, SUM(status='failed') f FROM ops.mail_log
                           WHERE tag LIKE 'outreach-_' AND created_at < date('now') GROUP BY d`).all();
  const clean = days.filter((x) => !x.f).length;
  return Math.min(MAX_CAP, START_CAP + 5 * clean);
}

async function send() {
  const dow = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short" });
  if (["Sat", "Sun"].includes(dow) && !process.env.OUTREACH_ANY_DAY) return "weekend — nothing sent";
  const moved = reconcile();
  const sentToday = db.prepare(`SELECT COUNT(*) c FROM ops.mail_log WHERE tag LIKE 'outreach-_' AND status IN ('sent','dryrun') AND created_at >= date('now')`).get().c;
  const cap = Math.max(0, dailyCap() - sentToday);
  // Follow-ups first (they were promised a single nudge), then new first contacts. First
  // contacts go out Tuesday–Thursday only: cold email lands best mid-week, while Monday
  // inboxes are buried and Friday mail sits over the weekend.
  const firstContactDay = ["Tue", "Wed", "Thu"].includes(dow) || !!process.env.OUTREACH_ANY_DAY;
  const due = [
    ...db.prepare(`SELECT * FROM ops.outreach WHERE status='active' AND step=1 AND last_sent_at <= datetime('now', '-${FOLLOW_UP_DAYS} days') ORDER BY last_sent_at`).all(),
    ...(firstContactDay ? db.prepare(`SELECT * FROM ops.outreach WHERE status='queued' AND step=0 ORDER BY found_at`).all() : []),
  ].slice(0, cap);

  const out = { sent: 0, failed: 0, skipped: 0 };
  for (const r of due) {
    const o = org(r.npi);
    if (!o) { db.prepare(`UPDATE ops.outreach SET status='done', stopped_reason='listing retired' WHERE npi=?`).run(r.npi); out.skipped++; continue; }
    const step = r.step + 1;
    const e = clinicOutreach({ org: o, sender, postalAddress: cfg.postalAddress, step });
    const res = await sendMail(db, { to: r.email, subject: e.subject, text: e.text, html: e.html, dedupeKey: `outreach:${r.npi}:${step}`, tag: `outreach-${step}` });
    if (res.sent || res.logged) {
      db.prepare(`UPDATE ops.outreach SET step=?, status=?, last_sent_at=? WHERE npi=?`).run(step, step >= 2 ? "done" : "active", nowIso(), r.npi);
      out.sent++;
    } else if (res.reason === "duplicate") {
      out.skipped++;
    } else {
      db.prepare(`UPDATE ops.outreach SET status=?, stopped_reason=? WHERE npi=?`)
        .run(res.reason === "suppressed" ? "unsubscribed" : "failed", res.reason + (res.status ? ` ${res.status}` : ""), r.npi);
      out.failed++;
    }
    await new Promise((ok) => setTimeout(ok, 1500));      // spread sends; providers dislike bursts
  }
  const summary = `sent ${out.sent}, failed ${out.failed}, skipped ${out.skipped} (cap ${cap}); ${moved} left the sequence`;
  if (out.sent || out.failed) await sendMail(db, {
    to: cfg.correctionsEmail, tag: "outreach-summary", dedupeKey: `outreach-summary:${today()}`,
    subject: `Outreach today: ${out.sent} sent${out.failed ? `, ${out.failed} failed` : ""}`,
    text: `${summary}\n\n${status()}\n\nReplies land in this inbox. To stop someone who replied "unsubscribe":\n  node jobs/outreach.mjs stop <their email>`,
  });
  return summary;
}

function status() {
  const by = db.prepare(`SELECT status, step, COUNT(*) n FROM ops.outreach GROUP BY status, step ORDER BY status`).all();
  return by.length ? by.map((r) => `  ${r.status.padEnd(13)} step ${r.step}: ${r.n}`).join("\n") : "  (no clinics imported yet)";
}

function importFile(path) {
  const rows = JSON.parse(readFileSync(path, "utf8"));
  let added = 0, skipped = 0;
  for (const r of rows) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !r.source_url || !org(r.npi)) { skipped++; continue; }
    added += db.prepare(`INSERT OR IGNORE INTO ops.outreach (npi, email, source_url, found_at, notes) VALUES (?,?,?,?,?)`)
      .run(r.npi, email, r.source_url, nowIso(), r.notes ?? null).changes;
  }
  return `imported ${added}, skipped ${skipped} (no published email / no source / not listed)`;
}

function stop(who) {
  const w = String(who || "").trim().toLowerCase();
  if (!w) return "usage: stop <email|npi>";
  if (w.includes("@")) suppress(db, w, "unsubscribed");
  const n = db.prepare(`UPDATE ops.outreach SET status='unsubscribed', stopped_reason='stopped by hand' WHERE lower(email)=? OR npi=?`).run(w, w).changes;
  return `stopped ${n} clinic(s)${w.includes("@") ? "; address suppressed for all mail" : ""}`;
}

const result = cmd === "import" ? importFile(arg) : cmd === "send" ? await send() : cmd === "stop" ? stop(arg) : status();
console.log(`[outreach ${cmd}] ${result}`);

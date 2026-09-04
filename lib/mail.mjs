// Outbound mail: one adapter, three providers, dry-run by default.
//
// Nothing sends until MAIL_PROVIDER and MAIL_API_KEY are set in the environment. Until then
// every message is written to logs/outbox.log so the whole automation can be exercised end to
// end without touching a real inbox — the failure mode of a half-built mailer is emailing 1,379
// real businesses by accident, so the safe state is the default state.
//
// Every send is recorded in ops.mail_log for idempotency (a job asks "did I already send this
// to this recipient?" before sending) and checked against ops.suppressions, which is honoured
// unconditionally: an unsubscribe or a hard bounce means we never mail that address again.

import { appendFileSync, mkdirSync } from "node:fs";

const LOG_DIR = new URL("../logs/", import.meta.url).pathname;
const OUTBOX = `${LOG_DIR}outbox.log`;

export const mailConfig = () => ({
  provider: process.env.MAIL_PROVIDER || "dryrun",   // resend | postmark | dryrun
  apiKey: process.env.MAIL_API_KEY || "",
  from: process.env.MAIL_FROM || "ABA Openings <hello@abaopenings.com>",
  replyTo: process.env.MAIL_REPLY_TO || "sabrsystemssoftware@gmail.com",
  // Hard ceiling per run. A runaway loop should cost a handful of emails, not a domain.
  maxPerRun: Number(process.env.MAIL_MAX_PER_RUN || 100),
});

export function isSuppressed(db, email) {
  return !!db.prepare(`SELECT 1 FROM ops.suppressions WHERE email = ? LIMIT 1`).get(email.toLowerCase());
}

export function suppress(db, email, reason) {
  db.prepare(`INSERT OR IGNORE INTO ops.suppressions (email, reason, created_at) VALUES (?,?,?)`)
    .run(email.toLowerCase(), reason, new Date().toISOString());
}

// alreadySent: the idempotency gate. dedupeKey identifies "this exact message to this
// recipient for this subject", so a job re-run after a crash does not double-send.
export function alreadySent(db, dedupeKey) {
  return !!db.prepare(`SELECT 1 FROM ops.mail_log WHERE dedupe_key = ? LIMIT 1`).get(dedupeKey);
}

export async function sendMail(db, { to, subject, text, html, dedupeKey, tag = "general" }) {
  const cfg = mailConfig();
  const addr = String(to || "").trim().toLowerCase();
  if (!addr || !addr.includes("@")) return { sent: false, reason: "invalid_address" };
  if (isSuppressed(db, addr)) return { sent: false, reason: "suppressed" };
  if (dedupeKey && alreadySent(db, dedupeKey)) return { sent: false, reason: "duplicate" };

  const record = (status, detail = null) => {
    db.prepare(`INSERT OR IGNORE INTO ops.mail_log (dedupe_key, email, subject, tag, status, detail, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(dedupeKey ?? `${addr}:${subject}:${Date.now()}`, addr, subject, tag, status, detail, new Date().toISOString());
  };

  if (cfg.provider === "dryrun" || !cfg.apiKey) {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(OUTBOX, `\n=== ${new Date().toISOString()} [${tag}] -> ${addr}\nSubject: ${subject}\n${text}\n`);
    record("dryrun");
    return { sent: false, reason: "dryrun", logged: true };
  }

  try {
    let res;
    if (cfg.provider === "resend") {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: cfg.from, to: [addr], subject, text, html, reply_to: cfg.replyTo }),
      });
    } else if (cfg.provider === "postmark") {
      res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "X-Postmark-Server-Token": cfg.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ From: cfg.from, To: addr, Subject: subject, TextBody: text, HtmlBody: html, ReplyTo: cfg.replyTo, MessageStream: "outbound" }),
      });
    } else {
      record("failed", `unknown provider ${cfg.provider}`);
      return { sent: false, reason: "unknown_provider" };
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      record("failed", `HTTP ${res.status}: ${body}`);
      // 4xx on a specific address is usually a permanently bad recipient; suppress it so the
      // next run does not retry forever against the same dead mailbox.
      if (res.status === 422 || res.status === 400) suppress(db, addr, `provider_rejected_${res.status}`);
      return { sent: false, reason: "provider_error", status: res.status };
    }
    record("sent");
    return { sent: true };
  } catch (err) {
    record("failed", String(err.message).slice(0, 300));
    return { sent: false, reason: "exception", error: err.message };
  }
}

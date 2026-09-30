// The Vercel side of the automation is deliberately thin: validate, then queue.
//
// Every submission becomes one JSON file in the PRIVATE repo xasdta/abaopenings-inbox. The Mac
// job (jobs/apply-inbox.mjs, every 10 min) owns the database, the rules and the email; it
// applies each event and deletes the file. Family contact details therefore never touch the
// public repo, and a rules change never needs a redeploy.
//
// Needs env: INBOX_TOKEN (fine-grained PAT, Contents RW on abaopenings-inbox only).
import { randomBytes } from "node:crypto";

const INBOX = "https://api.github.com/repos/xasdta/abaopenings-inbox/contents/events";

export async function rawBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseBody(req, raw) {
  if ((req.headers["content-type"] || "").includes("application/json")) {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// Trim, cap and drop anything that is not a short string, so a hostile form post cannot
// queue megabytes or nested objects.
export function clean(fields, allowed) {
  const out = {};
  for (const k of allowed) {
    const v = fields[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, k === "message" ? 2000 : 300);
  }
  return out;
}

export async function queue(kind, data) {
  const token = process.env.INBOX_TOKEN;
  if (!token) throw new Error("INBOX_TOKEN is not set");
  const at = new Date().toISOString();
  const id = `${at.replace(/[:.]/g, "-")}-${kind}-${randomBytes(4).toString("hex")}`;
  const r = await fetch(`${INBOX}/${id}.json`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "abaopenings-inbox/1.0",
    },
    body: JSON.stringify({
      message: `${kind} event`,
      content: Buffer.from(JSON.stringify({ id, kind, at, data }, null, 2)).toString("base64"),
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`inbox write ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return id;
}

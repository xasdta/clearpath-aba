// Signed, expiring, single-purpose tokens for one-click email actions.
//
// A clinic gets "Do you have openings? [Yes] [We're full]" and must be able to answer in one
// click with no login. That link is the write path, so the token has to be unforgeable:
// nobody may flip another clinic's status, and a leaked link must expire.
//
// Format:  <payloadB64url>.<sigB64url>
// Payload: {k: siteKey, a: action, e: expiryEpochSeconds, n: nonce}
// Sig:     HMAC-SHA256(payload, secret), constant-time compared.
//
// The secret lives in data/.token-secret (gitignored, 0600), generated on first use.
// Rotating it invalidates every outstanding link, which is the intended emergency lever.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const SECRET_PATH = new URL("../data/.token-secret", import.meta.url).pathname;

function secret() {
  if (!existsSync(SECRET_PATH)) {
    writeFileSync(SECRET_PATH, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(SECRET_PATH, 0o600);
  }
  return readFileSync(SECRET_PATH, "utf8").trim();
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => createHmac("sha256", secret()).update(payload).digest();

export function mintToken({ siteKey, action, ttlDays = 45 }) {
  const payload = b64u(JSON.stringify({
    k: siteKey, a: action,
    e: Math.floor(Date.now() / 1000) + ttlDays * 86400,
    n: randomBytes(6).toString("base64url"),
  }));
  return `${payload}.${b64u(sign(payload))}`;
}

// Returns {ok:true, siteKey, action} or {ok:false, reason}. Never throws on bad input —
// these arrive from the open internet and malformed values are expected, not exceptional.
export function verifyToken(token) {
  if (typeof token !== "string" || token.length > 512) return { ok: false, reason: "malformed" };
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { ok: false, reason: "malformed" };
  let expected, given;
  try {
    expected = sign(payload);
    given = Buffer.from(sig, "base64url");
  } catch { return { ok: false, reason: "malformed" }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "bad_signature" };
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return { ok: false, reason: "malformed" }; }
  if (!data?.k || !data?.a) return { ok: false, reason: "malformed" };
  if (typeof data.e !== "number" || data.e < Math.floor(Date.now() / 1000))
    return { ok: false, reason: "expired" };
  return { ok: true, siteKey: String(data.k), action: String(data.a) };
}

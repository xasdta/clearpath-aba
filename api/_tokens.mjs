// Signed, expiring, single-purpose tokens for one-click email actions.
//
// A clinic gets "Do you have openings? [Yes] [We're full]" and must be able to answer in one
// click with no login. That link is the write path, so the token has to be unforgeable:
// nobody may flip another clinic's status, and a leaked link must expire.
//
// Format:  <payloadB64url>.<sigB64url>
// Payload: {k: subjectKey, a: action, e: expiryEpochSeconds, n: nonce}
// Sig:     HMAC-SHA256(payload, secret), constant-time compared.
//
// The secret is TOKEN_SECRET: in .env on the Mac (gitignored, 0600) and in the Vercel project
// env, so the site can verify a link the moment it is clicked. It used to live in a committed
// file; rotating it invalidated every link signed with the leaked value.
//
// Lives in api/ (underscore = not a route) so the Vercel functions can import it; lib/tokens.mjs
// re-exports it for the Mac-side jobs.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error("TOKEN_SECRET is not set");
  return s;
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

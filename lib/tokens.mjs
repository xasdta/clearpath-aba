// Signed, expiring action tokens for one-click email links.
//
// A clinic gets "Do you have openings? [Yes] [We're full]" — each link carries a token that
// names exactly one site, one action, and an expiry. Tokens are HMAC-signed so a clinic can
// never flip another clinic's status, and they are single-purpose so a leaked "yes" link
// cannot be replayed as anything else.
//
// The secret lives outside the repo (data/.secret, gitignored) and is generated on first use.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

const SECRET_PATH = new URL("../data/.secret", import.meta.url).pathname;

function secret() {
  if (process.env.CLEARPATH_TOKEN_SECRET) return process.env.CLEARPATH_TOKEN_SECRET;
  if (!existsSync(SECRET_PATH)) {
    writeFileSync(SECRET_PATH, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(SECRET_PATH, 0o600);
  }
  return readFileSync(SECRET_PATH, "utf8").trim();
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

/**
 * @param {object} payload  e.g. { sid: 123, act: "open" } — keep it tiny, it rides in a URL
 * @param {number} days     validity window; expired tokens are rejected, never silently accepted
 */
export function sign(payload, days = 45) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + days * 86400 };
  const data = b64u(JSON.stringify(body));
  const sig = b64u(createHmac("sha256", secret()).update(data).digest());
  return `${data}.${sig}`;
}

/** @returns {{ok: true, payload: object} | {ok: false, reason: string}} */
export function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "malformed" };
  const [data, sig] = token.split(".", 2);
  let expected;
  try {
    expected = createHmac("sha256", secret()).update(data).digest();
  } catch {
    return { ok: false, reason: "secret_unavailable" };
  }
  const given = unb64u(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "bad_signature" };
  let payload;
  try {
    payload = JSON.parse(unb64u(data).toString());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000))
    return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

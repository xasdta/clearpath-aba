/**
 * POST /api/submit — every form on the site, plus the one-click email links.
 *
 *   kind=inquiry | alert | unsubscribe | claim   plain form posts → 303 to a thanks page
 *   kind=respond (t=<signed token>)               fetch() from respond.html → JSON
 *   kind=insurance-check (t)                      insurance.html asks whether its link is valid
 *   kind=insurance (t, accepted=[plan keys])      insurance.html submits the clinic's plans → JSON
 *
 * Tokens are verified here so the clicker learns immediately whether the link worked; the
 * event is still re-verified when the Mac applies it. Needs env: INBOX_TOKEN, TOKEN_SECRET.
 */
import { rawBody, parseBody, clean, queue } from "./_inbox.mjs";
import { verifyToken } from "./_tokens.mjs";
import { PAYER_KEYS } from "./_payers.mjs";

export const config = { api: { bodyParser: false } };

const FIELDS = {
  inquiry: ["npi", "provider", "name", "contact", "insurance", "child_age", "message"],
  alert: ["email", "zip", "alert_city", "insurance", "child_age", "radius"],
  unsubscribe: ["email"],
  claim: ["clinic", "name", "role", "email", "npi", "license"],
};
const REQUIRED = {
  inquiry: ["npi", "name", "contact"],
  alert: ["email", "zip"],
  unsubscribe: ["email"],
  claim: ["clinic", "name", "email"],
};
// Actions a one-click link may carry. Anything else is refused even with a valid signature.
const LINK_ACTIONS = new Set(["accepting", "full", "claim-confirm", "claim-approve", "claim-reject"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("method not allowed");
  }
  const seeOther = (path) => { res.writeHead(303, { Location: path }); res.end(); };

  let f;
  try { f = parseBody(req, await rawBody(req)); }
  catch { return res.status(413).send("too large"); }
  const kind = String(f.kind || "");

  // Insurance links are their own token action, so a leaked availability link can't be used
  // to rewrite a clinic's plans and vice versa. The Mac re-verifies before writing anything.
  if (kind === "insurance-check" || kind === "insurance") {
    const t = String(f.t || "");
    const v = verifyToken(t);
    if (!v.ok || v.action !== "insurance") {
      return res.status(400).json({ ok: false, reason: v.ok ? "wrong_link" : v.reason });
    }
    if (kind === "insurance-check") return res.status(200).json({ ok: true, npi: v.siteKey });
    // Must be a JSON array of known keys. Anything else is refused rather than read as "no
    // plans", which would mark every plan not-accepted.
    const accepted = f.accepted;
    if (!Array.isArray(accepted) || accepted.length > PAYER_KEYS.length
        || !accepted.every((k) => typeof k === "string" && PAYER_KEYS.includes(k))) {
      return res.status(400).json({ ok: false, reason: "bad_plans" });
    }
    try {
      await queue("insurance", { t, accepted: [...new Set(accepted)] });
    } catch (err) {
      console.error("queue failed:", err.message);
      return res.status(503).json({ ok: false, reason: "unavailable" });
    }
    return res.status(200).json({ ok: true });
  }

  if (kind === "respond") {
    const v = verifyToken(String(f.t || ""));
    if (!v.ok || !LINK_ACTIONS.has(v.action)) {
      return res.status(400).json({ ok: false, reason: v.ok ? "unknown_action" : v.reason });
    }
    try {
      await queue("respond", { t: String(f.t) });
    } catch (err) {
      console.error("queue failed:", err.message);
      return res.status(503).json({ ok: false, reason: "unavailable" });
    }
    return res.status(200).json({ ok: true, action: v.action });
  }

  // Honeypot: bots fill every field. Pretend success so they learn nothing.
  if (f.botcheck) return seeOther("/thanks.html");
  if (!FIELDS[kind]) return res.status(400).send("unknown form");
  const data = clean(f, FIELDS[kind]);
  if (REQUIRED[kind].some((k) => !data[k])) return seeOther("/thanks.html?missing=1");
  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return seeOther("/thanks.html?missing=1");
  // Alerts match on ZIP + radius, so a bad ZIP would subscribe the family to nothing.
  if (kind === "alert" && !/^\d{5}$/.test(data.zip)) return seeOther("/thanks.html?missing=1");

  try {
    await queue(kind, data);
  } catch (err) {
    console.error("queue failed:", err.message);
    return res.status(503).send(
      "Sorry — we could not record that just now. Please try again in a minute, or email sabrsystemssoftware@gmail.com.");
  }
  return seeOther(kind === "claim" ? "/thanks.html?claim=1" : kind === "unsubscribe" ? "/thanks.html?unsub=1" : "/thanks.html");
}

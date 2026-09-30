/**
 * POST /api/stripe — Stripe webhook for featured listings.
 *
 * Verifies the signature, keeps only ABA Openings events (the Stripe account also sells ADU
 * Builder Index listings and every endpoint receives every event), and queues a minimal
 * record. Licence checks, slot caps, publishing and email all happen on the Mac, which has
 * the directory database. Needs env: STRIPE_WEBHOOK_SECRET, INBOX_TOKEN.
 */
import crypto from "node:crypto";
import { rawBody, queue } from "./_inbox.mjs";

export const config = { api: { bodyParser: false } };

const ABA_PAYMENT_LINK = "plink_1ULDMID7IxRBAZhGxnnB4JxP";

function verifySignature(raw, header, secret, tolerance = 300) {
  if (!header) throw new Error("missing stripe-signature header");
  if (!secret) throw new Error("missing webhook secret");
  let timestamp = null;
  const candidates = [];
  for (const part of String(header).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") candidates.push(v);
  }
  if (!timestamp || !/^\d+$/.test(timestamp)) throw new Error("no timestamp in signature");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest();
  let ok = false;
  for (const c of candidates) {
    if (!/^[0-9a-f]{64}$/i.test(c)) continue;
    const got = Buffer.from(c, "hex");
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) ok = true;
  }
  if (!ok) throw new Error("signature mismatch");
  if (Math.floor(Date.now() / 1000) - Number(timestamp) > tolerance) throw new Error("timestamp too old");
  return JSON.parse(raw);
}

// A custom field's value sits under its own type: {type:"numeric", numeric:{value}}.
function field(s, key) {
  const f = (s.custom_fields || []).find((x) => x.key === key);
  return f ? (f[f.type]?.value ?? null) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("method not allowed");
  }
  let event;
  try {
    event = verifySignature(await rawBody(req, 512 * 1024), req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("signature rejected:", err.message);
    return res.status(400).send("invalid signature");
  }

  let data = null;
  const o = event.data?.object || {};
  if (event.type === "checkout.session.completed" && o.payment_link === ABA_PAYMENT_LINK) {
    data = {
      type: "checkout", session: o.id, subscription: o.subscription || null,
      payment_status: o.payment_status, amount_total: o.amount_total, currency: o.currency,
      email: o.customer_details?.email || null,
      business: o.collected_information?.business_name || o.customer_details?.business_name
        || o.customer_details?.name || null,
      npi: field(o, "npi"), blurb: field(o, "blurb"), website: field(o, "website"),
    };
  } else if (event.type === "customer.subscription.deleted" && o.metadata?.site === "abaopenings") {
    data = { type: "subscription_ended", subscription: o.id };
  }
  if (!data) return res.status(200).json({ ignored: event.type });

  try {
    await queue("stripe", { event: event.id, ...data });
  } catch (err) {
    // 500 makes Stripe retry for up to 3 days, so a GitHub blip loses nothing.
    console.error("queue failed:", err.message);
    return res.status(500).send("queue failed");
  }
  return res.status(200).json({ ok: true });
}

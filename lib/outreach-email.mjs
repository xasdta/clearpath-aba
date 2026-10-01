// First-contact email to a listed clinic: "is your clinic taking new clients?"
//
// Genuine by construction: every fact in it is the clinic's own public record (its listing,
// its director's verified licence), the ask is one click, and the footer says plainly why they
// got it and how to stop. CAN-SPAM: truthful subject, identified sender, a physical postal
// address and a working unsubscribe in every message — send() refuses without an address.
import { mintToken } from "./tokens.mjs";
import { displayName } from "./names.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// "THOMPSON, JELISIA J" -> "Jelisia Thompson"
const personName = (s) => {
  const [last, rest = ""] = String(s || "").split(",").map((x) => x.trim());
  const first = rest.split(/\s+/).filter((w) => w.length > 1).join(" ");
  return displayName(`${first} ${last}`.trim());
};

// Everyday name for subject and greeting: drop "(…)" asides and the legal suffix, so
// "A Gifted Journey (Behavioral, Consulting and Advocacy)" reads as "A Gifted Journey".
const shortName = (full) => full.replace(/\s*\([^)]*\)\s*/g, " ").replace(/,?\s+(LLC|PLLC|Inc\.?|Corp\.?|Co\.?|LP|LLP|PA|PC)\.?$/i, "").replace(/\s+/g, " ").trim() || full;

const BRAND = { name: "ABA Openings", accent: "#0d6b5b", soft: "#e5f1ee", site: "https://abaopenings.com" };

export function clinicOutreach({ org, sender, postalAddress, ttlDays = 30, step = 1 }) {
  const fullName = displayName(org.name), name = shortName(fullName);
  const listing = `${BRAND.site}/providers/${org.npi}.html`;
  const t = (action, page = "respond") =>
    `${BRAND.site}/${page}.html?t=${encodeURIComponent(mintToken({ siteKey: org.npi, action, ttlDays }))}`;
  const yes = t("accepting"), full = t("full"), ins = t("insurance", "insurance");
  const unsub = `${BRAND.site}/unsubscribe.html`;
  const verified = org.ao_license_status === "active";
  const director = verified ? personName(org.ao_name) : null;

  // step 2 is the single follow-up: shorter, same one-click ask, then we stop for good.
  const followUp = step === 2;
  const subject = followUp ? `Quick follow-up: is ${name} taking new clients?` : `Is ${name} taking new clients?`;
  const intro = followUp
    ? `Following up once on my note last week — I won't keep emailing. Families on ABA Openings are looking for clinics near ${org.city} that can take a new client, and ${name}'s listing still says "not yet confirmed".`
    : `I run ABA Openings, a free directory that helps Texas families find ABA providers who can actually take a new client. ${name} is already listed — it's built from the federal NPI registry${verified ? `, and we've verified ${director}'s Texas behavior-analyst license` : ""}.`;
  const ask = "The first thing families want to know is whether you have room. Could you tell us?";
  const why = "Parents often call ten clinics before they find one with an opening. A current answer sends you families who can actually start — and saves your intake team the calls when you're full.";

  const text = `Hi ${name} team,

${intro}

Your listing: ${listing}

${ask}

  Yes, we're accepting:  ${yes}
  We're full right now:  ${full}

One click, no login, no cost. Your listing updates within the hour with today's date, and we'll
check back about once a month.

${why}

While you're there, you can also confirm which insurance plans you take:
  ${ins}

Thank you,
${sender.name}${sender.title ? `, ${sender.title}` : ""}
ABA Openings · abaopenings.com

—
Why you received this: ${name} is listed on ABA Openings from public records (NPI ${org.npi}).
Listing is free and always will be; we never charge per referral or per client.
${postalAddress}
Unsubscribe: ${unsub} (or reply "unsubscribe")`;

  const rows = [
    ["Location", `${esc(org.city)}, TX`],
    ["Texas license", verified ? `<span style="color:#0d6b5b;font-weight:600">✓ Active — ${esc(org.ao_license_no)}</span>` : "Not yet matched"],
    ["Taking new clients", `<span style="color:#8a5a15">Not yet confirmed</span>`],
    ["Insurance plans", `<span style="color:#8a5a15">Not yet confirmed</span>`],
  ];
  const html = shell({
    preheader: `One click to tell Texas families whether ${name} has openings.`,
    body: `
      ${p(`Hi ${esc(name)} team,`)}
      ${p(esc(intro))}
      ${factCard(esc(fullName), rows, listing, "View your listing →")}
      ${p(`<b>${esc(ask)}</b>`)}
      ${buttons([["Yes, we're accepting", yes, "primary"], ["We're full right now", full, "outline"]])}
      ${p(`<span style="color:#5d6d72;font-size:14px">One click, no login, no cost. Your listing updates within the hour with today's date, and we'll check back about once a month.</span>`)}
      ${callout(`<b>Why it matters:</b> ${esc(why)}`)}
      ${p(`While you're there, you can also <a href="${esc(ins)}" style="color:${BRAND.accent};font-weight:600">confirm which insurance plans you take</a>.`)}
      ${p(`Thank you,<br><b>${esc(sender.name)}</b>${sender.title ? `<br><span style="color:#5d6d72">${esc(sender.title)}</span>` : ""}<br><span style="color:#5d6d72">abaopenings.com</span>`)}`,
    footer: `Why you received this: ${esc(name)} is listed on ABA Openings from public records (NPI ${esc(org.npi)}). Listing is free and always will be; we never charge per referral or per client.<br>${esc(postalAddress)}<br><a href="${esc(unsub)}" style="color:#5d6d72">Unsubscribe</a> · <a href="${BRAND.site}" style="color:#5d6d72">abaopenings.com</a>`,
  });
  return { subject, text, html };
}

// ---------- email-safe building blocks (tables + inline styles only) ----------
const p = (h) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#182529">${h}</p>`;
const BTN = {
  primary: `background:${BRAND.accent};color:#ffffff;border:1px solid ${BRAND.accent}`,
  outline: `background:#ffffff;color:${BRAND.accent};border:1px solid ${BRAND.accent}`,
};
const buttons = (list) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:2px 0 14px"><tr>${list.map(([label, url, kind]) =>
  `<td style="padding:0 10px 10px 0"><a href="${esc(url)}" style="${BTN[kind]};display:inline-block;padding:13px 22px;border-radius:8px;font-size:16px;font-weight:600;text-decoration:none">${esc(label)}</a></td>`).join("")}</tr></table>`;
const callout = (h) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr><td style="background:${BRAND.soft};border-left:3px solid ${BRAND.accent};border-radius:6px;padding:12px 16px;font-size:15px;line-height:1.55;color:#182529">${h}</td></tr></table>`;
const factCard = (title, rows, link, linkLabel) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border:1px solid #dde5e3;border-radius:10px">
  <tr><td style="padding:14px 18px 6px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#87979c">Your listing</td></tr>
  <tr><td style="padding:0 18px 8px;font-size:18px;font-weight:700;color:#182529">${title}</td></tr>
  ${rows.map(([k, v]) => `<tr><td style="padding:6px 18px;border-top:1px solid #eef2f1"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;color:#5d6d72;width:44%">${k}</td><td style="font-size:14px;color:#182529">${v}</td></tr></table></td></tr>`).join("")}
  <tr><td style="padding:10px 18px 14px;border-top:1px solid #eef2f1"><a href="${esc(link)}" style="color:${BRAND.accent};font-size:14px;font-weight:600;text-decoration:none">${linkLabel}</a></td></tr>
</table>`;
const shell = ({ preheader, body, footer }) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f3f6f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f5"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border:1px solid #dde5e3;border-radius:14px;overflow:hidden">
    <tr><td style="background:${BRAND.accent};padding:18px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:#ffffff;color:${BRAND.accent};width:28px;height:28px;border-radius:7px;text-align:center;font-weight:800;font-size:16px">✓</td>
        <td style="padding-left:10px;color:#ffffff;font-size:17px;font-weight:700">ABA <span style="color:#bfe6dc">Openings</span></td>
      </tr></table></td></tr>
    <tr><td style="padding:28px 28px 10px">${body}</td></tr>
    <tr><td style="padding:16px 28px 22px;border-top:1px solid #eef2f1;background:#fafbfb;font-size:12px;line-height:1.6;color:#87979c">${footer}</td></tr>
  </table>
</td></tr></table>
</body></html>`;

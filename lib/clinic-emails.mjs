// The monthly "are you accepting new clients?" email, as text + HTML. One source so the
// scheduled job, previews and tests all send exactly the same words.
import { actionEmail } from "./email-html.mjs";

// NPPES names are all caps ("A GIFTED JOURNEY ( BEHAVIORAL, CONSULTING AND ADVOCACY)"). Shouting
// a clinic's own name at it reads like a mail merge, so title-case it and keep real acronyms.
const KEEP = new Set(["ABA", "LLC", "PLLC", "LLP", "LP", "PA", "PC", "BCBA", "TX", "USA", "II", "III", "DBA"]);
const SMALL = new Set(["and", "of", "the", "for", "in", "at", "to", "a", "an", "&"]);
export function displayName(raw) {
  return String(raw || "").trim().replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+,/g, ",")
    .toLowerCase().split(/\s+/).map((w, i) => {
      const bare = w.replace(/[^a-z&]/gi, "").toUpperCase();
      if (KEEP.has(bare)) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.split("-").map((part) => part.replace(/[a-z]/, (c) => c.toUpperCase())).join("-");
    }).join(" ");
}

export function askClinicEmail({ name: rawName, siteKey, yesUrl, fullUrl, site, contact }) {
  const name = displayName(rawName);
  const listing = `${site}/providers/${siteKey}.html`;
  const subject = `${name}: are you accepting new clients?`;
  const text = `Hi ${name},

You're listed on ABA Openings, a free directory Texas families use to find ABA providers who
can actually take a new client. Families filter for exactly one thing: who has room.

Can you take new clients right now?

  Yes, we're accepting:  ${yesUrl}
  No, we're full:        ${fullUrl}

One click, no login, and your listing updates within the hour. If we don't hear back we mark your
status as unconfirmed rather than guessing — an out-of-date "yes" wastes a family's phone call
and your intake team's time.

Your listing: ${listing}

— ABA Openings
${contact} · Reply "stop" and we won't email again.`;
  const html = actionEmail({
    preheader: "One click, no login — your listing updates within the hour.",
    greeting: `Hi ${name},`,
    paras: [
      "You're listed on ABA Openings, a free directory Texas families use to find ABA providers who can actually take a new client. Families filter for exactly one thing: who has room.",
      "Can you take new clients right now?",
    ],
    buttons: [
      { label: "Yes, we're accepting", url: yesUrl, kind: "primary" },
      { label: "No, we're full", url: fullUrl, kind: "secondary" },
    ],
    after: [
      "One click, no login, and your listing updates within the hour. If we don't hear back we mark your status as unconfirmed rather than guessing — an out-of-date \"yes\" wastes a family's phone call and your intake team's time.",
    ],
    footer: [`Your listing: ${listing}`, `ABA Openings · ${contact}`, `Reply "stop" and we won't email again.`],
  });
  return { subject, text, html };
}

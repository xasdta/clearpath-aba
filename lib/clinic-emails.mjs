// The monthly "are you accepting new clients?" email, as text + HTML. One source so the
// scheduled job, previews and tests all send exactly the same words.
import { actionEmail } from "./email-html.mjs";
import { displayName } from "./names.mjs";
export { displayName };

export function askClinicEmail({ name: rawName, siteKey, yesUrl, fullUrl, insuranceUrl, site, contact }) {
  const name = displayName(rawName);
  const listing = `${site}/providers/${siteKey}.html`;
  const subject = `${name}: are you accepting new clients?`;
  const text = `Hi ${name},

You're listed on ABA Openings, a free directory Texas families use to find ABA providers who
can actually take a new client. Families filter for exactly one thing: who has room.

Can you take new clients right now?

  Yes, we're accepting:  ${yesUrl}
  No, we're full:        ${fullUrl}

Which insurance plans do you take? Families filter by plan too:

  Update your plans:     ${insuranceUrl}

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
    after: ["Which insurance plans do you take? Families filter by plan too — tick yours in under a minute."],
    buttons2: [{ label: "Update our insurance plans", url: insuranceUrl, kind: "outline" }],
    after2: [
      "One click, no login, and your listing updates within the hour. If we don't hear back we mark your status as unconfirmed rather than guessing — an out-of-date \"yes\" wastes a family's phone call and your intake team's time.",
    ],
    footer: [`Your listing: ${listing}`, `ABA Openings · ${contact}`, `Reply "stop" and we won't email again.`],
  });
  return { subject, text, html };
}

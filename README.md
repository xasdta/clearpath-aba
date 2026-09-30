# ABA Openings

License-verified ABA/autism therapy directory for Texas. **2,087 static pages** generated from
public records — the federal NPI registry joined to the Texas TDLR licensing roster — deployed
to Vercel, monetized with flat-fee featured listings.

Implements [Plan 01](../plans/01-aba-autism-therapy-directory.md) from the Directory Ventures
portfolio. Zero runtime dependencies (`node:sqlite`, `node:http`; Node ≥ 22.5).

## The premise

Most autism-therapy directories list whoever signs up. ABA Openings starts from public records —
every ABA organization in the federal registry — then verifies licenses against the state roster
and confirms insurance and waitlists by phone. **When something isn't verified, the page says so.**

## Commands

```sh
npm run pipeline    # fetch public records → build directory.db → generate site → prospects
npm run build       # regenerate docs/ from the existing DB
npm run serve       # build + preview at localhost:8430
npm run ops         # local verification console (record phone calls) — never deploy this
npm run refresh     # weekly: refetch, rebuild, commit, push (Vercel redeploys)
```

## What's live

| Layer | State |
|---|---|
| Organizations | 1,379 Texas ABA orgs (NPPES taxonomy 103K00000X) |
| Licenses | 9,549 TDLR behavior-analyst records (7,066 active) via data.texas.gov `7358-krk7` |
| Verification | 467 orgs (33.9%) with a positively matched **active** license, date-stamped |
| Insurance | 6 payers per site, all `unverified` until a phone call is recorded |
| Waitlist | Collected by call; **hard-expires at 90 days** and says so |
| Pages | 1,379 provider profiles · 269 city hubs · 690 city×payer pages · access report · license lookup · methodology · for-clinics |

## Publishing rule (enforced in `scripts/generate.mjs`)

**We publish positive verification only.** A unique match to an *active* license earns a dated
"license verified" badge. Everything else renders neutrally as "license not confirmed" — we never
publicly assert that a named business's license is expired or invalid on the strength of a
heuristic name match. Non-matches are usually name variants, not wrongdoing.

We also do not scrape the BACB registry (its terms prohibit harvesting and commercial
republication). BACB certification is checked one record at a time at claim time, and we store
only the fact and date of the check.

## Monetization

Flat monthly featured listings — **$199/mo founding rate** (locked), $399 standard, **3 slots per
city**, always labeled. Verified first, then billed.

Never: pay-for-placement in the regular directory, per-referral or per-client fees (which keeps
clinics with Medicaid volume clean under federal and state anti-kickback rules), or selling family
contact data.

## Configuration

`site.config.json` holds the public settings. Empty values disable their feature gracefully
rather than shipping broken UI:

| Key | Effect when empty |
|---|---|
| `domain` | canonicals/sitemap use relative URLs |
| `stripeFeaturedLink` | featured CTA falls back to an email link |

## Deploy

`docs/` is prebuilt and committed; Vercel serves it with no build step (`vercel.json` sets
`outputDirectory: docs`). Connect the GitHub repo in the Vercel dashboard, then set `domain` in
`site.config.json`, rebuild, and push.

## Data sources

- **NPPES / NPI Registry** — public record, no use restrictions.
- **Texas TDLR roster** via data.texas.gov (Socrata `7358-krk7`) — public record. Note: TDLR's own
  `ltbehana.csv` bulk file currently returns "No Records"; the open-data portal is the working source.

## Next

1. Phone-verification sprint on the 467 verified clinics in DFW/Houston/SA/Austin (`npm run ops`).
2. Individual NPI-1 ingestion + clinician↔org rollup to raise the 33.9% match rate.
3. Set Stripe link + Web3Forms key; connect domain; submit sitemap to Search Console.
4. Physician-referral mailer (the 42% intake channel) per `outreach/emails.md`.

## Automation

### Site events (forms, one-click links, Stripe) — no human in the loop except claim approval

```
browser / Stripe ──> docs/api/submit.mjs, stripe.mjs   (Vercel: validate + verify, then queue)
                          │  one JSON file per event
                          ▼
             xasdta/abaopenings-inbox   (PRIVATE repo — family contact details never go public)
                          │  every 10 min (launchd: com.abaopenings.inbox)
                          ▼
             jobs/apply-inbox.mjs   (Mac: rules + ops.db + email, then generate → commit → push)
```

| Event | Handled automatically |
|---|---|
| Clinic clicks "accepting" / "full" | availability recorded, listing rebuilt and pushed |
| Family inquiry | forwarded to the clinic if we hold its email, else to the owner; family gets a copy |
| Alert signup / unsubscribe | subscriber added / suppressed |
| Claim | NPI + TDLR licence checked → claimant confirms email → **owner clicks Approve** → published, clinic enters the monthly ask loop |
| Featured purchase ($199/mo payment link) | NPI, verified licence, city cap checked → card published, both sides emailed; otherwise refunded (automatic if `STRIPE_API_KEY` is set) |
| Subscription ends | card removed |

Claims keep one human click on purpose: a licence number is public, so nothing in a web form
proves identity, and auto-publishing would let a stranger put their contact details on a
competitor's listing.

Source for the functions is `api/`; `generate.mjs` copies it into `docs/api/` because `docs/` is
the Vercel root. Vercel env: `TOKEN_SECRET`, `INBOX_TOKEN` (Contents RW on the inbox repo only,
expires 2027-09-29), `STRIPE_WEBHOOK_SECRET`. Mac `.env` (0600, gitignored): `TOKEN_SECRET`
(same value), `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM`, optional `STRIPE_API_KEY`. The Mac
reads the inbox with the `gh` login.

### Scheduled jobs

These jobs run on a schedule so the openings data maintains itself instead of depending on
anyone remembering. Install them with `./scripts/install-launchd.sh` (macOS launchd — chosen
over cron because it re-runs missed jobs after the Mac wakes).

| Job | Schedule | What it does |
|---|---|---|
| `ask-clinics` | daily 09:05 | Emails clinics whose status is older than 30 days: "accepting? [Yes] [Full]" — one click, no login |
| `family-alerts` | daily 09:05 | Emails waiting families when a clinic near them confirms an opening |
| `license-expiry` | daily 09:05 | Warns a clinic 30 days before the licence behind its verified badge lapses |
| `health-check` | daily 09:05 | Flags collapsed record counts, job failures, mail failures |
| `owner-digest` | Mon 08:00 | Weekly summary: openings, calls, inquiries, claims, subscribers |
| `apply-inbox` | every 10 min | Applies queued site events (above) |
| `refresh.sh` | Mon 06:00 | Re-pull public records → rebuild → commit → push (Vercel redeploys) |

Run any job by hand: `node jobs/run.mjs <name>` (or `all`).

### Safety properties

- **Dry run by default.** Nothing sends until `MAIL_PROVIDER` and `MAIL_API_KEY` are set;
  until then every message is written to `logs/outbox.log`. The failure mode of a half-built
  mailer is emailing 1,379 real businesses by accident, so the safe state is the default.
- **Idempotent.** Every send carries a dedupe key recorded in `ops.mail_log`; re-running a job
  after a crash sends nothing twice. Verified by test.
- **Thundering-herd capped.** A newly confirmed opening notifies at most 5 families (longest
  waiting first), each family hears about a given clinic once ever, and no family gets more
  than one alert a week. A clinic with two slots must not receive 400 phone calls.
- **Suppression is absolute.** An unsubscribe or hard bounce is honoured everywhere, checked
  both in the job query and again inside the mailer. Verified by test.
- **Send ceiling.** `MAIL_MAX_PER_RUN` (default 100) caps any single run, so a logic bug costs
  a handful of emails rather than a domain reputation.
- **Every run is recorded** in `ops.job_runs`; failures surface in the weekly digest and the
  health check rather than disappearing.

### One-click responses

Clinic emails contain signed, expiring tokens (`api/_tokens.mjs`, HMAC-SHA256, 45-day TTL,
constant-time comparison). The link lands on `/respond.html`, which posts it to `/api/submit`;
the signature is verified there and again when the Mac applies it, so a forged or expired link
changes nothing. The ops console's `/apply` page still works for a pasted token. Tampered, malformed and expired tokens are all rejected (verified by test).

### Enabling real sending

Live since 2026-09-30: `.env` sets `MAIL_PROVIDER=resend` and sends from
`hello@abaopenings.com` (domain verified in Resend; DKIM/SPF/DMARC records are in Vercel DNS).
Every scheduled job reads `.env`, so nothing secret lives in the plists. Delete
`MAIL_PROVIDER` from `.env` to drop back to dry run (messages go to `logs/outbox.log`).

### Where clinic email addresses come from

`ops.clinic_contacts`, populated when a clinic claims its listing or when you capture an
address during a verification call (the ops console asks for it). NPPES does not publish
emails and we do not scrape or guess them, so the self-report loop grows only as fast as you
collect real contacts — phone calls first, automation second.

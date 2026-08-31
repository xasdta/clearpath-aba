# ClearPath ABA

License-verified ABA/autism therapy directory for Texas. **2,087 static pages** generated from
public records — the federal NPI registry joined to the Texas TDLR licensing roster — deployed
to Vercel, monetized with flat-fee featured listings.

Implements [Plan 01](../plans/01-aba-autism-therapy-directory.md) from the Directory Ventures
portfolio. Zero runtime dependencies (`node:sqlite`, `node:http`; Node ≥ 22.5).

## The premise

Most autism-therapy directories list whoever signs up. ClearPath starts from public records —
every ABA organization in the federal registry — then verifies licenses against the state roster
and confirms insurance and waitlists by phone. **When something isn't verified, the page says so.**

## Commands

```sh
npm run pipeline    # fetch public records → build DB → generate site → build prospect list
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
| `web3formsKey` | forms fall back to `mailto:` |

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

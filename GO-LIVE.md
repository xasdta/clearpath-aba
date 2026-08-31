# Go-live checklist

The site is built, pushed, and deployed. These are the steps only you can do — each one
unblocks a feature that is already coded and waiting for its value.

## 1. Deployment  ✅ done

Live, claimed, renamed to `clearpath-aba`, and connected to GitHub with
**Root Directory = `docs`** (Framework Preset: Other, no build command override —
output directory correctly defaults to the root directory itself).

Every push to `main` now redeploys automatically, which is what `scripts/refresh.sh`
relies on for the weekly data refresh.

## 2. Domain

Buy a domain (clearpathaba.com or similar), add it in Vercel → Settings → Domains, then:

```sh
# set "domain": "clearpathaba.com" in site.config.json, then
npm run build && git add -A && git commit -m "Point canonicals at production domain" && git push
```

This is required for valid canonical tags and a valid `sitemap.xml` — until a domain is set,
sitemap URLs are relative and search engines will reject the file.

## 3. Payments (Stripe)

1. Stripe Dashboard → Payment links → New → recurring, **$199/month**, name it
   "ClearPath ABA — Founding Featured Listing (city)".
2. Paste the `https://buy.stripe.com/...` URL into `stripeFeaturedLink` in `site.config.json`.
3. `npm run build && git commit -am "Wire Stripe featured listing link" && git push`

Until then the featured CTA falls back to an email link, so the page still works.

**Billing discipline (from the plan):** verify the clinic's license and listing details *before*
the slot goes live. Flat monthly only — never per-referral or per-client fees, which is what
keeps this clean under federal and state anti-kickback rules for clinics with Medicaid volume.

## 4. Forms (Web3Forms)

Get a free access key at web3forms.com, put it in `web3formsKey`, rebuild, push. Until then all
forms fall back to `mailto:` — functional but higher friction. Also set up the two mailboxes
referenced on the site: `hello@` and `corrections@`.

## 5. Search Console

Add the property, submit `/sitemap.xml`, and request indexing for the highest-intent pages
first: `/tx/houston`, `/tx/dallas`, `/tx/san-antonio`, `/tx/austin`, their `accepts-*` variants,
and `/texas-aba-access-report.html`.

## 6. Start earning

The revenue path in priority order:

1. **Verification sprint.** `npm run ops` → work the phone queue for Houston, Dallas, San
   Antonio, Austin. Each call fills insurance + waitlist for one clinic. Target 300 sites. This
   is the moat and the sales pitch simultaneously — a clinic whose profile shows "Accepting
   clients, Aetna confirmed" is the one that converts.
2. **Outreach.** `outreach/prospects.csv` holds **467 license-verified clinics with phone
   numbers**, sorted by metro size. Use the sequence in `outreach/emails.md` — small
   personalized batches from a real mailbox, never bulk. CAN-SPAM requires a physical address
   and a working opt-out in every commercial email.
3. **Physician mailer.** The plan's sleeper channel: online search drives only ~11% of ABA
   intake while physician referral drives ~42%. Mail developmental pediatricians and ECI
   coordinators a one-page waitlist map of their metro. Costs postage; reaches families at
   diagnosis.

**Honest expectation:** the site launched today with no traffic history. Founding pricing at
$199 (vs. $399 standard) exists precisely because early clinics are taking the traffic risk.
Don't quote traffic numbers you don't have — the templates in `outreach/reply-templates.md`
handle that question directly.

## Kill criteria (day 90, from the plan)

Stop if two or more hold: under 10k organic impressions/month with 200+ pages indexed and no
upward slope; under 8% of phone-verified clinics claiming despite free leads; more than half of
delivered leads rated unqualified; verification cost above $25/site with no path to automation.

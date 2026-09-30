// The insurance plans a clinic can confirm. This key list is the allowlist for the insurance
// form: api/submit.mjs rejects any other key, and jobs/apply-inbox.mjs checks again before it
// writes, so a crafted request can never create a new plan or smuggle text into a page.
// Keys match ops.payer_acceptance.payer and the PAYERS maps in scripts/generate.mjs and ops.mjs.
export const PAYER_KEYS = ["aetna", "bcbs-texas", "cigna", "unitedhealthcare", "texas-medicaid", "tricare"];

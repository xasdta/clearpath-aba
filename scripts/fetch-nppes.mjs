// Fetch all Texas organizational NPIs (NPI-2) in the Behavior Analyst taxonomy (103K00000X)
// from the free NPPES NPI Registry API. Public record, no use restrictions.
// The API caps skip at 1000 (max 1,200 records per query), so we bucket by postal prefix
// and split any bucket that hits the cap.

import { writeFileSync, mkdirSync } from "node:fs";

const API = "https://npiregistry.cms.hhs.gov/api/";
const OUT = new URL("../data/raw/nppes-tx-orgs.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(params, skip) {
  const qs = new URLSearchParams({
    version: "2.1",
    enumeration_type: "NPI-2",
    taxonomy_description: "Behavior Analyst",
    state: "TX",
    address_purpose: "LOCATION",
    limit: "200",
    skip: String(skip),
    ...params,
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${API}?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.Errors) throw new Error(JSON.stringify(body.Errors));
      return body.results ?? [];
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(1500 * attempt);
    }
  }
}

async function bucket(postalPrefix, found) {
  let collected = 0;
  for (let skip = 0; skip <= 1000; skip += 200) {
    const results = await page({ postal_code: `${postalPrefix}*` }, skip);
    for (const r of results) found.set(r.number, r);
    collected += results.length;
    process.stdout.write(`  ${postalPrefix}*: +${results.length} (bucket ${collected}, total ${found.size})\n`);
    if (results.length < 200) return { capped: false };
    await sleep(400);
  }
  return { capped: true }; // hit the 1,200 ceiling; caller must split
}

const found = new Map();
const queue = ["73", "75", "76", "77", "78", "79", "88"];
while (queue.length) {
  const prefix = queue.shift();
  const { capped } = await bucket(prefix, found);
  if (capped) {
    console.log(`  bucket ${prefix}* capped — splitting`);
    for (let d = 0; d <= 9; d++) queue.push(`${prefix}${d}`);
  }
}

mkdirSync(new URL("../data/raw/", import.meta.url), { recursive: true });
const orgs = [...found.values()];
writeFileSync(OUT, JSON.stringify(orgs, null, 1));
console.log(`\nSaved ${orgs.length} TX behavior-analyst organizations -> ${OUT.pathname}`);

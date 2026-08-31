// Fetch all Texas Licensed Behavior Analysts + Licensed Assistant Behavior Analysts
// from the TDLR licensing dataset on the state open-data portal (Socrata, public record).
// Dataset: https://data.texas.gov/resource/7358-krk7

import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "https://data.texas.gov/resource/7358-krk7.json";
const OUT = new URL("../data/raw/tdlr-behavior-analysts.json", import.meta.url);
const TYPES = ["Licensed Behavior Analyst", "Licensed Assistant Behavior Analyst"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
for (const type of TYPES) {
  for (let offset = 0; ; offset += 5000) {
    const qs = new URLSearchParams({
      license_type: type,
      $limit: "5000",
      $offset: String(offset),
      $order: "license_number",
    });
    const res = await fetch(`${BASE}?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} at offset ${offset}`);
    const batch = await res.json();
    rows.push(...batch);
    console.log(`${type}: +${batch.length} (total ${rows.length})`);
    if (batch.length < 5000) break;
    await sleep(300);
  }
}

mkdirSync(new URL("../data/raw/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`Saved ${rows.length} TDLR license records -> ${OUT.pathname}`);

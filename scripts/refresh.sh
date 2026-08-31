#!/bin/bash
# Weekly data refresh: re-pull public records, rebuild the DB and the static site, commit.
# Run from the project root:  ./scripts/refresh.sh
# Schedule (Mondays 6am):     0 6 * * 1 cd /Users/xasdta/Projects/directory-ventures/clearpath-aba && ./scripts/refresh.sh >> logs/refresh.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
echo "=== ClearPath refresh $(date '+%Y-%m-%d %H:%M') ==="

node scripts/fetch-nppes.mjs
node scripts/fetch-tdlr.mjs
node scripts/etl.mjs
node scripts/generate.mjs
node scripts/build-prospects.mjs

if [[ -n "$(git status --porcelain docs data)" ]]; then
  git add docs data
  git commit -q -m "Weekly data refresh $(date '+%Y-%m-%d')

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push -q origin main && echo "Pushed — Vercel will redeploy automatically."
else
  echo "No data changes this week."
fi
echo "=== done $(date '+%H:%M') ==="

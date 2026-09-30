#!/bin/bash
# Install the ABA Openings scheduled jobs as macOS launchd agents.
#   ./scripts/install-launchd.sh          install/reload
#   ./scripts/install-launchd.sh remove   uninstall
#
# launchd is used rather than cron because it re-runs a missed job after the Mac wakes,
# which matters for a laptop that sleeps overnight.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" logs launchd

write_plist () {  # name, hour|every:<seconds>, minute, weekday(optional), program-args...
  local name=$1 hour=$2 minute=$3 weekday=$4; shift 4
  local when
  if [[ $hour == every:* ]]; then
    when="<key>StartInterval</key><integer>${hour#every:}</integer>"
  else
    local cal="<key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$minute</integer>"
    [ -n "$weekday" ] && cal="$cal<key>Weekday</key><integer>$weekday</integer>"
    when="<key>StartCalendarInterval</key><dict>$cal</dict>"
  fi
  local args=""
  for a in "$@"; do args="$args<string>$a</string>"; done
  cat > "launchd/$name.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$name</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  $when
  <key>StandardOutPath</key><string>$ROOT/logs/$name.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$name.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><false/>
</dict></plist>
PLIST
  cp "launchd/$name.plist" "$AGENTS/$name.plist"
}

if [ "${1:-install}" = "remove" ]; then
  for n in com.abaopenings.jobs com.abaopenings.refresh com.abaopenings.digest com.abaopenings.inbox; do
    launchctl bootout "gui/$(id -u)/$n" 2>/dev/null || true
    rm -f "$AGENTS/$n.plist"
    echo "removed $n"
  done
  exit 0
fi

# Daily 09:05 — ask clinics, alert families, licence nudges, health check
write_plist com.abaopenings.jobs 9 5 "" "$NODE" "$ROOT/jobs/run.mjs" all
# Mondays 06:00 — refresh public records, rebuild, push (Vercel redeploys)
write_plist com.abaopenings.refresh 6 0 2 /bin/bash "$ROOT/scripts/refresh.sh"
# Mondays 08:00 — owner digest
write_plist com.abaopenings.digest 8 0 2 "$NODE" "$ROOT/jobs/run.mjs" owner-digest
# Every 10 min — apply queued form posts, one-click answers and Stripe payments
write_plist com.abaopenings.inbox every:600 0 "" "$NODE" "$ROOT/jobs/apply-inbox.mjs"

for n in com.abaopenings.jobs com.abaopenings.refresh com.abaopenings.digest com.abaopenings.inbox; do
  launchctl bootout "gui/$(id -u)/$n" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$n.plist"
  echo "loaded $n"
done
echo
echo "Scheduled:"
echo "  daily  09:05  jobs (ask clinics, family alerts, licence nudges, health check)"
echo "  Mon    06:00  data refresh + rebuild + push"
echo "  Mon    08:00  owner digest"
echo "  every  10 min apply inbox (forms, one-click answers, Stripe)"
echo
echo "Secrets (TOKEN_SECRET, MAIL_*) are read from .env. Mail is in DRY RUN until MAIL_PROVIDER and MAIL_API_KEY are set there."
echo "Check status:  launchctl list | grep abaopenings"

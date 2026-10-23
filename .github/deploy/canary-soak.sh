#!/bin/bash
# Phase 1 canary soak: run on the first node (the main VM) right after its deploy, before any
# other node gets the build. Fails when, during SOAK_SECONDS, /health/ready fails, an ol-api or
# ol-worker process restarts (crash loop), or more than MAX_5XX responses are 5xx. The workflow
# then rolls this node back to the previous release and stops the rollout.
#
# Env: APP_USER (default olapp), SOAK_SECONDS (default 120), MAX_5XX (default 5),
#      CHECK_API (1 = this node serves ol-api; 0 = workers only)
set -u
APP_USER="${APP_USER:-olapp}"
SOAK_SECONDS="${SOAK_SECONDS:-120}"
MAX_5XX="${MAX_5XX:-5}"
CHECK_API="${CHECK_API:-1}"
LOG="$(getent passwd "$APP_USER" | cut -d: -f6)/.pm2/logs/ol-api-out.log"

restarts() {
  sudo -u "$APP_USER" pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let n = 0
      try { for (const p of JSON.parse(s)) if (/^ol-(api|worker)/.test(p.name)) n += (p.pm2_env.restart_time || 0) + (p.pm2_env.status === "online" ? 0 : 1000) } catch { n = -1 }
      console.log(n)
    })'
}

start_size=$( [ -f "$LOG" ] && stat -c %s "$LOG" || echo 0 )
start_restarts=$(restarts)
fails=0
echo "canary soak: ${SOAK_SECONDS}s, max ${MAX_5XX} 5xx, restarts at start ${start_restarts}"
for ((t = 0; t < SOAK_SECONDS; t += 10)); do
  sleep 10
  if [ "$CHECK_API" = 1 ] && ! curl -fsS -m 5 http://127.0.0.1:3000/health/ready >/dev/null; then
    fails=$((fails + 1)); echo "t=$((t + 10))s /health/ready failed"
  fi
done

end_size=$( [ -f "$LOG" ] && stat -c %s "$LOG" || echo 0 )
# pm2-logrotate may have rotated the file mid-soak; then count the whole new file.
[ "$end_size" -lt "$start_size" ] && start_size=0
errors=0
if [ "$CHECK_API" = 1 ] && [ -f "$LOG" ]; then
  errors=$(tail -c +"$((start_size + 1))" "$LOG" | grep '"request completed"' | grep -c '"statusCode":5[0-9][0-9]')
fi
end_restarts=$(restarts)
echo "health failures ${fails}, 5xx ${errors}, restarts ${start_restarts} -> ${end_restarts}"

bad=0
[ "$fails" -gt 0 ] && { echo "CANARY FAIL: /health/ready failed ${fails} time(s)"; bad=1; }
[ "$errors" -gt "$MAX_5XX" ] && { echo "CANARY FAIL: ${errors} 5xx responses"; bad=1; }
{ [ "$start_restarts" = -1 ] || [ "$end_restarts" != "$start_restarts" ]; } && { echo "CANARY FAIL: process restart or pm2 unreadable"; bad=1; }
[ "$bad" = 0 ] && echo "CANARY OK"
exit "$bad"

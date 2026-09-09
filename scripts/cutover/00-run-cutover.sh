#!/usr/bin/env bash
#
# CUTOVER ORCHESTRATOR — run on the GCE VM after the operator has produced a
# dump with 01-dump-prodv2.sh.
#
# Ordering exists to keep the downtime window short. Two things were moved out
# of it after the 2026-09-09 rehearsal measured them:
#
#   * `rclone check` hashes ~42k objects and takes ~40 minutes. It is a
#     read-only audit, so it runs AFTER DNS, not inside the freeze.
#   * The smoke suite runs twice — once against the load balancer IP while
#     traffic is still on AWS (so a failure costs nothing and DNS never moves),
#     and again over real DNS afterwards to prove the public path.
#
# What actually gates the window: restore (~10s), post-restore (~25s), object
# delta copy (seconds), smoke (~30s).
#
#   sudo AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… \
#        DUMP_KEY=db-migration/prod-….dump DUMP_SHA=… \
#        SMOKE_IDENTIFIER=… SMOKE_PASSWORD=… SMOKE_PROVIDER=publicId \
#        bash 00-run-cutover.sh
#
#   DRY_RUN=1  rehearse: restore + post-restore dry run + smoke, no DNS prompt
set -uo pipefail
cd "$(dirname "$0")"

: "${DUMP_KEY:?set DUMP_KEY from step 1}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID (ol-s3-migration)}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
HOST="${HOST:-api.offoolive.com}"
LB_IP="${LB_IP:-136.68.81.230}"
DRY="${DRY_RUN:-0}"

T0=$(date +%s)
banner() { printf '\n\033[1;36m════ %s ════\033[0m  (+%ss)\n' "$1" "$(( $(date +%s) - T0 ))"; }
die() { printf '\n\033[31mABORTED: %s\033[0m\n' "$1" >&2; exit 1; }

banner "1/6  Restore database"
bash 02-restore-gcp.sh || die "restore failed — nothing has changed on AWS, investigate and retry"

banner "2/6  Object delta (copy only — hash check deferred until after DNS)"
SKIP_CHECK=1 MAX_AGE="${MAX_AGE:-72h}" bash 03-rclone-delta.sh \
  || echo "  WARNING: delta reported a problem; review before continuing"

banner "3/6  Post-restore: migrate, seeds+views, URL rewrite, face re-index"
if [ "$DRY" = "1" ]; then
  bash 04-post-restore.sh --dry-run || die "post-restore dry run failed"
else
  bash 04-post-restore.sh || die "post-restore failed"
fi

banner "4/6  Smoke test against the GCP load balancer (traffic still on AWS)"

# The restore just overwrote the fixture account's password with production's,
# so the authenticated tier would degrade to SKIP without this — the suite would
# report "safe to proceed" having exercised nothing but anonymous 401s.
# Runs from the app directory because Prisma resolves its engine relative to cwd.
if [ -n "${SMOKE_PASSWORD:-}" ] && [ -n "${SMOKE_IDENTIFIER:-}" ]; then
  APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
  cp reset-smoke-fixture.js "$APP_DIR/reset-smoke-fixture.js"
  chown "${APP_USER:-olapp}" "$APP_DIR/reset-smoke-fixture.js"
  sudo -u "${APP_USER:-olapp}" bash -c \
    "cd $APP_DIR && set -a && . ./.env && set +a && \
     PID='$SMOKE_IDENTIFIER' NEWPW='$SMOKE_PASSWORD' node reset-smoke-fixture.js" \
    || echo "  WARNING: fixture reset failed — authenticated checks will be skipped"
  rm -f "$APP_DIR/reset-smoke-fixture.js"
fi

# RUN_ON_VM covers data + integrations; the --resolve pass covers TLS and the
# public path. Both must pass before anyone touches DNS.
RUN_ON_VM=1 bash 05-smoke-test.sh || die "smoke test failed — DO NOT MOVE DNS"

if [ "$DRY" = "1" ]; then
  banner "DRY RUN COMPLETE"
  echo "  Rehearsal finished in $(( $(date +%s) - T0 ))s. DNS untouched."
  exit 0
fi

banner "5/6  DNS CHANGE REQUIRED — operator action"
cat <<EOF

  Everything above is reversible. This step is not.

  In Vercel DNS for offoolive.com, replace the CNAME with an A record.
  They are CNAMEs today and GCP is an IP, so this is a TYPE change:

     DELETE  CNAME  api  -> ol-prod-alb-569195065.ap-south-1.elb.amazonaws.com
     CREATE  A      api  -> $LB_IP        (TTL 60)

  Do 'api' first and alone. Repeat for 'live' only after it verifies.
  TTL is already 60s, so rollback propagates in about a minute.

  *** DO NOT MOVE 'admins3jinyu' ***
  The admin panel is static Vue served by nginx on the EC2. The GCP load
  balancer has no backend for it and answers 404 on every path, so moving
  that record takes the admin panel down. It stays on AWS until the SPA is
  hosted on GCP separately (GCS bucket or Firebase Hosting) — which means
  the EC2 must stay alive after this cutover.

  ROLLBACK: recreate the CNAME above. Write it down before you start.

EOF
printf '  Type EXACTLY "dns done" once the api record is live: '
read -r answer
[ "$answer" = "dns done" ] || die "not confirmed — DNS presumably unchanged, no harm done"

banner "6/6  Verify over real DNS, then audit objects"
echo "  waiting for DNS to propagate (TTL 60s)…"
for i in $(seq 1 20); do
  got=$(getent hosts "$HOST" 2>/dev/null | awk '{print $1}' | head -1)
  [ "$got" = "$LB_IP" ] && { echo "  $HOST -> $got"; break; }
  sleep 10
done
[ "${got:-}" = "$LB_IP" ] || echo "  WARNING: $HOST still resolves to ${got:-nothing} — testing anyway"

# No --resolve this time: this is the real public path users take.
NO_RESOLVE=1 HOST="$HOST" bash 05-smoke-test.sh \
  || echo "  SMOKE FAILED OVER REAL DNS — consider rolling back the record"

banner "Object hash audit (slow, read-only, safe to run now)"
CHECK_ONLY=1 bash 03-rclone-delta.sh

banner "CUTOVER COMPLETE"
echo "  Total elapsed: $(( $(date +%s) - T0 ))s"

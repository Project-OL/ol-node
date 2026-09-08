#!/usr/bin/env bash
#
# CUTOVER STEP 1 — run on the prodv2 EC2 (SSM), by the operator.
#
# Freezes writes, dumps Postgres, uploads the dump to S3, and prints the
# object key + checksum that step 2 consumes.
#
#   sudo bash 01-dump-prodv2.sh            # dump only, app left running
#   sudo FREEZE=1 bash 01-dump-prodv2.sh   # stop the app first (real cutover)
#
# FREEZE=1 is what makes the dump a consistent cutover point: pg_dump alone is
# transactionally consistent, but anything written after it starts is simply
# lost, so the app has to be stopped first for the dump to be the final state.
#
# The dump lands under db-migration/ deliberately — the S3 -> R2 rclone job
# excludes that prefix, so the dump never copies itself into the object store.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
APP_USER="${APP_USER:-olapp}"
BUCKET="${BUCKET:-ol-app-storage}"
PREFIX="${PREFIX:-db-migration}"
FREEZE="${FREEZE:-0}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="/tmp/prod-${STAMP}.dump"
KEY="${PREFIX}/prod-${STAMP}.dump"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$APP_DIR/.env" ] || die "no .env at $APP_DIR"

# DATABASE_DIRECT_URL bypasses the RDS proxy. The proxy multiplexes connections
# and is not a safe channel for a long single-transaction dump.
DB_URL="$(grep -E '^DATABASE_DIRECT_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
[ -n "$DB_URL" ] || DB_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
[ -n "$DB_URL" ] || die "neither DATABASE_DIRECT_URL nor DATABASE_URL found in .env"

command -v pg_dump >/dev/null || die "pg_dump not installed — 'sudo dnf install -y postgresql16' (or apt postgresql-client-16)"
PG_MAJOR="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
[ "$PG_MAJOR" -ge 16 ] || die "pg_dump is $PG_MAJOR.x; server is 16.x — a older client cannot dump a newer server"
log "pg_dump $(pg_dump --version | awk '{print $3}')"

if [ "$FREEZE" = "1" ]; then
  log "FREEZING writes — stopping app processes"
  sudo -u "$APP_USER" pm2 stop ol-api ol-worker ol-face-worker >/dev/null 2>&1 || true
  sudo -u "$APP_USER" pm2 list || true
  log "app stopped; downtime clock starts now"
else
  log "NOT freezing (FREEZE=0) — this dump is a rehearsal, not a cutover point"
fi

log "dumping to $DUMP"
# -Fc custom format: required for parallel restore (-j) on the far side.
# -Z1 light compression: at ~231 MB the CPU cost of higher levels buys little.
time pg_dump -Fc -Z1 --no-owner --no-privileges -f "$DUMP" "$DB_URL"

SIZE="$(du -h "$DUMP" | cut -f1)"
SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
log "dump complete: $SIZE  sha256=$SHA"

log "uploading to s3://$BUCKET/$KEY"
if command -v aws >/dev/null; then
  aws s3 cp "$DUMP" "s3://$BUCKET/$KEY" --only-show-errors
else
  # No AWS CLI on this host, but the app's node_modules always has the S3
  # client, and the EC2 instance role already carries write access.
  log "aws cli absent — uploading via the app's AWS SDK"
  cat > /tmp/_upload.js <<'JS'
const fs = require('fs')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const [, , bucket, key, file, region] = process.argv
const s3 = new S3Client({ region })
s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: fs.readFileSync(file) }))
  .then(() => console.log('uploaded'))
  .catch((e) => { console.error(e.name, e.message); process.exit(1) })
JS
  REGION="$(grep -E '^AWS_REGION=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  (cd "$APP_DIR" && node /tmp/_upload.js "$BUCKET" "$KEY" "$DUMP" "${REGION:-ap-south-1}")
  rm -f /tmp/_upload.js
fi

rm -f "$DUMP"

cat <<EOF

=============================================================
 STEP 1 COMPLETE — hand these three lines to the GCP operator
=============================================================
 DUMP_KEY=$KEY
 DUMP_SHA=$SHA
 DUMP_SIZE=$SIZE
=============================================================
EOF

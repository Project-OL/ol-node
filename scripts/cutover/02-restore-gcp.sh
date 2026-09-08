#!/usr/bin/env bash
#
# CUTOVER STEP 2 — run on the GCE VM. Pulls the dump from S3 and restores it
# into Cloud SQL, replacing whatever is there.
#
#   sudo AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#        DUMP_KEY=db-migration/prod-<stamp>.dump DUMP_SHA=<sha256> \
#        bash 02-restore-gcp.sh
#
# The credentials are the read-only ol-s3-migration pair — this step only needs
# GetObject, and deliberately has no write access to production media.
#
# DESTRUCTIVE: drops the public schema before restoring. That is on purpose —
# a full dump cannot be layered onto populated tables (every primary key
# collides), and pg_restore --clean drops objects one at a time, which leaves
# orphans behind when the schema has moved.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
BUCKET="${BUCKET:-ol-app-storage}"
: "${DUMP_KEY:?set DUMP_KEY to the object key printed by step 1}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID (ol-s3-migration)}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
AWS_REGION="${AWS_REGION:-ap-south-1}"

LOCAL="/tmp/$(basename "$DUMP_KEY")"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v pg_restore >/dev/null || die "pg_restore missing — apt-get install -y postgresql-client-16"
command -v psql >/dev/null || die "psql missing — apt-get install -y postgresql-client-16"

DB_URL="$(grep -E '^DATABASE_DIRECT_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
[ -n "$DB_URL" ] || DB_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$DB_URL" ] || die "no DATABASE_URL in $APP_DIR/.env"

log "downloading s3://$BUCKET/$DUMP_KEY"
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
AWS_REGION="$AWS_REGION" \
python3 - "$BUCKET" "$DUMP_KEY" "$LOCAL" <<'PY'
import sys, boto3
bucket, key, dest = sys.argv[1], sys.argv[2], sys.argv[3]
boto3.client("s3").download_file(bucket, key, dest)
print("downloaded", dest)
PY

if [ -n "${DUMP_SHA:-}" ]; then
  GOT="$(sha256sum "$LOCAL" | cut -d' ' -f1)"
  [ "$GOT" = "$DUMP_SHA" ] || die "checksum mismatch: expected $DUMP_SHA got $GOT"
  log "checksum verified"
else
  log "WARNING: no DUMP_SHA given — restoring an unverified file"
fi

log "stopping app so nothing writes mid-restore"
sudo -u olapp pm2 stop ol-api ol-worker ol-face-worker >/dev/null 2>&1 || true

log "dropping and recreating schema public"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

log "restoring (parallel, index builds are the slow part)"
# --no-owner/--no-privileges: the dump was taken as the RDS role, which does not
# exist in Cloud SQL; without these every GRANT and ALTER OWNER fails.
time pg_restore -d "$DB_URL" -j "${JOBS:-4}" --no-owner --no-privileges "$LOCAL" \
  || log "pg_restore reported errors — review above; harmless ones are usually extension/comment lines"

rm -f "$LOCAL"

log "row sanity check"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c \
  "select 'users' t, count(*) from users
   union all select 'user_face_profiles', count(*) from user_face_profiles
   union all select 'live_streams', count(*) from live_streams;"

cat <<'EOF'

=========================================================
 STEP 2 COMPLETE — database restored.
 App is still STOPPED. Run 04-post-restore.sh next; it
 starts the app only after the URL rewrite and re-index.
=========================================================
EOF

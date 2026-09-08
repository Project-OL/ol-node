#!/usr/bin/env bash
#
# CUTOVER STEP 3 — S3 -> R2 object delta. Run on the GCE VM.
# Independent of the database, so run it IN PARALLEL with steps 1 and 2.
#
#   sudo AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... bash 03-rclone-delta.sh
#   sudo ... MAX_AGE=24h bash 03-rclone-delta.sh     # faster, see below
#   sudo ... CHECK_ONLY=1 bash 03-rclone-delta.sh    # verify without copying
#
# Run it twice: once BEFORE the freeze (catches ~all drift at zero downtime)
# and once after, when it has only a handful of objects left to move.
#
# MAX_AGE is the main speed lever. rclone skips objects already at the
# destination, so a delta transfers almost nothing — but it still LISTS all
# ~42k source objects, and that listing is what costs the minutes. After a bulk
# pass, only recently-modified objects can be new, so --max-age skips the
# comparison work for everything older. Leave it unset for a full verification.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID (ol-s3-migration, read-only)}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
SRC_BUCKET="${SRC_BUCKET:-ol-app-storage}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
CONF="/root/.config/rclone/rclone.conf"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v rclone >/dev/null || die "rclone missing — apt-get install -y rclone"

# R2 credentials come from the app's own .env, so there is one source of truth
# for where objects live and no second copy of the R2 secret to rotate.
get() { grep -E "^$1=" "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"'; }
R2_ENDPOINT="$(get S3_ENDPOINT_URL)"
R2_BUCKET="$(get S3_BUCKET)"
R2_KEY="$(get S3_ACCESS_KEY_ID)"
R2_SECRET="$(get S3_SECRET_ACCESS_KEY)"
[ -n "$R2_ENDPOINT" ] && [ -n "$R2_BUCKET" ] || die "S3_ENDPOINT_URL / S3_BUCKET missing from .env"

cleanup() { shred -u "$CONF" 2>/dev/null || rm -f "$CONF"; rmdir /root/.config/rclone 2>/dev/null || true; }
# The AWS key must not outlive the run — the runbook is explicit that a GCP box
# should never be left holding one.
trap cleanup EXIT

mkdir -p /root/.config/rclone
umask 077
cat > "$CONF" <<EOF
[s3]
type = s3
provider = AWS
access_key_id = $AWS_ACCESS_KEY_ID
secret_access_key = $AWS_SECRET_ACCESS_KEY
region = $AWS_REGION

[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_KEY
secret_access_key = $R2_SECRET
endpoint = $R2_ENDPOINT
region = auto
EOF

EXCLUDE=(--exclude "db-migration/**")
AGE=()
[ -n "${MAX_AGE:-}" ] && AGE=(--max-age "$MAX_AGE")

log "before:"
rclone size "s3:$SRC_BUCKET" "${EXCLUDE[@]}" 2>/dev/null | sed 's/^/  S3 /'
rclone size "r2:$R2_BUCKET" 2>/dev/null | sed 's/^/  R2 /'

if [ "${CHECK_ONLY:-0}" != "1" ]; then
  log "copying delta${MAX_AGE:+ (--max-age $MAX_AGE)}"
  # rclone 1.60.1 logs one `501 NotImplemented` PER OBJECT: both remotes are
  # type=s3 so it attempts a server-side copy, R2 refuses, and it falls back to
  # streaming — successfully. --disable copy does not suppress it. Never judge
  # this run by its error count; judge it by `rclone check` below.
  rclone copy "s3:$SRC_BUCKET" "r2:$R2_BUCKET" "${EXCLUDE[@]}" "${AGE[@]}" \
    --transfers "${TRANSFERS:-16}" --checkers "${CHECKERS:-32}" \
    --stats 30s --stats-one-line 2>/tmp/rclone-delta.err || true
  log "501-noise lines (expected, ignore): $(grep -c 501 /tmp/rclone-delta.err || true)"
  log "non-501 errors:"
  grep -viE '501|NotImplemented|status code|Attempt [0-9]+/[0-9]+' /tmp/rclone-delta.err | grep -iE 'error|failed' | head -10 || echo "  none"
fi

log "verifying by hash (authoritative)"
rclone check --one-way "s3:$SRC_BUCKET" "r2:$R2_BUCKET" "${EXCLUDE[@]}" 2>&1 \
  | grep -viE '501|NotImplemented|status code' | tail -6

log "after:"
rclone size "s3:$SRC_BUCKET" "${EXCLUDE[@]}" 2>/dev/null | sed 's/^/  S3 /'
rclone size "r2:$R2_BUCKET" 2>/dev/null | sed 's/^/  R2 /'

rm -f /tmp/rclone-delta.err
log "STEP 3 COMPLETE (rclone config shredded)"

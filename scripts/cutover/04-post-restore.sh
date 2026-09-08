#!/usr/bin/env bash
#
# CUTOVER STEP 4 — run on the GCE VM after steps 2 and 3 have BOTH finished.
# Migrations, URL rewrite, face re-index, smoke checks, then start the app.
#
#   sudo bash 04-post-restore.sh --dry-run   # rehearse, changes nothing
#   sudo bash 04-post-restore.sh
#
# Ordering is not arbitrary:
#   migrate  — the dump carries prodv2's migration state; GCP code may be ahead
#   urls     — 54,856 stored absolute URLs still point at the old S3 origin
#   faces    — needs the restored rows AND the objects from step 3 to be present
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
APP_USER="${APP_USER:-olapp}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

log() { printf '\n[%s] === %s ===\n' "$(date -u +%H:%M:%S)" "$*"; }
run_as_app() { sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && . ./.env && set +a && $*"; }

cd "$APP_DIR"

log "1/5 prisma migrate deploy"
if [ -n "$DRY" ]; then
  run_as_app "npx prisma migrate status" || true
else
  run_as_app "npx prisma migrate deploy"
fi

log "2/5 rewrite stored media URLs (S3 origin -> R2)"
# Most media columns store a bare key and the API builds the URL at read time,
# so they need nothing. These 10 columns stored the absolute URL as written and
# would 403 for every user until swapped.
run_as_app "node dist/scripts/rewrite-media-urls.js $DRY"

log "3/5 re-index / reconcile the Rekognition collection"
# The restore reintroduced prodv2's FaceIds, which do not resolve in the GCP
# collection. Search still works (it matches on ExternalImageId), so this fails
# silently — until a revoke calls DeleteFaces with a stale id and removes
# nothing. This indexes newcomers AND rewrites the stale ids.
run_as_app "node dist/scripts/reindex-face-collection.js $DRY"

log "4/5 smoke checks"
run_as_app "node -e \"
const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();
(async()=>{
  const bad=await p.\\\$queryRawUnsafe(\\\"select count(*)::int n from users where avatar_url like 'https://ol-app-storage%'\\\");
  const idx=await p.userFaceProfile.count({where:{status:'INDEXED'}});
  const u=await p.user.count();
  console.log('users:',u,'| indexed faces:',idx,'| stale s3 avatar urls:',bad[0].n);
  await p.\\\$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
\""

if [ -n "$DRY" ]; then
  echo; echo "DRY RUN — app not started, nothing written."; exit 0
fi

log "5/5 starting the app"
run_as_app "pm2 restart ol-api ol-worker ol-face-worker --update-env"
sleep 5
sudo -u "$APP_USER" pm2 list
echo
echo -n "health: "; curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health

cat <<'EOF'

=========================================================
 STEP 4 COMPLETE.
 Before flipping DNS, check by hand:
   - an avatar image loads in the app
   - one face verification passes
   - a game launches (BAISHUN get_sstoken -> get_user_info)
=========================================================
EOF

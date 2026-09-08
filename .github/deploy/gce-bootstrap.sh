#!/usr/bin/env bash
# GCE startup script: turn a blank Ubuntu 24.04 image into a working ol-node-rest +
# live-server node, with no manual steps.
#
# Why this exists
# ---------------
# The production VM used to be a pet: the build, $APP_DIR/.env and the Firebase/Google
# credential JSONs were all placed by hand and existed only on that one disk, while the
# instance template was a bare Ubuntu image. That meant the managed instance group could
# not do the two things a MIG exists for:
#
#   * scale out  - a new instance came up blank, failed the health check and served
#                  nothing, so the service silently could not scale past one node
#   * self-heal  - losing the instance lost the whole environment, with no rebuild path
#
# Everything this script needs now lives in GCP: release tarballs in GCS, secrets in
# Secret Manager, both readable by the instance service account.
#
# Contract
# --------
#   metadata run-workers      = "true"   -> also run ol-worker + ol-face-worker here
#                               anything else (default) -> API + live only
#   metadata start-processes  = "false"  -> provision everything but start nothing
#                               anything else (default) -> start processes
#
# Workers are opt-in because every repeatable BullMQ cron (rich-tier rollover, ledger
# audit, expiry sweeps) would otherwise fire once per instance the autoscaler adds.
#
# start-processes=false exists for validating this script against production secrets
# without joining production. live-server in particular runs several background timers
# (the stream heartbeat monitor, the lucky-gift reserve pool engine, a videoCall sweep)
# that act on shared Redis/DB state, so a second live node would not be a passive
# observer - it could end real live streams.
#
# Deliberately does NOT run `prisma migrate deploy`. Migrations belong to the deploy
# pipeline and must run exactly once, not on every instance the autoscaler creates.
#
# Idempotent: safe to re-run on an existing instance.

set -euo pipefail
exec > >(tee -a /var/log/ol-bootstrap.log) 2>&1
echo "=== ol bootstrap starting $(date -u +%FT%TZ) ==="

BUCKET="gs://ol-node-rest-releases"
APP_USER="olapp"
APP_ROOT="/opt/ol/apps"
LOG_DIR="/opt/ol/logs"
NODE_MAJOR="20"

meta() {
  curl -s -f -H "Metadata-Flavor: Google" \
    "http://169.254.169.254/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}

RUN_WORKERS="$(meta run-workers)"
START_PROCESSES="$(meta start-processes)"
echo "run-workers metadata     : '${RUN_WORKERS:-<unset>}'"
echo "start-processes metadata : '${START_PROCESSES:-<unset, defaults to start>}'"

# ---------------------------------------------------------------- 1. base packages
if ! command -v node >/dev/null 2>&1; then
  echo "--- installing Node ${NODE_MAJOR} (NodeSource) ---"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg tar
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod a+r /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "node $(node --version) / npm $(npm --version)"

command -v pm2 >/dev/null 2>&1 || npm install -g pm2 --silent

# ---------------------------------------------------------------- 2. user + layout
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_ROOT/ol-node-rest" "$APP_ROOT/live-server" "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" /opt/ol

# ---------------------------------------------------------------- 3. release artifacts
fetch_release() {
  local app="$1" dest="$APP_ROOT/$1" tmp
  tmp="$(mktemp -d)"
  echo "--- fetching $app release ---"
  gcloud storage cp "$BUCKET/$app/latest.tgz" "$tmp/app.tgz" --quiet
  tar -xzf "$tmp/app.tgz" -C "$dest"
  rm -rf "$tmp"
  chown -R "$APP_USER:$APP_USER" "$dest"
}
fetch_release ol-node-rest
fetch_release live-server

# ---------------------------------------------------------------- 4. secrets
# Written 0600 and owned by the app user; never logged.
fetch_secret() {
  local secret="$1" dest="$2"
  echo "--- fetching secret $secret ---"
  gcloud secrets versions access latest --secret="$secret" --out-file="$dest" --quiet
  chmod 600 "$dest"
  chown "$APP_USER:$APP_USER" "$dest"
}
fetch_secret ol-node-rest-env                  "$APP_ROOT/ol-node-rest/.env"
fetch_secret ol-node-rest-firebase-adminsdk    "$APP_ROOT/ol-node-rest/offoolive-firebase-adminsdk.json"
fetch_secret ol-live-server-env                "$APP_ROOT/live-server/.env"
fetch_secret ol-live-server-google-credentials "$APP_ROOT/live-server/google-credentials.json"

# ---------------------------------------------------------------- 5. dependencies
install_deps() {
  local dir="$1"
  echo "--- npm ci in $dir ---"
  sudo -u "$APP_USER" bash -lc "cd '$dir' && npm ci --omit=dev --silent"
  if [ -d "$dir/prisma" ]; then
    sudo -u "$APP_USER" bash -lc "cd '$dir' && npx prisma generate >/dev/null"
  fi
}
install_deps "$APP_ROOT/ol-node-rest"
install_deps "$APP_ROOT/live-server"

# ---------------------------------------------------------------- 6. processes
# `pm2 start` is idempotent via delete-then-start: it also guarantees a fresh read of
# .env, which a bare `pm2 restart` does NOT do (pm2 replays the environment saved in its
# dump, and dotenv will not override an existing process.env value).
start_app() {
  local name="$1" dir="$2" script="$3"
  sudo -u "$APP_USER" bash -lc "
    cd '$dir'
    pm2 delete '$name' >/dev/null 2>&1 || true
    pm2 start '$script' --name '$name'
  "
}
if [ "$START_PROCESSES" = "false" ]; then
  echo "=== start-processes=false: provisioned but NOT starting anything ==="
  echo "=== ol bootstrap finished (provision-only) $(date -u +%FT%TZ) ==="
  exit 0
fi

start_app ol-api  "$APP_ROOT/ol-node-rest" dist/server.js
start_app ol-live "$APP_ROOT/live-server"  server.js

if [ "$RUN_WORKERS" = "true" ]; then
  echo "--- run-workers=true: starting workers on this node ---"
  start_app ol-worker      "$APP_ROOT/ol-node-rest" dist/worker.js
  start_app ol-face-worker "$APP_ROOT/ol-node-rest" dist/worker-face-index.js
else
  echo "--- run-workers not set: API + live only (cron must not double-fire) ---"
  sudo -u "$APP_USER" bash -lc "pm2 delete ol-worker ol-face-worker >/dev/null 2>&1 || true"
fi

# ---------------------------------------------------------------- 7. survive reboots
# The hand-built VM had no pm2 systemd unit, so a reboot left it serving nothing.
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
sudo -u "$APP_USER" bash -lc "pm2 save" >/dev/null

echo "=== ol bootstrap finished $(date -u +%FT%TZ) ==="
sudo -u "$APP_USER" pm2 list || true

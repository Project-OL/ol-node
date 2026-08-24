#!/usr/bin/env bash
# Unpack a GitHub Actions artifact on EC2. Never run `npm run build` here.
# Never modify nginx, security groups, or other AWS resources.
#
# Layout (Amazon Linux 2023, system Node — no nvm):
#   APP_DIR=/opt/ol/apps/ol-node-rest
#   LOG_DIR=/opt/ol/logs
#   APP_USER=olapp
#
# Env flags (production 2-EC2):
#   RUN_MIGRATE=1|0     default 1 — set 0 on replica EC2 (#2)
#   RESTART_WORKERS=1|0 default 1 — set 0 on replica EC2 (#2)
#
# Migrations: uses DATABASE_DIRECT_URL when set (RDS Proxy bypass), else DATABASE_URL.
# Secrets stay in APP_DIR/.env (not in the artifact).
set -euo pipefail

APP_USER="${APP_USER:-olapp}"
APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
LOG_DIR="${LOG_DIR:-/opt/ol/logs}"
ARTIFACT="${ARTIFACT:-/tmp/ol-node-artifact.tgz}"
RUN_MIGRATE="${RUN_MIGRATE:-1}"
RESTART_WORKERS="${RESTART_WORKERS:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"

if [ ! -f "$ARTIFACT" ]; then
  echo "missing artifact: $ARTIFACT" >&2
  exit 1
fi

if [ "$(id -un)" != "$APP_USER" ] && [ "$(id -u)" -ne 0 ]; then
  echo "must run as ${APP_USER} or root (root drops privileges for npm/pm2)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "system node/npm not found in PATH (expected Node 20 / npm 10, no nvm)" >&2
  exit 1
fi

echo "node $(node -v) npm $(npm -v) user=$(id -un)"

mkdir -p "$APP_DIR" "$LOG_DIR"

if [ "$(id -u)" -eq 0 ]; then
  if ! id "$APP_USER" >/dev/null 2>&1; then
    echo "missing Linux user ${APP_USER}" >&2
    exit 1
  fi
  chown "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
  chmod a+r "$ARTIFACT"
  if [ -f "$APP_DIR/.env" ]; then
    chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  fi
fi

as_olapp() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
}

echo "extracting $ARTIFACT -> $APP_DIR"
as_olapp tar -xzf "$ARTIFACT" -C "$APP_DIR"

as_olapp env \
  APP_DIR="$APP_DIR" \
  RUN_MIGRATE="$RUN_MIGRATE" \
  RESTART_WORKERS="$RESTART_WORKERS" \
  NODE_OPTIONS="$NODE_OPTIONS" \
  PATH="$PATH" \
  bash -c '
set -euo pipefail
cd "$APP_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

echo "npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund

echo "prisma generate"
npx prisma generate

if [ "$RUN_MIGRATE" = "1" ]; then
  MIGRATE_URL="${DATABASE_DIRECT_URL:-${DATABASE_URL:-}}"
  if [ -z "$MIGRATE_URL" ]; then
    echo "RUN_MIGRATE=1 but neither DATABASE_DIRECT_URL nor DATABASE_URL is set" >&2
    exit 1
  fi
  if [ -n "${DATABASE_DIRECT_URL:-}" ]; then
    echo "prisma migrate deploy (via DATABASE_DIRECT_URL — direct RDS, not proxy)"
  else
    echo "prisma migrate deploy (via DATABASE_URL — DATABASE_DIRECT_URL not set)"
  fi
  DATABASE_URL="$MIGRATE_URL" npx prisma migrate deploy
else
  echo "skipping prisma migrate deploy (RUN_MIGRATE=0)"
fi

pm2_ensure() {
  local name="$1"
  local script="$2"
  if pm2 describe "$name" >/dev/null 2>&1; then
    echo "pm2 restart $name"
    pm2 restart "$name"
  else
    echo "pm2 start $script --name $name"
    pm2 start "$script" --name "$name"
  fi
}

pm2_ensure ol-api dist/server.js
if [ "$RESTART_WORKERS" = "1" ]; then
  pm2_ensure ol-worker dist/worker.js
  pm2_ensure ol-face-worker dist/worker-face-index.js
fi

pm2 save
pm2 list
echo "ol-node deploy complete"
'

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
#   RESTART_API=1|0     default 1 — set 0 on a GCE role=core node (no ol-api there)
#
# Migrations: uses DATABASE_DIRECT_URL when set (RDS Proxy bypass), else DATABASE_URL.
# Secrets stay in APP_DIR/.env (not in the artifact).
set -euo pipefail

APP_USER="${APP_USER:-olapp}"
APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
# Production: /opt/ol/logs. Staging APP_DIR is under /home/ec2-user (ec2-user cannot mkdir /opt/ol).
if [ -z "${LOG_DIR:-}" ]; then
  case "$APP_DIR" in
    /opt/ol/*) LOG_DIR=/opt/ol/logs ;;
    *) LOG_DIR="$APP_DIR/logs" ;;
  esac
fi
ARTIFACT="${ARTIFACT:-/tmp/ol-node-artifact.tgz}"
RUN_MIGRATE="${RUN_MIGRATE:-1}"
RESTART_WORKERS="${RESTART_WORKERS:-1}"
RESTART_API="${RESTART_API:-1}"
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
  RESTART_API="$RESTART_API" \
  NODE_OPTIONS="$NODE_OPTIONS" \
  PATH="$PATH" \
  bash -c '
set -euo pipefail
cd "$APP_DIR"

if [ -f .env ]; then
  set -a
  # INF-20: strip CRs so a CRLF .env (e.g. written from a Windows-uploaded secret) cannot
  # abort the deploy with "command not found" on a bare CR. The file itself is left as it is.
  # This block is inside a single-quoted bash -c string: use double quotes only.
  # shellcheck disable=SC1090
  . <(tr -d "\r" < ./.env)
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

# BE-19: ol-api may run in pm2 cluster mode (OL_API_INSTANCES in .env, default 1 = fork mode,
# unchanged). The API is stateless across processes: WS fan-out goes through Redis pub/sub and
# presence counts live in Redis. --merge-logs keeps the single ol-api-out/err.log files.
# Changing the instance count needs one delete+start; after that, deploys `pm2 reload`
# (rolling, zero downtime) in cluster mode.
OL_API_INSTANCES="${OL_API_INSTANCES:-1}"
# (No single quotes in this block: it runs inside a single-quoted bash -c.)
# `pm2 id ol-api` prints the process ids, e.g. "[ 6, 7 ]" (jlist repeats each name, so no grep there).
api_count=$(pm2 id ol-api 2>/dev/null | grep -o "[0-9][0-9]*" | wc -l | tr -d " ")
api_exec=$(pm2 describe ol-api 2>/dev/null | grep -o "cluster_mode\|fork_mode" | head -1)
if [ "$api_count" = "0" ] || [ -z "$api_exec" ]; then api_mode="none"; else api_mode="$api_exec:$api_count"; fi
if [ "$RESTART_API" != "1" ]; then
  echo "skipping ol-api (RESTART_API=0)"
else
  if [ "$OL_API_INSTANCES" -gt 1 ] 2>/dev/null; then
    if [ "$api_mode" = "cluster_mode:$OL_API_INSTANCES" ]; then
      echo "pm2 reload ol-api ($api_mode)"
      pm2 reload ol-api
    else
      echo "ol-api $api_mode -> cluster x$OL_API_INSTANCES (delete + start)"
      pm2 delete ol-api >/dev/null 2>&1 || true
      pm2 start dist/server.js --name ol-api -i "$OL_API_INSTANCES" --merge-logs
    fi
  else
    if [ "${api_mode%%:*}" = "cluster_mode" ]; then
      echo "ol-api $api_mode -> fork (delete + start)"
      pm2 delete ol-api >/dev/null 2>&1 || true
      pm2 start dist/server.js --name ol-api
    else
      pm2_ensure ol-api dist/server.js
    fi
  fi
fi
if [ "$RESTART_WORKERS" = "1" ]; then
  pm2_ensure ol-worker dist/worker.js
  pm2_ensure ol-face-worker dist/worker-face-index.js
fi

pm2 save
pm2 list
echo "ol-node deploy complete"
'

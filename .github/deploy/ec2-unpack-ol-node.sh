#!/usr/bin/env bash
# Unpack a GitHub Actions artifact on ol-dev. Never run `npm run build` here.
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

APP_DIR="${APP_DIR:-$HOME/ol-node}"
ARTIFACT="${ARTIFACT:-/tmp/ol-node-artifact.tgz}"

if [ ! -f "$ARTIFACT" ]; then
  echo "missing artifact: $ARTIFACT" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
echo "extracting $ARTIFACT -> $APP_DIR"
tar -xzf "$ARTIFACT" -C "$APP_DIR"

cd "$APP_DIR"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"

echo "npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund

echo "prisma generate"
npx prisma generate

echo "prisma migrate deploy"
npx prisma migrate deploy

echo "pm2 restart ol-api ol-worker ol-face-worker"
pm2 restart ol-api ol-worker ol-face-worker
pm2 save

pm2 list
echo "ol-node deploy complete"

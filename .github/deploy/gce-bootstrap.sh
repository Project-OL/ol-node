#!/usr/bin/env bash
# GCE startup script: turn a blank Ubuntu 24.04 image into a working ol-node-rest +
# live-server + ol-admin (nginx, static) node, with no manual steps.
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
#   metadata role             = "all" (default) -> ol-api + ol-live + admin, workers per
#                                                  run-workers (the single-VM layout)
#                               "api"  -> ol-api only. The only role safe to run on more
#                                         than one node; no live-server, admin or workers
#                               "core" -> ol-live + admin + ol-worker + ol-face-worker,
#                                         no ol-api. Must stay at exactly ONE node until
#                                         Live-server may scale (INF-16)
#   metadata run-workers      = "true"   -> also run ol-worker + ol-face-worker here
#                               anything else (default) -> API + live only
#                               (role=all only; api never runs workers, core always does)
#   metadata start-processes  = "false"  -> provision everything but start nothing
#                               anything else (default) -> start processes
#   metadata release-bucket   = "gs://..." -> where */latest.tgz live
#                               (default gs://ol-node-rest-releases; bucket names are
#                               global, so a new project needs its own)
#   metadata admin-hostnames  = "a.example b.example" -> nginx server_name for the admin
#                               portal (default admins3jinyu + priviledge .offoolive.com)
#
# The admin portal (ol-admin) is a static Vite build served by nginx on :8080, the
# port behind the MIG's `admin` named port. It is set up even when
# start-processes=false: it is plain static files with no Redis/DB state, so serving
# it cannot disturb production. A missing admin release only warns - the API and
# live-server must not be held hostage by the admin bundle.
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

APP_USER="olapp"
APP_ROOT="/opt/ol/apps"
LOG_DIR="/opt/ol/logs"
# INF-19: the AWS SDK v3 needs Node >= 22 for releases after early January 2027; staging has
# run 22 since 2026-09-29. A box on an older major is upgraded in place below.
NODE_MAJOR="22"
ADMIN_DOCROOT="/var/www/admins3jinyu.offoolive.com"
ADMIN_PORT="8080"

meta() {
  curl -s -f -H "Metadata-Flavor: Google" \
    "http://169.254.169.254/computeMetadata/v1/instance/attributes/$1" 2>/dev/null || true
}

ROLE="$(meta role)"
ROLE="${ROLE:-all}"
RUN_WORKERS="$(meta run-workers)"
START_PROCESSES="$(meta start-processes)"
case "$ROLE" in
  all)  WANT_API=1; WANT_LIVE=1; WANT_ADMIN=1
        if [ "$RUN_WORKERS" = "true" ]; then WANT_WORKERS=1; else WANT_WORKERS=0; fi ;;
  api)  WANT_API=1; WANT_LIVE=0; WANT_ADMIN=0; WANT_WORKERS=0 ;;
  core) WANT_API=0; WANT_LIVE=1; WANT_ADMIN=1; WANT_WORKERS=1 ;;
  *)    echo "FATAL: unknown role metadata '$ROLE' (expected all|api|core)"; exit 1 ;;
esac
BUCKET="$(meta release-bucket)"
BUCKET="${BUCKET:-gs://ol-node-rest-releases}"
ADMIN_HOSTNAMES="$(meta admin-hostnames)"
ADMIN_HOSTNAMES="${ADMIN_HOSTNAMES:-admins3jinyu.offoolive.com priviledge.offoolive.com}"
echo "role metadata            : '$ROLE' (api=$WANT_API live=$WANT_LIVE admin=$WANT_ADMIN workers=$WANT_WORKERS)"
echo "run-workers metadata     : '${RUN_WORKERS:-<unset>}'"
echo "start-processes metadata : '${START_PROCESSES:-<unset, defaults to start>}'"
echo "release bucket           : '$BUCKET'"
echo "admin hostnames          : '$ADMIN_HOSTNAMES'"

# ---------------------------------------------------------------- 1. base packages
# `command -v` first: on a fresh image there is no node, and under `set -euo pipefail` a failing
# `node --version` in this pipeline aborted the whole bootstrap (exit 127; caught by the v4 canary).
CURRENT_NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi
if [ "$CURRENT_NODE_MAJOR" != "$NODE_MAJOR" ]; then
  # Installs Node when missing, or moves an existing box to NODE_MAJOR. The npm ci in
  # install_deps below then rebuilds native modules (bcrypt, sharp, prisma) for it.
  echo "--- installing Node ${NODE_MAJOR} (NodeSource; found '${CURRENT_NODE_MAJOR:-none}') ---"
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

# pm2 never rotates its own logs, and both apps write one JSON line per request (ol-api pino,
# Live-server since LIVE-44). copytruncate: pm2 keeps writing to the same file handle, no reload.
cat > /etc/logrotate.d/pm2-olapp <<'ROTATE'
/home/olapp/.pm2/logs/*.log {
    su olapp olapp
    daily
    maxsize 200M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
ROTATE

# OBS-01: Ops Agent for VM memory/disk metrics (alert policies "VM memory > 85%", "VM disk > 85%")
# and the pm2 *-error.log files (log pm2_errors: log metrics live_process_failures, ledger_unavailable),
# plus error-level lines only, parsed for Error Reporting (logs ol_api_errors, ol_live_errors; OBS-02),
# and /var/log/auth.log (log system_auth; alert on SSH logins not via IAP, OBS-08).
# Syslog is deliberately not shipped. Needs roles/logging.logWriter + roles/monitoring.metricWriter
# on the instance service account. A failed install only warns: the apps don't depend on it.
if ! systemctl list-unit-files 2>/dev/null | grep -q google-cloud-ops-agent; then
  echo "--- installing Google Cloud Ops Agent ---"
  ( cd /tmp && curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh \
      && bash add-google-cloud-ops-agent-repo.sh --also-install >/tmp/ops-agent-install.log 2>&1 \
      && rm -f add-google-cloud-ops-agent-repo.sh ) || echo "WARNING: Ops Agent install failed (see /tmp/ops-agent-install.log)"
fi
if [ -d /etc/google-cloud-ops-agent ]; then
  cat > /etc/google-cloud-ops-agent/config.yaml <<'YAML'
logging:
  receivers:
    pm2_errors:
      type: files
      include_paths:
        - /home/olapp/.pm2/logs/*-error.log
    ol_api_errors:
      type: files
      include_paths:
        - /home/olapp/.pm2/logs/ol-api-out.log
    ol_live_errors:
      type: files
      include_paths:
        - /home/olapp/.pm2/logs/ol-live-error.log
    system_auth:
      type: files
      include_paths:
        - /var/log/auth.log
  processors:
    api_keep_errors:
      type: exclude_logs
      match_any:
        - 'NOT jsonPayload.message =~ "\"level\":(50|60)[,}]"'
    live_keep_errors:
      type: exclude_logs
      match_any:
        - 'NOT jsonPayload.message =~ "\"level\":\"(error|fatal)\""'
    parse:
      type: parse_json
      field: message
    api_error_event:
      type: modify_fields
      fields:
        severity:
          static_value: ERROR
        jsonPayload."@type":
          static_value: type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent
        jsonPayload.serviceContext.service:
          static_value: ol-api
        jsonPayload.message:
          copy_from: jsonPayload.msg
        jsonPayload.stack_trace:
          copy_from: jsonPayload.err.stack
    live_error_event:
      type: modify_fields
      fields:
        severity:
          static_value: ERROR
        jsonPayload."@type":
          static_value: type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent
        jsonPayload.serviceContext.service:
          static_value: live-server
        jsonPayload.message:
          copy_from: jsonPayload.msg
  service:
    pipelines:
      default_pipeline:
        receivers: []
      pm2:
        receivers: [pm2_errors]
      api_errors:
        receivers: [ol_api_errors]
        processors: [api_keep_errors, parse, api_error_event]
      live_errors:
        receivers: [ol_live_errors]
        processors: [live_keep_errors, parse, live_error_event]
      auth:
        receivers: [system_auth]
YAML
  # OBS-07: scrape LiveKit's Prometheus endpoint (livekit_* only) from the node that runs ol-live,
  # once metadata livekit-metrics-target=<host:port> is set (the VPS firewall admits only our NAT IP).
  # Only one node may scrape it, or every LiveKit series would be written once per API node.
  LK_TARGET="$(meta livekit-metrics-target)"
  LK_RECEIVER=""; LK_PIPE=""
  if [ "$WANT_LIVE" = 1 ] && [ -n "$LK_TARGET" ]; then
    LK_RECEIVER="    livekit:
      type: prometheus
      config:
        scrape_configs:
          - job_name: livekit
            scrape_interval: 60s
            static_configs:
              - targets: ['${LK_TARGET}']
            metric_relabel_configs:
              - source_labels: [__name__]
                regex: 'livekit_.*'
                action: keep"
    LK_PIPE="
      livekit:
        receivers: [livekit]"
  fi
  # OBS-06: OTLP on loopback for the API's traces (OTEL_TRACING=on), forwarded to Cloud Trace
  # (needs roles/cloudtrace.agent on the instance service account).
  cat >> /etc/google-cloud-ops-agent/config.yaml <<YAML
combined:
  receivers:
    otlp:
      type: otlp
      grpc_endpoint: 127.0.0.1:4317
metrics:
  receivers:
    hostmetrics:
      type: hostmetrics
      collection_interval: 60s
${LK_RECEIVER}
  service:
    pipelines:
      default_pipeline:
        receivers: [hostmetrics]${LK_PIPE}
traces:
  service:
    pipelines:
      otlp:
        receivers: [otlp]
YAML
  systemctl restart google-cloud-ops-agent || echo "WARNING: Ops Agent restart failed"
fi

if [ "$WANT_ADMIN" = 1 ] && ! command -v nginx >/dev/null 2>&1; then
  echo "--- installing nginx ---"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx
fi
if [ "$WANT_ADMIN" = 1 ]; then echo "$(nginx -v 2>&1)"; fi

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
# ol-node-rest is needed by every role (core runs its workers).
fetch_release ol-node-rest
if [ "$WANT_LIVE" = 1 ]; then fetch_release live-server; fi

# ---------------------------------------------------------------- 3b. admin portal
if [ "$WANT_ADMIN" = 1 ]; then
# Same layout as the hand-built VM (2026-09-20): one server block on :8080 for both
# portal hostnames, one shared docroot. The SUPER_ADMIN-vs-everyone split is enforced
# by the API from the Origin header, not by nginx, so both names serve the same build.
# try_files falls back to index.html for Vue Router's history mode.
echo "--- configuring nginx for the admin portal ---"
mkdir -p "$ADMIN_DOCROOT"
cat > /etc/nginx/sites-available/admin-portal.conf <<NGINX
server {
  listen ${ADMIN_PORT} default_server;
  listen [::]:${ADMIN_PORT} default_server;
  server_name ${ADMIN_HOSTNAMES};
  root ${ADMIN_DOCROOT};
  index index.html;
  location / {
    try_files \$uri \$uri/ /index.html;
  }
}
NGINX
ln -sfn /etc/nginx/sites-available/admin-portal.conf /etc/nginx/sites-enabled/admin-portal.conf
# The distro default site listens on :80; nothing routes there and it is not on the old VM.
rm -f /etc/nginx/sites-enabled/default

# Extract into a stage dir and only swap it in when it contains index.html, so a bad
# or missing tarball never blanks a docroot that was serving.
fetch_admin() {
  local tmp
  tmp="$(mktemp -d)"
  echo "--- fetching ol-admin release ---"
  if ! gcloud storage cp "$BUCKET/ol-admin/latest.tgz" "$tmp/admin.tgz" --quiet; then
    echo "WARNING: $BUCKET/ol-admin/latest.tgz not found - admin portal has no files; its LB backend will stay UNHEALTHY"
    rm -rf "$tmp"
    return 0
  fi
  mkdir -p "$tmp/stage"
  tar -xzf "$tmp/admin.tgz" -C "$tmp/stage"
  if [ ! -f "$tmp/stage/index.html" ]; then
    echo "WARNING: ol-admin release has no index.html - leaving $ADMIN_DOCROOT untouched"
    rm -rf "$tmp"
    return 0
  fi
  find "$ADMIN_DOCROOT" -mindepth 1 -delete
  cp -a "$tmp/stage"/. "$ADMIN_DOCROOT"/
  rm -rf "$tmp"
}
fetch_admin
chown -R "$APP_USER:$APP_USER" "$ADMIN_DOCROOT"

nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx
fi

# ---------------------------------------------------------------- 4. secrets
# Written 0600 and owned by the app user; never logged.
fetch_secret() {
  local secret="$1" dest="$2"
  echo "--- fetching secret $secret ---"
  gcloud secrets versions access latest --secret="$secret" --out-file="$dest" --quiet
  # INF-20: a secret uploaded from Windows can carry CRLF (ol-node-rest-env v3 did, 2026-10-13);
  # bash `. ./.env` in the deploy script then fails on `$'\r'`. Normalise .env files to LF.
  case "$dest" in *.env) sed -i 's/\r$//' "$dest" ;; esac
  chmod 600 "$dest"
  chown "$APP_USER:$APP_USER" "$dest"
}
fetch_secret ol-node-rest-env                  "$APP_ROOT/ol-node-rest/.env"
fetch_secret ol-node-rest-firebase-adminsdk    "$APP_ROOT/ol-node-rest/offoolive-firebase-adminsdk.json"
if [ "$WANT_LIVE" = 1 ]; then
  fetch_secret ol-live-server-env                "$APP_ROOT/live-server/.env"
  fetch_secret ol-live-server-google-credentials "$APP_ROOT/live-server/google-credentials.json"
fi

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
if [ "$WANT_LIVE" = 1 ]; then install_deps "$APP_ROOT/live-server"; fi

# ---------------------------------------------------------------- 6. processes
# `pm2 start` is idempotent via delete-then-start: it also guarantees a fresh read of
# .env, which a bare `pm2 restart` does NOT do (pm2 replays the environment saved in its
# dump, and dotenv will not override an existing process.env value).
start_app() {
  local name="$1" dir="$2" script="$3" extra="${4:-}"
  sudo -u "$APP_USER" bash -lc "
    cd '$dir'
    pm2 delete '$name' >/dev/null 2>&1 || true
    pm2 start '$script' --name '$name' $extra
  "
}
# BE-19: ol-api instance count from its .env (default 1 = fork mode); see ec2-unpack-ol-node.sh.
OL_API_INSTANCES=$(grep -E '^OL_API_INSTANCES=' "$APP_ROOT/ol-node-rest/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"\r' || true)
API_EXTRA=""
if [ -n "$OL_API_INSTANCES" ] && [ "$OL_API_INSTANCES" -gt 1 ] 2>/dev/null; then
  API_EXTRA="-i $OL_API_INSTANCES --merge-logs"
fi
if [ "$START_PROCESSES" = "false" ]; then
  echo "=== start-processes=false: provisioned but NOT starting any pm2 app (nginx/admin is up) ==="
  echo "=== ol bootstrap finished (provision-only) $(date -u +%FT%TZ) ==="
  exit 0
fi

# Each role also deletes the apps it must not run, so re-running the script after a
# role change leaves no stray process (a second ol-live would end real streams).
stop_app() {
  sudo -u "$APP_USER" bash -lc "pm2 delete $* >/dev/null 2>&1 || true"
}
if [ "$WANT_API" = 1 ]; then
  start_app ol-api "$APP_ROOT/ol-node-rest" dist/server.js "$API_EXTRA"
else
  stop_app ol-api
fi
if [ "$WANT_LIVE" = 1 ]; then
  start_app ol-live "$APP_ROOT/live-server" server.js
else
  stop_app ol-live
fi

if [ "$WANT_WORKERS" = 1 ]; then
  echo "--- role=$ROLE: starting workers on this node ---"
  start_app ol-worker      "$APP_ROOT/ol-node-rest" dist/worker.js
  start_app ol-face-worker "$APP_ROOT/ol-node-rest" dist/worker-face-index.js
else
  echo "--- role=$ROLE: no workers here (cron must not double-fire) ---"
  stop_app ol-worker ol-face-worker
fi

# ---------------------------------------------------------------- 7. survive reboots
# The hand-built VM had no pm2 systemd unit, so a reboot left it serving nothing.
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
sudo -u "$APP_USER" bash -lc "pm2 save" >/dev/null

echo "=== ol bootstrap finished $(date -u +%FT%TZ) ==="
sudo -u "$APP_USER" pm2 list || true

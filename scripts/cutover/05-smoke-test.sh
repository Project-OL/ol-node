#!/usr/bin/env bash
#
# CUTOVER STEP 5 — does the platform actually work?
#
# Step 4's checks are row counts. This exercises the journeys a user takes, so
# "the site loads" is not mistaken for "the platform works".
#
# The important property: it runs against the GCP stack BEFORE DNS moves, by
# pinning the hostname to the load balancer IP with curl --resolve. Real traffic
# stays on AWS the whole time, so a failure here costs nothing.
#
#   bash 05-smoke-test.sh                                  # infra + data only
#   SMOKE_IDENTIFIER=… SMOKE_PASSWORD=… bash 05-smoke-test.sh   # + real user journeys
#   HOST=api.offoolive.com LB_IP=136.68.81.230 bash 05-smoke-test.sh
#   RUN_ON_VM=1 bash 05-smoke-test.sh                      # skip --resolve, hit localhost:3000
#
# Nothing here writes: no tickets are opened, no gifts sent, no balances moved.
# A smoke test that mutates production is a smoke test people stop running.
set -uo pipefail

HOST="${HOST:-api.offoolive.com}"
LB_IP="${LB_IP:-136.68.81.230}"
APP_DIR="${APP_DIR:-/opt/ol/apps/ol-node-rest}"
APP_USER="${APP_USER:-olapp}"

if [ "${RUN_ON_VM:-0}" = "1" ]; then
  BASE="http://localhost:3000"
  RESOLVE=()
else
  BASE="https://$HOST"
  # Pin DNS for this process only — the point is to test the new stack while
  # the world still resolves the hostname to the old one.
  RESOLVE=(--resolve "$HOST:443:$LB_IP" --resolve "$HOST:80:$LB_IP")
fi

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

req() { curl -s -m 20 "${RESOLVE[@]}" "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 20 "${RESOLVE[@]}" "$@"; }

expect_code() { # url expected label
  local got; got=$(code "$1")
  [ "$got" = "$2" ] && ok "$3 ($got)" || bad "$3 — expected $2, got $got"
}

# ---------------------------------------------------------------- 1. transport
head_ "1. Transport"

if [ "${RUN_ON_VM:-0}" != "1" ]; then
  TLS=$(curl -s -o /dev/null -w '%{ssl_verify_result}' -m 20 "${RESOLVE[@]}" "$BASE/health")
  [ "$TLS" = "0" ] && ok "TLS certificate verifies" || bad "TLS verify result = $TLS"

  CN=$(echo | timeout 20 openssl s_client -connect "$LB_IP:443" -servername "$HOST" 2>/dev/null \
        | openssl x509 -noout -checkhost "$HOST" 2>/dev/null)
  [ -n "$CN" ] && ok "certificate matches $HOST" || bad "certificate does not match $HOST"

  RED=$(code -o /dev/null "http://$HOST/health")
  [ "$RED" = "301" ] || [ "$RED" = "308" ] && ok "HTTP redirects to HTTPS ($RED)" || bad "HTTP did not redirect (got $RED)"
fi

expect_code "$BASE/health" 200 "health endpoint"

# /health/ready is the one that proves dependencies (db, redis) are reachable,
# which /health alone does not.
READY=$(code "$BASE/health/ready")
[ "$READY" = "200" ] && ok "readiness (db + redis) ($READY)" || bad "readiness — got $READY"

# ------------------------------------------------------------------- 2. auth
head_ "2. Auth boundary"

# A protected route answering 401 proves routing AND the auth middleware are
# both alive. A 200 here would be far worse than a 500.
expect_code "$BASE/api/v1/users/me" 401 "protected route rejects anonymous"
expect_code "$BASE/api/v1/support/tickets" 401 "support requires auth"
expect_code "$BASE/api/v1/wallet/coins/balance" 401 "wallet requires auth"
expect_code "$BASE/api/v1/nope-does-not-exist" 404 "unknown route 404s"

# --------------------------------------------------------- 3. user journeys
head_ "3. User journeys"

if [ -z "${SMOKE_IDENTIFIER:-}" ] || [ -z "${SMOKE_PASSWORD:-}" ]; then
  skip "login — set SMOKE_IDENTIFIER and SMOKE_PASSWORD to run these"
  skip "profile / wallet / tickets / ws-ticket (need a token)"
else
  LOGIN=$(req -X POST "$BASE/api/v1/auth/login/password" \
    -H 'Content-Type: application/json' \
    -d "{\"provider\":\"${SMOKE_PROVIDER:-email}\",\"identifier\":\"$SMOKE_IDENTIFIER\",\"password\":\"$SMOKE_PASSWORD\",\"deviceName\":\"cutover-smoke\",\"deviceId\":\"cutover-smoke-device\"}")
  TOKEN=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$TOKEN" ]; then
    bad "login — no accessToken (response: $(echo "$LOGIN" | head -c 160))"
  else
    ok "login returns an access token"
    AUTH=(-H "Authorization: Bearer $TOKEN")

    # /users/me returns `userId`, not `id` — assert on the field the endpoint
    # actually emits rather than the one it looked like it should.
    ME=$(req "${AUTH[@]}" "$BASE/api/v1/users/me")
    echo "$ME" | grep -qE '"(userId|publicId)"' && ok "profile loads" \
      || bad "profile — $(echo "$ME" | head -c 120)"

    # The avatar is the canary for the whole S3 -> R2 migration: URL rewritten
    # in the database AND the object actually present in the new bucket.
    AV=$(echo "$ME" | grep -o '"avatarUrl":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$AV" ] && [ "$AV" != "null" ]; then
      case "$AV" in
        *amazonaws.com*) bad "avatar URL still points at S3 — URL rewrite did not run: $AV" ;;
        *) AVC=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$AV")
           [ "$AVC" = "200" ] && ok "avatar image loads from object store ($AVC)" \
             || bad "avatar URL unreachable ($AVC): $AV" ;;
      esac
    else
      skip "avatar — this user has none"
    fi

    for pair in "wallet/coins/balance wallet balance" "support/tickets support tickets" "games game catalog"; do
      set -- $pair; P="$1"; shift; L="$*"
      C=$(code "${AUTH[@]}" "$BASE/api/v1/$P")
      [ "$C" = "200" ] && ok "$L ($C)" || bad "$L — got $C"
    done

    # A ws-ticket is what the app exchanges for a realtime connection; without
    # it every socket feature is dead even though HTTP looks healthy.
    # Send an explicit empty JSON body. `curl -X POST` with no data sets no
    # Content-Length, and Google's load balancer answers 411 before the request
    # ever reaches the app — an artefact of the probe, not a broken endpoint.
    WT=$(req -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{}' \
      "$BASE/api/v1/auth/ws-ticket")
    echo "$WT" | grep -qE '"token"' && ok "websocket ticket issued" \
      || bad "ws-ticket — $(echo "$WT" | head -c 120)"
  fi
fi

# ------------------------------------------------- 4. data after the restore
head_ "4. Data integrity (runs on the VM)"

if [ ! -f "$APP_DIR/.env" ]; then
  skip "data checks — not on the app host"
else
  OUT=$(sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && . ./.env && set +a && node -e '
const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();
(async()=>{
  const q=(s)=>p.\$queryRawUnsafe(s);
  const users=await p.user.count();
  const views=await p.adminView.count();
  const idx=await p.userFaceProfile.count({where:{status:\"INDEXED\"}});
  const stale=(await q(\"select count(*)::int n from users where avatar_url like %s\".replace(\"%s\",\"'\''https://ol-app-storage%'\''\")))[0].n;
  console.log(JSON.stringify({users,views,idx,stale}));
  await p.\$disconnect();
})().catch(e=>{console.log(JSON.stringify({error:e.message}))});
'" 2>/dev/null | tail -1)

  get() { echo "$OUT" | grep -o "\"$1\":[0-9]*" | cut -d: -f2; }
  U=$(get users); V=$(get views); I=$(get idx); S=$(get stale)

  [ -n "$U" ] && [ "$U" -gt 0 ] && ok "users restored ($U)" || bad "user count is $U — restore incomplete?"
  [ -n "$V" ] && [ "$V" -gt 0 ] && ok "admin views seeded ($V)" || bad "admin_views is $V — reconciler did not run"
  [ -n "$I" ] && [ "$I" -gt 0 ] && ok "face profiles indexed ($I)" || bad "indexed faces is $I"
  [ "${S:-1}" = "0" ] && ok "no stale S3 avatar URLs" || bad "$S avatar URLs still point at S3"
fi

# --------------------------------------------------------- 5. integrations
head_ "5. External integrations"

if [ -f "$APP_DIR/.env" ]; then
  GAME=$(sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && . ./.env && set +a && \
    NONCE=\$(openssl rand -hex 8); TS=\$(date +%s); \
    SIG=\$(printf '%s%s%s' \"\$NONCE\" \"\$GAME_PROVIDER_BAISHUN_APP_KEY\" \"\$TS\" | md5sum | cut -d' ' -f1); \
    curl -s -m 20 -X POST \"\$GAME_PROVIDER_BAISHUN_BASE_URL/v1/api/gamelist\" -H 'Content-Type: application/json' \
      -d \"{\\\"game_list_type\\\":2,\\\"app_channel\\\":\\\"\$GAME_PROVIDER_BAISHUN_APP_CHANNEL\\\",\\\"app_id\\\":\$GAME_PROVIDER_BAISHUN_APP_ID,\\\"signature\\\":\\\"\$SIG\\\",\\\"signature_nonce\\\":\\\"\$NONCE\\\",\\\"timestamp\\\":\$TS}\"" 2>/dev/null)
  echo "$GAME" | grep -q '"code":0' && ok "BAISHUN game catalog reachable" \
    || bad "BAISHUN — $(echo "$GAME" | head -c 120)"
else
  skip "BAISHUN catalog — not on the app host"
fi

# ------------------------------------------------------------------ verdict
head_ "Result"
printf '  passed %d   failed %d   skipped %d\n\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  echo "  DO NOT MOVE DNS — $FAIL check(s) failed."
  exit 1
fi
if [ "$SKIP" -gt 0 ]; then
  echo "  All run checks passed, but $SKIP were skipped."
  echo "  Provide SMOKE_IDENTIFIER / SMOKE_PASSWORD and run on the VM for full coverage."
fi
echo "  Safe to proceed."

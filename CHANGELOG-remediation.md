# Remediation changelog

Tracks execution of [`docs/REMEDIATION_PLAN.md`](docs/REMEDIATION_PLAN.md) — the
7.6/10 → 9/10 roadmap. One entry per phase: what changed, what was measured
before/after, how to roll it back.

---

## Phase 0 — Baseline & Guardrails (2026-08-14)

**Scope:** no product-logic changes. Establish the before-numbers and rollback
conventions every later phase measures against.

### Test suite baseline

```
npm run typecheck   → clean
npx vitest run       → 141/141 test files passed, 820/820 tests passed, 26 skipped
npm run test:http    → 15/15 files passed, 49/49 tests passed
```

### Latency baseline

**No live load test was run for this baseline.** The repo's `.env` currently points
`DATABASE_URL` / `REDIS_URL` at real AWS RDS / ElastiCache **dev** endpoints, not an
isolated local stack — running `npm run lab:perf` or a k6 scenario (`lab:soak`,
`lab:wallet`, etc.) as part of this baseline would have meant load-testing shared
infrastructure without a clear ownership/impact check. Decision (confirmed with the
user): use the existing measured reports instead, explicitly caveated as **stale
relative to current code** — they predate essentially all of this session's
concurrency fixes and the "hot-path pass 1–3" optimizations documented in
`docs/context/CURRENT_CONTEXT.md` (2026-08-07 through 2026-08-13).

Source: [`lab/LATENCY_ANALYSIS.md`](lab/LATENCY_ANALYSIS.md), clean local run dated
**2026-07-06**, 100 RPS × 5m soak, Docker Postgres + Docker Redis, `1× local API`:

| Endpoint | n | p50 | p95 | p99 | max |
|----------|---|-----|-----|-----|-----|
| `GET /health` | 7,520 | 0 ms | 1 ms | 1 ms | 2 ms |
| `GET /api/v1/gifts` | 7,524 | 2 ms | 4 ms | 7 ms | 47 ms |
| `GET /api/v1/wallet/coins/balance` | 7,579 | 6 ms | 12 ms | 23 ms | 136 ms |
| `GET /api/v1/users/me` | 7,377 | 19 ms | 32 ms | 62 ms | 256 ms |

k6 client end-to-end global mix: p50 **5.4 ms**, p95 **23.6 ms**, p99 **37.6 ms**.

**Gaps in this baseline, noted for whoever runs Phase 5:**
- Only 4 GET endpoints have real measured numbers. `docs/ENDPOINT_PERFORMANCE.md`'s
  broader 238-route inventory marks every POST/mutation route (including
  message-send) as `estimated` / `skipped (mutation)` — the probe tool
  (`lab/scripts/probe-endpoints.ts`) deliberately skips mutations. **There is no
  prior measured baseline for the message-send path at all.** Phase 5b will need to
  establish its own fresh before-number at the time it runs (against infra that's
  confirmed safe to load-test), not rely on this document.
- Brotli compression cost (Phase 5a) has no existing measurement either — needs a
  fresh benchmark at Phase 5a time.
- These numbers are single-node, local-dev-scale (not cluster/pooled). Useful as a
  regression signal ("did this get slower"), not as a capacity number.

### Rollback mechanism per phase type

- **Schema migration (Phase 2):** confirmed the repo has **no existing down-migration
  convention** — `prisma/migrations/` contains only forward migrations, and no
  rollback runbook exists in `docs/`. Phase 2 will need to write its own reverse SQL
  migration from scratch (drop the new index) rather than follow an established
  pattern; this should be called out explicitly in that phase's PR rather than
  assumed to be a solved problem.
- **Feature-flagged wallet/messaging changes (Phase 3c, Phase 5b):** the codebase
  already has a working convention for this — boolean env-var toggles guarding
  behavior without a deploy rollback, e.g. `RICH_TIER_ROLLOVER_ENABLED`,
  `AGENCY_LEVEL_RECOMPUTE_ENABLED` (see `src/config/env.ts`). Phases that need a
  kill switch should reuse this pattern rather than inventing a new one.
- **Everything else (Phase 1, Phase 3a/3b, Phase 4):** standard git revert of the
  PR is the rollback; no data-shape changes are involved, so no special mechanism
  is needed beyond normal review/revert discipline.

**Acceptance:** ✅ test-suite baseline recorded, ✅ latency baseline recorded from
existing reports with explicit staleness caveat, ✅ rollback mechanism confirmed
(and one real gap — no down-migration convention — surfaced, not glossed over),
✅ this file created.

---

## Phase 1 — Zero-risk infra hardening (2026-08-14)

**Scope:** process-lifecycle/robustness only. No schema changes, no financial logic
touched, no behavior change to any request/response shape.

### 1a. Worker & WS-gateway entrypoints: crash handlers

**Scope widened by one file, with the user's explicit confirmation before coding:**
included `src/ws-server.ts` alongside the 4 BullMQ worker entrypoints, since it has
the identical gap (named in the original audit in the same breath as the workers)
even though it isn't technically a BullMQ worker.

- `src/worker.ts`, `src/worker-realtime.ts`, `src/worker-general.ts`,
  `src/worker-face-index.ts`: `shutdown` now takes an `exitCode` parameter (was
  hardcoded to `process.exit(0)` even on a crash path). Added
  `process.on('uncaughtException'/'unhandledRejection', ...)` via a new shared
  helper, `src/utils/crashHandlers.ts` (`registerCrashHandlers`) — logs with
  `rootLogger` (structured/aggregation-friendly) and calls `shutdown(1)`.
- `src/ws-server.ts`: added the same two handlers inline, mirroring
  `src/server.ts`'s existing (already-correct) pattern exactly — uses `app.log`
  (its own Fastify logger) rather than the shared helper, since its `shutdown`
  signature (`(signal, { exitCode })`) doesn't match the simpler
  `(exitCode) => void` shape the 4 worker files share. Two different call shapes
  in the same file class is intentional, not inconsistency — forcing both through
  one helper would have been worse than two small, correct patterns.
- `src/worker-face-index.ts` bonus fix, a natural consequence of correctly wiring
  this (not a separate scope item): its DB/Redis disconnects were previously
  *outside* the try/catch around the BullMQ worker/queue closes, so a throwing
  disconnect would propagate out of `shutdown()` unhandled (called via `void
  shutdown()`, so the process could be left never calling `process.exit()`).
  Now inside the same guarded block.
- **Before/after:** crash-handler coverage 0/5 → 5/5 process entrypoints.

### 1b. Graceful shutdown: drain read-replica clients

**Scope widened, confirmed precisely per the phase's own instruction before
changing anything:** the phase text named `server.ts`/`ws-server.ts`; investigation
found the identical gap in all 4 worker entrypoints too, since they all import
`prisma` from `./config/database` (which instantiates `prismaRead` as a
module-eval side effect regardless of whether the file uses it), and transitively
load `config/redis.ts` (instantiating `redisReadClient`) via job/service imports.
**7 places fixed, not 2.**

- Added `src/utils/shutdownTimeout.ts` (`withShutdownTimeout`) — wraps the whole
  disconnect sequence in a 10s race-against-timeout so a hung disconnect can't
  block process exit indefinitely.
- All 7 shutdown sequences (`server.ts`, `ws-server.ts`, and the 4 worker files)
  now disconnect `prismaRead` (guarded: `if (prismaRead !== prisma)`) and
  `redisReadClient` (guarded: `?.quit()`) alongside the primaries, inside
  `withShutdownTimeout`.
- **Before/after:** read-replica drain coverage 0/7 → 7/7.

### 1c. `requestTimeout()` rollout

- Added `DEFAULT_REQUEST_TIMEOUT_MS` (20s) and `SLOW_REPORT_TIMEOUT_MS` (60s) to
  `src/utils/requestTimeout.ts`, plus `globalRequestTimeoutHook(isExemptPath)` — a
  global `onRequest` hook (registered in `app.ts` alongside the existing
  `requestIdHook`/`requestLoggerHook`/`requestTimingOnRequest`) that applies the
  default to every request, or a route's own `config: { timeoutMs }` override.
- **Chose one global default + named overrides over exhaustively classifying all
  ~238 endpoints** — per Phase 0's baseline, even the slowest measured route
  (`GET /users/me`) has p99 62ms, so a single generous default safely covers the
  overwhelming majority of routes; a timeout is a worst-case safety net, not a
  tuning knob.
- **Critical exclusions:** `/health` (reused the existing `isHealthPath` helper
  from `middlewares/requestLogger.ts`) and any protocol-upgrade request
  (`request.raw.headers.upgrade`, covers `/ws` generically rather than
  path-matching it — a destroy-after-ms here would kill every WebSocket
  connection at a fixed delay after connect).
- Added `FastifyContextConfig.timeoutMs` module augmentation in
  `src/types/fastify-schema.d.ts` (same file/pattern already used for the
  `FastifySchema.tags`/`description` augmentation) — needed so `config: {
  timeoutMs }` type-checks on route registration; without it TypeScript falls
  back to the `@fastify/websocket` route overload and produces unrelated cascading
  errors.
- Named overrides applied: `GET /admin/support/csas/export` (CSV export),
  `GET /admin/agency/:identifier/hosts/earnings`,
  `GET /admin/agency/:identifier/commission/history` (multi-query aggregation
  reports).
- **One planned override deliberately skipped, found during the "read before
  writing" check:** `POST /admin/ledger-audit/run` — the plan assumed this was a
  synchronous slow admin action, but reading the actual handler showed it's a
  fast fire-and-forget enqueue (`reply.code(202)`, same job as the overnight
  cron) — it needs no override, the 20s default is already generous for it.
  Flagging the corrected assumption here rather than silently applying the wrong
  fix.
- Existing `conversation.routes.ts` `HEAVY_READ_TIMEOUT_MS = 15_000` override left
  unchanged (already below the new 20s default — no behavior change, and not
  consolidated into the new constants per rule 3, no scope creep).
- **Before/after:** requestTimeout coverage 1/~238 routes (only
  `conversation.routes.ts`) → global default on effectively all routes + 3 named
  60s overrides.

### Tests added (12 new, all passing; full suite 144/144 files, 832/832 tests)

- `tests/unit/shutdownTimeout.test.ts` — fn-completes-first, forced-continuation-
  after-timeout, and rejection-propagation cases for `withShutdownTimeout`.
- `tests/unit/crashHandlers.test.ts` — `registerCrashHandlers` logs correctly and
  always calls `shutdown(1)` (never 0) on both `uncaughtException` and
  `unhandledRejection`; cleans up its own `process` listeners per test so nothing
  leaks into other test files sharing the vitest worker process.
- `tests/unit/requestTimeout.test.ts` — `globalRequestTimeoutHook`: exempt-path
  skip, upgrade-request skip, default-timeout destroy, route-override timeout
  honored, no destroy once `reply.sent`, timer cleared on early `close`.

**Rollback:** plain git revert — no data-shape changes, no feature flag needed
(matches Phase 0's "everything else" classification).

**Acceptance:** ✅ 1a/1b/1c shipped, ✅ full suite green (144/144, 832/832),
✅ `test:http` green (15/15, 49/49), ✅ `npm run typecheck` clean, ✅ this entry
records what changed and why, including the two places where investigation
corrected the plan's own assumptions (worker-file scope for 1a/1b, the
ledger-audit/run override that turned out to be unnecessary).

---

## Phase 2 — CreatorSubscription pagination + index migration (2026-08-14)

**Scope:** `GET /subscriptions/my-subscriptions` and `GET /subscriptions/my-subscribers`
only. No financial/wallet logic touched. Migration written, **not applied** (see
below).

### Three assumptions investigation corrected before writing any code

1. **The "missing" index wasn't fully missing.** A 2026-06-01 migration already
   added a partial index on `creator_subscriptions (creator_id) WHERE status =
   'ACTIVE'`, raw-SQL-only and intentionally undeclared in `schema.prisma`
   (Prisma's schema DSL cannot express partial indexes at all — not drift, the
   only way to do it). What was actually still missing: coverage for the new
   paginated query's `ORDER BY updated_at, id` tie-break, on both sides.
2. **`CREATE INDEX CONCURRENTLY` would have failed outright.** Both precedent
   migrations document that Prisma runs migrations inside a transaction, where
   `CONCURRENTLY` cannot execute — they use `IF NOT EXISTS` and note that very
   large tables should get the index built out-of-band. Followed the documented
   house pattern instead of the remediation plan's literal (and here, wrong)
   suggestion.
3. **Pagination shape — corrected mid-investigation, confirmed with the user
   twice.** Both endpoints already respond with `{ items: [...] }` (wrapped at
   the route layer), not a bare array as first assumed from the service method's
   return type alone. That made adding `nextCursor` genuinely additive under the
   project's own additive-only contract rule, so — per the user's explicit
   choice after the correction — modified the existing endpoints directly
   instead of adding parallel v2 endpoints.

### What changed

- **New migration** `prisma/migrations/20260814120000_creator_subscription_pagination_indexes/`
  — two composite partial indexes: `creator_subscriptions_creator_id_updated_at_id_idx`
  and `creator_subscriptions_subscriber_id_updated_at_id_idx`, both
  `(…, updated_at DESC, id DESC) WHERE status = 'ACTIVE'`. **Not applied or
  tested against a live database this session** — `.env` points at a shared AWS
  RDS dev instance and no isolated, confirmed-safe Postgres was made available
  (same caution as Phase 0). Verification `EXPLAIN ANALYZE` query is in the
  migration file's handoff comment; applying and confirming the query plan is
  the user's step, outside this session. Rollback: `DROP INDEX IF EXISTS` for
  both, documented in the migration file (no down-migration convention exists
  in this repo — see Phase 0).
- **New `src/utils/subscriptionCursor.ts`** — `encodeSubscriptionCursor`/
  `decodeSubscriptionCursor` for `{ updatedAt, id }`, structurally identical to
  the existing `src/utils/cursor.ts` but kept as a separate file rather than
  generalizing the existing one, which stays scoped to the unrelated, currently-
  working post-feed cursor (`postRepository.getSubscriptionFeed`).
- **`src/repositories/subscription.repository.ts`** — `listActiveCreatorsForSubscriber`/
  `listActiveSubscribersForCreator` gained `limit`/`cursor` params, mirroring
  `postRepository.getSubscriptionFeed`'s exact composite-`OR`/`take: limit+1`
  pattern.
- **`src/services/subscription.service.ts`** — `listMySubscriptions`/
  `listMySubscribers` gained `(userId, limit = 100, rawCursor?)`, now return
  `{ items, nextCursor }` (previously bare arrays at the service layer, though
  the route layer already wrapped them in `{ items }` — see correction #3).
  Default 100 / max 200 — deliberately more generous than `/feed`'s 20/50 since
  this is a settings-style list, not an infinite-scroll feed; chosen so the
  overwhelming majority of real users never notice a change while the actual
  audit-flagged risk (a creator with 50k+ subscribers driving an unbounded
  query) is now bounded. Same "generous default, worst-case safety net"
  reasoning as Phase 1c's request timeout.
- **`src/routes/v1/subscription.routes.ts`** — added optional `limit`/`cursor`
  querystring (new `subscriptionListQuerySchema`, bounds 1-200/default 100,
  distinct from `feedQuerySchema`'s tighter bounds) to both routes; response
  gains the additive `nextCursor` field.
- **Docs:** `docs/api-contract/API_CONTRACT_LOCK.json` regenerated — the
  generator's window-based heuristic missed the new query params on both routes
  (handlers grew past its 800-char detection window around the route match);
  hand-corrected both entries' `querySchema` to `"inline-query"` directly,
  which the tool's own documented workflow allows. `docs/flow-md/subscription-flow.md`,
  `docs/context/CURRENT_CONTEXT.md`, and `docs/postman/Subscription-API.postman_collection.json`
  (confirmed as the canonical one per `docs/postman/README.md` — the similarly-
  named `Subscriptions-API.postman_collection.json` is not referenced there and
  was left untouched) all updated.

### Tests added (8 new, all passing; full suite 146/146 files, 840/840 tests)

- `tests/unit/subscriptionCursor.test.ts` — encode/decode round-trip, malformed
  input, missing-fields rejection (all → `400 INVALID_CURSOR`).
- `tests/unit/subscription.repository.test.ts` (new file) — asserts the exact
  Prisma `findMany` args for both methods: no `OR` clause + `take: limit+1` on
  the first page, composite tie-break `OR` clause added when a cursor is passed.
- `tests/unit/subscription.service.test.ts` — fixed 2 pre-existing tests that
  asserted the old bare-array-at-service-layer shape; added one new test
  covering two sequential pages against a 3-row fixture, asserting no row
  appears on both pages and none is skipped (the closest a unit test without a
  real database can get to the phase's "stable ordering under concurrent
  writes" criterion — genuine concurrent-write correctness needs the real
  Postgres verification step above).

**Rollback:** code changes are a plain git revert (no feature flag — nothing
here is financial/wallet-adjacent). Migration rollback is the `DROP INDEX IF
EXISTS` documented in the migration file itself; safe to run any time since it's
additive-only (no column/data changes).

**Acceptance:** ✅ migration written (not applied — user's step), ✅ pagination
shipped on both endpoints, ✅ full suite green (146/146, 840/840), ✅ `test:http`
unchanged (15/15, 49/49), ✅ `npm run typecheck` clean, ✅ mandatory docs updated,
✅ this entry records the three corrected assumptions rather than silently
absorbing them.

---

## Phase 3 — Concurrency correctness (2026-08-14)

**Scope:** the plan's own "highest-care" phase. Reproduction test written before
any fix, for each of 3a/3b/3c, per the phase's own rule.

### 3a. `createSubscription` pre-check race — corrected understanding

**The plan assumed a double-charge risk. Investigation found that's wrong:**
`coin_ledger_entries.idempotency_key` already has a DB-level `@unique`
constraint, and the debit path inserts directly against it with no pre-check —
Postgres itself rejects a concurrent duplicate insert. The **actual** bug: the
pre-check read (`findByPair`) happens outside the transaction, so two concurrent
callers can both read "no existing row," derive the identical ledger
idempotency key, and have the loser's insert throw an **uncaught Prisma P2002**
that surfaces as a raw 500 instead of the clean `409 SUBSCRIPTION_DUPLICATE`
the winner-path already returns. A user-facing correctness bug, not a financial
one — smaller blast radius than the plan's framing implied, surfaced rather than
silently fixed under the wrong description.

**Reproduction test first** (`tests/unit/subscription.service.test.ts`):
simulated two concurrent `createSubscription` calls both reading no existing
row, second's debit rejecting with a real `Prisma.PrismaClientKnownRequestError`
(P2002). Confirmed failing against pre-fix code (raw error escaped uncaught) via
manual verification before implementing the fix.

**Fix:** wrapped the whole flow (pre-check + transaction + post-commit side
effects) in an inner closure, retried once on `isUniqueViolation` — exact same
pattern already proven in `coinTrading.service.ts`'s transfer method. The retry's
pre-check now sees the winner's committed row and returns the correct 409.

### 3b. Cross-currency lock ordering

Both fixed via the shared `lockWalletsInOrder` helper, replacing fixed-role-order
locking:
- `video-call.service.ts` (`tick`): caller COIN + creator POINT wallets, was
  locked caller-then-creator; now locked in one `lockWalletsInOrder` call before
  any balance read.
- `coinTrading.service.ts` (`executeExchangeInternal`): same-user POINT +
  COIN/TRADING_COIN wallets, was locked via call-order (`pointWalletService.debit`
  then `coinWalletService.credit`); now fetched and locked via
  `lockWalletsInOrder` first.

**Tests — both required deliberately-chosen fixture IDs to actually discriminate
old vs. new behavior**, not just assert the outcome unchanged: a naive fixture
where wallet IDs happen to sort in the same order as the old call-order would
pass under *both* the buggy and fixed code, proving nothing.
- `tests/unit/coin-trading-wallet-debit.test.ts` — the existing agent-exchange
  test's IDs coincidentally sort the same as call-order (not discriminating);
  added a new non-agent-exchange test with IDs chosen so `wallet-coin <
  wallet-point` lexically — the opposite of debit-then-credit call order — plus
  fixed the mock's `getOrCreate` to return distinct ids per currency type (it
  previously collapsed POINT and COIN to the same mock id, which would have
  silently defeated `lockWalletsInOrder`'s dedup-by-id logic in tests). Also
  added the missing `RedisKeys.ctPersonalExchangeRates` mock entry, surfaced by
  exercising the non-agent path for the first time in this file.
- `tests/unit/video-call.service.test.ts` (new file — none existed) — fixture
  uses `callerId = "zebra-caller"` / `creatorId = "alpha-creator"` specifically
  so id-sorted order inverts the old caller-then-creator call order.

### 3c. Gift-send `idempotencyKey` — Step 1 only (observability, not enforcement)

**Scoped precisely because Step 2 cannot happen in a coding session at all** —
it's gated on production metrics observed over time plus external client-team
coordination. This session ships Step 1 only: making the gap visible.

- New `src/services/giftSend.metrics.ts`, mirroring the existing
  `auth-observability.ts` pattern (in-process counter, "replace with Prometheus
  when wired").
- `gift-transaction.service.ts`'s legacy branch (key absent) now logs a
  structured warning and bumps the counter before falling through to the
  unchanged random-key behavior. **No charging/idempotency behavior changed.**
  `gift.schemas.ts`'s `idempotencyKey` stays optional — flipping it to required
  is explicitly Step 2, out of scope for any single session.
- **Test coverage gap found and closed:** `gift-transaction.service.test.ts` had
  zero tests exercising the "key present" branch at all (no
  `getCachedIdemResponse`/`acquireIdemKey`/`resolveIdemKey` mocks existed).
  Added 4 tests: missing-key metric+log fires (and doesn't fire when present),
  idempotent retry returns the cached result without re-executing, and
  concurrent double-submit with the same key — the loser gets `409
  IDEM_CONFLICT` before ever reaching the ledger insert (exactly one charge).

### Tests added (7 new; full suite 147/147 files, 847/847 tests)

`subscription.service.test.ts` (+1 reproduction test), `video-call.service.test.ts`
(new file, +1), `coin-trading-wallet-debit.test.ts` (+1 discriminating test),
`gift-transaction.service.test.ts` (+4).

**Rollback:** all three are plain git reverts. No feature flags — 3a/3b are
lock-ordering/retry-safety fixes with no data or API shape change; 3c adds only
logging and an in-process counter.

**Acceptance:** ✅ reproduction test written before each fix (3a/3b/3c), ✅ full
suite green (147/147, 847/847), ✅ `test:http` unchanged (15/15, 49/49),
✅ `npm run typecheck` clean, ✅ this entry records 3a's corrected failure-mode
understanding and the explicit Step 1/Step 2 boundary for 3c rather than
overstating what shipped.

## Phase 4 — Circuit-breaker coverage expansion (2026-08-14)

**Corrected framing, surfaced before implementation:** the plan's "current
coverage: Redis GETs only" undersold the actual gap. There are two parallel
Redis-read cache layers — `cache.service.ts` (breaker-protected on its 3
GET-shaped methods only) and the broader, more heavily-used
`cacheRedis.service.ts` (backs most hot-path caching from earlier phases),
which has **no breaker at all**, only a per-call timeout with a catch-as-miss
fallback. **Named and deferred, not fixed here** — it's more Redis-GET
coverage, a same-shape but separately-scoped change from this phase's actual
target (DB + outbound HTTP). Also deferred for the same reason: OAuth token
verification (Google/Facebook/Apple, in `oauth.service.ts`) — a real outbound
dependency, but one where a breaker has no fallback value (a failed
verification must always surface as `401 INVALID_OAUTH_TOKEN` either way) and
sits directly on the login critical path; not named explicitly in the plan
text.

Reused the existing `CircuitBreaker` class (`src/utils/circuitBreaker.ts`)
unchanged — no second implementation. Added one named, tuned instance per
dependency:

| Instance | threshold | openMs | halfOpenMs |
|---|---|---|---|
| `dbCircuitBreaker` / `dbReadCircuitBreaker` | 15 | 5,000 | 1,000 |
| `s3CircuitBreaker` | 6 | 15,000 | 3,000 |
| `rekognitionCircuitBreaker` | 6 | 15,000 | 3,000 |
| `livekitCircuitBreaker` | 5 | 15,000 | 3,000 |
| `epayCircuitBreaker` | 4 | 20,000 | 5,000 |
| `msg91CircuitBreaker` | 5 | 15,000 | 3,000 |
| `sesCircuitBreaker` | 5 | 15,000 | 3,000 |

DB threshold is deliberately much higher than the others (false-open on the
primary datastore is catastrophic; every other dependency has some form of
fallback or is non-critical). Epay trips on fewer failures with a longer
cooldown — gateway outages tend to run longer and the path is low-frequency
enough that extra caution costs little.

**DB wrapping — architecturally different from the HTTP dependencies:**
`src/config/database.ts`'s existing `$extends({ query: { $allOperations }})`
pattern (already used there for `withLabQueryCounter`) now also fail-fasts via
`withCircuitBreaker`, applied to both `prisma` and `prismaRead` with separate
breaker instances (a replica-only outage can't fail-fast primary-served
requests). **Critical exclusion:** not every thrown Prisma error means "the
database is down" — `isDbInfraError()` (`circuitBreaker.ts`) only counts
connection/availability-shaped codes (`P1001`, `P1002`, `P1008`, `P1009`,
`P1010`, `P1011`, `P1017`, `P2024`, or any non-Prisma error) as breaker
failures. Known business-logic outcomes that fire routinely under healthy
load — `P2002` unique violation, `P2025` not found, `P2034` serialization
conflict (the `withSerializationRetry` pattern from Phase 3), `P2003` FK
violation — are excluded, so ordinary idempotency/conflict traffic can never
trip the DB breaker. When open: fail-fast with `AppError(503,
'Database temporarily unavailable', 'DB_CIRCUIT_OPEN')` instead of letting
requests hang until Prisma's own connection/pool timeout. `withCircuitBreaker`
and `withConnectionLimit` are both exported from `database.ts` purely for
testability (existing precedent, same file). Almost all existing unit tests
mock `../../src/config/database` wholesale, so this is inert for them.

**HTTP dependencies wrapped** (network-call sites only — local-only work like
S3 presigned-URL signing or LiveKit JWT signing was left untouched since
there's no network round-trip to protect):
- `storage.service.ts` — all four `s3Client.send()` sites (`putObjectBuffer`,
  `headObjectMetadata`, `getObjectBuffer`, `deleteObject`). A genuine 404
  (`NotFound`/`NoSuchKey`) is not counted as a breaker failure.
- `rekognition.client.ts` — wrapped once at the shared `withTimeout` helper
  all exported functions funnel through, except `ensureCollectionExists`
  (rare startup-only call with its own idempotent-create handling, doesn't go
  through `withTimeout` — left unwrapped, flagging here rather than silently
  claiming full coverage). `InvalidParameterException` /
  `InvalidImageFormatException` (business rejections) don't count as
  failures, same exclusion principle as DB.
- `video-call.service.ts` — `lk.createRoom` and the best-effort `lk.deleteRoom`
  (the latter still swallows errors as before — non-critical, room
  auto-expires — but now also records the failure so the breaker still learns
  LiveKit is unhealthy).
- `epay.client.ts` — wrapped inside `withRetry`'s outer loop, so the breaker
  sees one failure per exhausted-retry call, not per individual HTTP attempt.
- `msg91.provider.ts` / `ses.provider.ts` — both already return
  `{ success: false, error }` on failure rather than throwing; `shouldSkip()`
  short-circuits to that same shape, so callers see no new error type.

**Tests added (8 new files, 22 new tests):**
`tests/unit/circuitBreaker.test.ts` (10 tests — the `CircuitBreaker` class
itself had no direct test despite backing production behavior since it was
introduced: closed→open at threshold, skip-while-open, the open-cooldown +
half-open-delay sequencing, probe success→closed w/ reset failure count, probe
failure→reopen immediately regardless of threshold; plus `isDbInfraError`
classification). Seven per-dependency wiring tests (one focused test per
dependency, walking the full closed→open→fail-fast→recover sequence against
the real production breaker singleton and a mocked underlying client):
`database.circuitBreaker.test.ts`, `storage.service.circuitBreaker.test.ts`,
`rekognition.client.circuitBreaker.test.ts`,
`video-call.service.circuitBreaker.test.ts`, `epay.client.circuitBreaker.test.ts`,
`msg91.provider.circuitBreaker.test.ts`, `ses.provider.circuitBreaker.test.ts`.

**Rollback:** every addition wraps existing calls with no request/response
shape change, no schema change, no new required config — plain git revert is
safe everywhere. DB is the one dependency worth a specific note: reverting
`database.ts`'s extension removes the fail-fast `DB_CIRCUIT_OPEN` 503s and
restores today's behavior (requests hang until Prisma's own connection/pool
timeout during an outage) — a regression to the pre-Phase-4 baseline, not a
new risk. No feature flag needed; every breaker defaults closed, so bad
threshold tuning only matters once real failures start occurring, not on
deploy.

**Acceptance:** ✅ DB and outbound HTTP calls wrapped (S3, Rekognition,
LiveKit, Epay, MSG91, SES), ✅ per-dependency thresholds documented (table
above) with rationale, ✅ breaker-open/half-open/closed behavior tested per
dependency, ✅ full suite green (155/155 non-skipped files, 868/868 non-skipped
tests — 8 files/22 tests added this phase), ✅ `test:http` unchanged (15/15,
49/49), ✅ `npm run typecheck` clean, ✅ this entry names the two items found
but explicitly deferred (the `cacheRedis.service.ts` Redis-breaker gap, and
OAuth token verification) rather than silently absorbing or omitting them.

/**
 * BE-20 internal-ledger money tests: environment pinned BEFORE any app module loads.
 *
 * Runs the real internal ledger against a THROWAWAY Postgres + Redis: the Live-server money-test
 * containers (Live-server tests/money/docker-compose.yml), database `ledger_test`. Anything that is
 * not that local container is refused, so these tests can never touch dev RDS, staging or prod.
 *
 *   npm run test:ledger:setup   (creates ledger_test + pushes this repo's Prisma schema)
 *   npm run test:ledger
 */
const DB =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://money:money@127.0.0.1:55432/ledger_test'
const REDIS = process.env.LEDGER_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/2'

const host = new URL(DB.replace(/^postgresql:/, 'http:'))
if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.port !== '55432') {
  throw new Error(
    `Refusing to run ledger tests against ${host.hostname}:${host.port}; only the local test container is allowed.`,
  )
}

process.env.DATABASE_URL = `${DB}${DB.includes('?') ? '&' : '?'}connection_limit=40&pool_timeout=30`
delete process.env.DATABASE_READ_URL
process.env.REDIS_URL = REDIS
process.env.NODE_ENV = 'test'
process.env.JWT_ACCESS_SECRET ??= 'test-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-chars'
process.env.ADMIN_JWT_SECRET ??= 'test-admin-jwt-secret-at-least-32-chars'
process.env.ADMIN_JWT_REFRESH_SECRET ??= 'test-admin-refresh-secret-at-least-32-chars'
process.env.LIVE_WEBHOOK_SECRET ??= 'test-live-webhook-secret-at-least-32-chars'
process.env.INTERNAL_LEDGER_HMAC_SECRET = 'test-internal-ledger-secret-at-least-32-chars'
process.env.AVATAR_CONTENT_MODERATION_ENABLED = 'false'

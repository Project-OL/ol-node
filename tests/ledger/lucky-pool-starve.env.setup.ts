/**
 * C2: dedicated setup with connection_limit=4 so nested global prisma use starves the pool.
 */
const DB =
  process.env.LUCKY_WATER_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5433/ol_lucky'

const host = new URL(DB.replace(/^postgresql:/, 'http:'))
if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.port !== '5433') {
  throw new Error(
    `Refusing lucky-pool-starve tests against ${host.hostname}:${host.port}; only 127.0.0.1:5433 is allowed.`,
  )
}

process.env.DATABASE_URL = `${DB}${DB.includes('?') ? '&' : '?'}connection_limit=4&pool_timeout=8&sslmode=disable`
process.env.DATABASE_POOL_MAX = '4'
delete process.env.DATABASE_READ_URL
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/15'
process.env.NODE_ENV = 'test'
process.env.LUCKY_NESTED_PRISMA_GUARD = 'throw'
process.env.JWT_ACCESS_SECRET ??= 'test-secret-at-least-32-characters-long'
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-32-chars'
process.env.ADMIN_JWT_SECRET ??= 'test-admin-jwt-secret-at-least-32-chars'
process.env.ADMIN_JWT_REFRESH_SECRET ??= 'test-admin-refresh-secret-at-least-32-chars'
process.env.LIVE_WEBHOOK_SECRET ??= 'test-live-webhook-secret-at-least-32-chars'
process.env.INTERNAL_LEDGER_HMAC_SECRET = 'test-internal-ledger-secret-at-least-32-chars'
process.env.AVATAR_CONTENT_MODERATION_ENABLED = 'false'

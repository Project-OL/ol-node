/**
 * Serve the internal ledger API against the throwaway `ledger_test` DB, so Live-server's own money
 * tests run end-to-end (since 2026-10-21 Live-server has no local money path, so this is required):
 *
 *   ol-node-rest:  npx tsx tests/ledger/serve-internal.ts            (listens on 127.0.0.1:3199)
 *   Live-server:   MONEY_TEST_DATABASE_URL=postgresql://money:money@127.0.0.1:55432/ledger_test \
 *                  LIVE_LEDGER_BASE_URL=http://127.0.0.1:3199 \
 *                  INTERNAL_LEDGER_HMAC_SECRET=test-internal-ledger-secret-at-least-32-chars \
 *                  npm run test:money
 *
 * Redis defaults to DB 0 of the test container, the same one Live-server's tests use, as in
 * production where both services share one Redis: a setting a test changes (and whose cache it
 * drops, e.g. `host:revenue-shares`) must be seen by both. ol-node-rest's own ledger suite keeps
 * DB 2 (env.setup.ts) because it runs alone.
 */
process.env.LEDGER_TEST_REDIS_URL ??= 'redis://127.0.0.1:56379'

const port = Number(process.env.LEDGER_TEST_PORT ?? 3199)

async function main() {
  await import('./env.setup')
  const { buildInternalApp } = await import('../../src/internal/internal-app')
  const app = await buildInternalApp(process.env.INTERNAL_LEDGER_HMAC_SECRET!)
  await app.listen({ port, host: '127.0.0.1' })
  console.log(`internal ledger test server on 127.0.0.1:${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

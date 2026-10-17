/**
 * Serve the internal ledger API against the throwaway `ledger_test` DB, so Live-server's own money
 * tests can run end-to-end in remote mode:
 *
 *   ol-node-rest:  npx tsx tests/ledger/serve-internal.ts            (listens on 127.0.0.1:3199)
 *   Live-server:   MONEY_TEST_DATABASE_URL=postgresql://money:money@127.0.0.1:55432/ledger_test \
 *                  LIVE_LEDGER_MODE=remote LIVE_LEDGER_BASE_URL=http://127.0.0.1:3199 \
 *                  INTERNAL_LEDGER_HMAC_SECRET=test-internal-ledger-secret-at-least-32-chars \
 *                  npm run test:money
 */
import './env.setup'

const port = Number(process.env.LEDGER_TEST_PORT ?? 3199)

async function main() {
  const { buildInternalApp } = await import('../../src/internal/internal-app')
  const app = await buildInternalApp(process.env.INTERNAL_LEDGER_HMAC_SECRET!)
  await app.listen({ port, host: '127.0.0.1' })
  console.log(`internal ledger test server on 127.0.0.1:${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * Phase 1 acceptance: two API instances behind LB share Redis; REST publish fans out over
 * `RedisKeys.convChannel` to WS subscribers.
 *
 * Opt-in: RUN_WS_FANOUT_INTEGRATION=1 with live Redis + API.
 * Manual smoke: terminal A `npm run dev`, terminal B `wscat -c "ws://localhost:PORT/ws?ticket=..."`.
 *
 * HTTP contract coverage for WS ticket minting: tests/http/ws-ticket.route.test.ts
 * Unit coverage: tests/unit/ws-ticket.service.test.ts, ws-frame-guard.test.ts, ws-publisher.test.ts
 */
import { describe, it } from 'vitest'

const runIntegration = process.env.RUN_WS_FANOUT_INTEGRATION === '1'

describe.runIf(runIntegration)('messaging ws fanout (integration)', () => {
  it('placeholder — implement Redis pub/sub → WS fanout with live stack', () => {
    // TODO: connect two WS clients, publish via messagingService, assert frame delivery
  })
})

describe.skipIf(runIntegration)('messaging ws fanout (integration)', () => {
  it('skipped — set RUN_WS_FANOUT_INTEGRATION=1 to enable', () => {})
})

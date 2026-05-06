/**
 * Phase 1 acceptance: two API instances behind LB share Redis; REST publish fans out over
 * `RedisKeys.convChannel` to WS subscribers. Enable with RUN_WS_FANOUT_INTEGRATION=1 and a live Redis.
 *
 * Manual smoke: terminal A `npm run dev`, terminal B `wscat -c "ws://localhost:PORT/ws?ticket=..."`.
 */
import { describe, it } from 'vitest'

describe.skip('messaging ws fanout (integration)', () => {
  it('placeholder — opt-in RUN_WS_FANOUT_INTEGRATION', () => {})
})

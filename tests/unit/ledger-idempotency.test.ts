import { describe, expect, it } from 'vitest'
import { ledgerHostPointsKey, LEDGER_IDEM_SUFFIX } from '../../src/utils/ledger-idempotency'

describe('ledger-idempotency', () => {
  it('ledgerHostPointsKey suffixes purchase event key for host point credit leg', () => {
    const base = 'guardian-purchase:abc-123'
    expect(ledgerHostPointsKey(base)).toBe(`${base}${LEDGER_IDEM_SUFFIX.HOST_POINTS}`)
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '../..')

function readSrc(relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8')
}

/**
 * Static guardrails: paired ledger flows must not regress to row-scoped POINT keys
 * when the coin debit uses a per-event random key. See wallet-ledger-inventory.md § Idempotency.
 */
describe('ledger paired idempotency guardrails', () => {
  it('subscription initial purchase keys host points from purchase event key', () => {
    const src = readSrc('src/services/subscription.service.ts')
    expect(src).toContain('ledgerHostPointsKey(idempotencyKey)')
    expect(src).not.toContain('sub-host-pts:${created.id}:initial')
  })

  it('guardian purchase keys host points from purchase event key', () => {
    const src = readSrc('src/services/guardian.service.ts')
    expect(src).toContain('ledgerHostPointsKey(idempotencyKey)')
    expect(src).not.toContain('guardian-host-pts:${row.id}')
  })

  it('coin-trading exchange pairs point debit and trading coin credit on same ref id', () => {
    const src = readSrc('src/services/coinTrading.service.ts')
    expect(src).toMatch(/exchange-pts:\$\{exchangeRefId\}/)
    expect(src).toMatch(/exchange-ct:\$\{exchangeRefId\}/)
  })
})

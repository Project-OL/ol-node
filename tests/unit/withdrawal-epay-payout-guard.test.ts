import { describe, it, expect, vi } from 'vitest'
import {
  EPAY_PAYOUT_LIVE_STATUSES,
  lockWithdrawalAndAssertNoLiveEpayPayout,
} from '../../src/services/withdrawal.service'

function fakeTx(liveCount: number) {
  const calls: string[] = []
  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock')
      return []
    }),
    epayPayoutOrder: {
      count: vi.fn(async () => {
        calls.push('count')
        return liveCount
      }),
    },
  }
  return { tx, calls }
}

describe('lockWithdrawalAndAssertNoLiveEpayPayout', () => {
  it('locks the withdrawal row first, then checks live Epay attempts', async () => {
    const { tx, calls } = fakeTx(0)
    await lockWithdrawalAndAssertNoLiveEpayPayout(tx as never, 'w-1')
    expect(calls).toEqual(['lock', 'count'])
    const sql = (tx.$queryRaw.mock.calls[0] as unknown[])[0] as TemplateStringsArray
    expect(sql.join('?')).toMatch(/FROM withdrawals WHERE id = \?::uuid FOR UPDATE/)
    expect(tx.epayPayoutOrder.count).toHaveBeenCalledWith({
      where: { withdrawalId: 'w-1', status: { in: [...EPAY_PAYOUT_LIVE_STATUSES] } },
    })
  })

  it('throws 409 EPAY_PAYOUT_IN_FLIGHT while a payout may still land', async () => {
    const { tx } = fakeTx(1)
    await expect(lockWithdrawalAndAssertNoLiveEpayPayout(tx as never, 'w-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'EPAY_PAYOUT_IN_FLIGHT',
    })
  })

  it('treats SUBMITTING / SUBMITTED / UNKNOWN as live, never SUCCESS or FAILED', () => {
    expect([...EPAY_PAYOUT_LIVE_STATUSES].sort()).toEqual(['SUBMITTED', 'SUBMITTING', 'UNKNOWN'])
  })
})

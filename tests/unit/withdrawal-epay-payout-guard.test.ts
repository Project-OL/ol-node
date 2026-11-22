import { describe, it, expect, vi } from 'vitest'
import {
  EPAY_PAYOUT_LIVE_STATUSES,
  lockWithdrawalAndAssertNoLiveEpayPayout,
} from '../../src/services/withdrawal.service'

function fakeTx(opts: { live: number; success?: number; withdrawalStatus?: string }) {
  const calls: string[] = []
  const tx = {
    $queryRaw: vi.fn(async () => {
      calls.push('lock')
      return []
    }),
    withdrawal: {
      findUnique: vi.fn(async () => ({ status: opts.withdrawalStatus ?? 'PENDING_PLATFORM' })),
    },
    epayPayoutOrder: {
      count: vi.fn(async (args: { where: { status: unknown } }) => {
        calls.push('count')
        return args.where.status === 'SUCCESS' ? (opts.success ?? 0) : opts.live
      }),
    },
  }
  return { tx, calls }
}

describe('lockWithdrawalAndAssertNoLiveEpayPayout', () => {
  it('locks the withdrawal row first, then checks live Epay attempts', async () => {
    const { tx, calls } = fakeTx({ live: 0 })
    await lockWithdrawalAndAssertNoLiveEpayPayout(tx as never, 'w-1')
    expect(calls[0]).toBe('lock')
    expect(calls[1]).toBe('count')
    const sql = (tx.$queryRaw.mock.calls[0] as unknown[])[0] as TemplateStringsArray
    expect(sql.join('?')).toMatch(/FROM withdrawals WHERE id = \?::uuid FOR UPDATE/)
    expect(tx.epayPayoutOrder.count).toHaveBeenCalledWith({
      where: { withdrawalId: 'w-1', status: { in: [...EPAY_PAYOUT_LIVE_STATUSES] } },
    })
  })

  it('throws 409 EPAY_PAYOUT_IN_FLIGHT while a payout may still land', async () => {
    const { tx } = fakeTx({ live: 1 })
    await expect(lockWithdrawalAndAssertNoLiveEpayPayout(tx as never, 'w-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'EPAY_PAYOUT_IN_FLIGHT',
    })
  })

  it('throws 409 EPAY_PAYOUT_ALREADY_SENT when Epay paid but the withdrawal is still PENDING_PLATFORM', async () => {
    const { tx } = fakeTx({ live: 0, success: 1, withdrawalStatus: 'PENDING_PLATFORM' })
    await expect(lockWithdrawalAndAssertNoLiveEpayPayout(tx as never, 'w-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'EPAY_PAYOUT_ALREADY_SENT',
    })
  })

  it('a SUCCESS attempt on a withdrawal that already moved on (WAITING/PAID) does not block', async () => {
    const { tx } = fakeTx({ live: 0, success: 1, withdrawalStatus: 'WAITING' })
    await expect(lockWithdrawalAndAssertNoLiveEpayPayout(tx as never, 'w-1')).resolves.toBeUndefined()
  })

  it('treats SUBMITTING / SUBMITTED / UNKNOWN as live, never SUCCESS or FAILED', () => {
    expect([...EPAY_PAYOUT_LIVE_STATUSES].sort()).toEqual(['SUBMITTED', 'SUBMITTING', 'UNKNOWN'])
  })
})

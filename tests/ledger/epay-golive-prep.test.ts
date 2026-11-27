/**
 * Epay go-live prep on a REAL Postgres (env.setup.ts throwaway DB):
 *  - a trading top-up books the sale (IN) and Epay's fee (OUT) exactly once, even when the
 *    credit runs twice
 *  - a payout's fee is booked once however often the success is recorded
 *  - an Epay refund books the money going back (OUT EPAY_REFUND)
 *  - the "needs attention" list shows pay-ins held for REVIEW
 *  - personal Epay top-up is refused while EPAY_PERSONAL_TOPUP_ENABLED is off
 * Only the Epay HTTP client and outbound queues are stubbed.
 */
import { randomBytes } from 'crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/queues/platform-message.queue', () => ({
  enqueuePlatformWithdrawalMessage: vi.fn().mockResolvedValue(undefined),
  enqueuePlatformLedgerMessage: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return { ...actual, isEpayConfigured: () => true, epayGateway: {} }
})

import { Prisma } from '@prisma/client'
import { prisma } from '../../src/config/database'
import { redisClient } from '../../src/config/redis'
import { coinTradingService } from '../../src/services/coinTrading.service'
import { coinWalletService } from '../../src/services/coin-wallet.service'
import { paymentTransactionsService } from '../../src/services/payment-transactions.service'
import { paymentRefundService } from '../../src/services/payment-refund.service'
import { paymentAttentionService } from '../../src/services/payment-attention.service'
import { makeEpayMerchantOrderNo } from '../../src/lib/epay/epay-order-no'

const rid = () => randomBytes(6).toString('hex')
const D = (v: string) => new Prisma.Decimal(v)

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

async function agent() {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999))
  return prisma.user.create({
    data: {
      username: `a_${rid()}`,
      publicId,
      defaultPublicId: publicId,
      country: 'IN',
      isAgent: true,
    },
  })
}

async function tradingOrder(agentUserId: string) {
  return prisma.coinTradingTopupOrder.create({
    data: {
      agentUserId,
      amountUsd: '100.00',
      tradingCoinsAwarded: 1_000_000n,
      rateApplied: 10_000,
      status: 'PENDING',
      idempotencyKey: `idem-${rid()}`,
      merchantOrderNo: makeEpayMerchantOrderNo('TRADING_TOPUP'),
    },
  })
}

const cash = (ref: string) =>
  prisma.companyCashEntry.findMany({ where: { ledgerRefId: ref }, orderBy: { createdAt: 'asc' } })

describe('Epay go-live prep (real Postgres)', () => {
  it('trading top-up books the sale and the fee exactly once', async () => {
    const a = await agent()
    const o = await tradingOrder(a.id)
    const paid = {
      epayOrderNo: `EP-${rid()}`,
      epayStatus: '7',
      paidAmount: D('100'),
      paidCurrency: 'USD',
      fee: D('1.50'),
    }
    const r = await Promise.all([
      coinTradingService.creditPaidTopup(o.id, paid),
      coinTradingService.creditPaidTopup(o.id, paid),
    ])
    expect(r.filter(Boolean)).toHaveLength(1)

    const rows = await cash(o.merchantOrderNo!)
    expect(rows.map((x) => `${x.direction}:${x.reason}:${x.amountUsd.toFixed(2)}`).sort()).toEqual(
      ['IN:AGENCY_TRADING_PURCHASE:100.00', 'OUT:EPAY_FEE:1.50'].sort(),
    )
    const purchase = await prisma.paymentTransaction.findFirst({
      where: { externalId: o.merchantOrderNo!, kind: 'PURCHASE' },
    })
    expect((purchase?.metadata as { fee?: string } | null)?.fee).toBe('1.5')
  })

  it('a top-up without a fee books only the sale', async () => {
    const a = await agent()
    const o = await tradingOrder(a.id)
    await coinTradingService.creditPaidTopup(o.id, {
      epayOrderNo: null,
      epayStatus: '7',
      paidAmount: D('100'),
      paidCurrency: 'USD',
      fee: null,
    })
    const rows = await cash(o.merchantOrderNo!)
    expect(rows.map((x) => x.reason)).toEqual(['AGENCY_TRADING_PURCHASE'])
  })

  it('a payout fee is booked once however often the success is recorded', async () => {
    const a = await agent()
    const wallet = await prisma.wallet.create({ data: { userId: a.id, currencyType: 'POINT' } })
    const w = await prisma.withdrawal.create({
      data: {
        walletId: wallet.id,
        userId: a.id,
        amountPoints: 10_000_000n,
        idempotencyKey: `w-${rid()}`,
        status: 'WAITING',
      },
    })
    const p = await prisma.epayPayoutOrder.create({
      data: {
        withdrawalId: w.id,
        merchantOrderNo: makeEpayMerchantOrderNo('WITHDRAWAL_PAYOUT'),
        receiveEpayAccount: `${rid()}@example.invalid`,
        amount: '1000.00',
        status: 'SUCCESS',
        fee: '0.29',
        completedAt: new Date(),
      },
    })
    await Promise.all([
      paymentTransactionsService.recordEpayPayoutSuccess(p.id),
      paymentTransactionsService.recordEpayPayoutSuccess(p.id),
      paymentTransactionsService.recordEpayPayoutSuccess(p.id),
    ])
    const fees = await prisma.companyCashEntry.findMany({
      where: { ledgerRefId: p.merchantOrderNo, reason: 'EPAY_FEE' },
    })
    expect(fees).toHaveLength(1)
    expect(fees[0]!.amountUsd.toFixed(2)).toBe('0.29')
    expect(fees[0]!.withdrawalId).toBe(w.id)
  })

  it('an Epay refund books the money going back', async () => {
    const a = await agent()
    const o = await tradingOrder(a.id)
    await coinTradingService.creditPaidTopup(o.id, {
      epayOrderNo: null,
      epayStatus: '7',
      paidAmount: D('100'),
      paidCurrency: 'USD',
    })
    const r = await paymentRefundService.applyRefund({
      channel: 'EPAY',
      purchaseExternalId: o.merchantOrderNo!,
      reason: 'test',
    })
    expect(r.outcome).toBe('APPLIED')
    const refunds = await prisma.companyCashEntry.findMany({
      where: { reason: 'EPAY_REFUND', counterpartyUserId: a.id },
    })
    expect(refunds).toHaveLength(1)
    expect(refunds[0]!.amountUsd.toFixed(2)).toBe('100.00')
  })

  it('the attention list shows pay-ins held for review', async () => {
    const a = await agent()
    const o = await tradingOrder(a.id)
    await prisma.coinTradingTopupOrder.update({
      where: { id: o.id },
      data: { status: 'REVIEW', failureReason: 'AMOUNT_MISMATCH:95.00', paidAmount: '95.00' },
    })
    const list = await paymentAttentionService.list()
    const item = list.reviewPayins.find((x) => x.orderId === o.id)
    expect(item).toMatchObject({ kind: 'TRADING_TOPUP', userId: a.id, paidAmount: '95.00' })
  })

  it('personal Epay top-up is refused while the switch is off', async () => {
    const a = await agent()
    await expect(
      coinWalletService.initiateTopup(a.id, '00000000-0000-0000-0000-000000000000', `k-${rid()}`),
    ).rejects.toMatchObject({ code: 'EPAY_PERSONAL_TOPUP_DISABLED', statusCode: 403 })
  })
})

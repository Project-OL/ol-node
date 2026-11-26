/**
 * Payment refund policy on a REAL Postgres (env.setup.ts throwaway DB):
 *  - concurrent refund deliveries apply exactly once (one REFUND row, one ledger debit)
 *  - the coins are taken back even when that leaves a NEGATIVE balance
 *  - the account is suspended indefinitely and every wallet is frozen
 *  - phone / email / device / user land on the payment suspect list
 *  - an Epay callback on a PAID order with a completed refundOrder applies the policy
 * Only the Epay HTTP client and outbound queues are stubbed.
 */
import { randomBytes } from 'crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/queues/platform-message.queue', () => ({
  enqueuePlatformWithdrawalMessage: vi.fn().mockResolvedValue(undefined),
  enqueuePlatformLedgerMessage: vi.fn().mockResolvedValue(undefined),
}))

const queryPayin = vi.fn()
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return {
    ...actual,
    isEpayConfigured: () => true,
    epayGateway: { queryPayin: (...a: unknown[]) => queryPayin(...a) },
  }
})

import { prisma } from '../../src/config/database'
import { redisClient } from '../../src/config/redis'
import { paymentRefundService } from '../../src/services/payment-refund.service'
import { paymentSuspectsService } from '../../src/services/payment-suspects.service'
import { epayPayinService } from '../../src/services/epay-payin.service'
import { makeEpayMerchantOrderNo } from '../../src/lib/epay/epay-order-no'

const rid = () => randomBytes(6).toString('hex')

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

async function buyer(opts: { coinsLeft: bigint }) {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999))
  const user = await prisma.user.create({
    data: {
      username: `b_${rid()}`,
      publicId,
      defaultPublicId: publicId,
      country: 'IN',
      status: 'active',
    },
  })
  const email = `Buyer_${rid()}@Example.com`
  const phone = `+9199${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
  await prisma.authIdentifier.createMany({
    data: [
      { userId: user.id, provider: 'email', identifier: email },
      { userId: user.id, provider: 'phone', identifier: phone },
    ],
  })
  const deviceId = `dev-${rid()}`
  await prisma.session.create({
    data: {
      userId: user.id,
      deviceName: 'Pixel',
      deviceId,
      refreshTokenHash: `rt-${rid()}`,
      ipAddress: '10.0.0.1',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const wallet = await prisma.wallet.create({ data: { userId: user.id, currencyType: 'COIN' } })
  if (opts.coinsLeft > 0n) {
    await prisma.coinLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: 'CREDIT',
        txType: 'TOPUP',
        amount: opts.coinsLeft,
        balanceAfter: opts.coinsLeft,
        idempotencyKey: `seed-${rid()}`,
      },
    })
  }
  return { user, wallet, email, phone, deviceId }
}

async function purchaseRow(
  userId: string,
  units: bigint,
  externalId = `CP-test-${rid()}`,
  amount = '9.99',
) {
  return prisma.paymentTransaction.create({
    data: {
      channel: 'EPAY',
      kind: 'PURCHASE',
      status: 'SUCCEEDED',
      externalId,
      userId,
      walletCurrency: 'COIN',
      amount,
      currency: 'USD',
      units,
      occurredAt: new Date(Date.now() - 60_000),
    },
  })
}

async function coinBalance(walletId: string): Promise<bigint> {
  const last = await prisma.coinLedgerEntry.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

describe('payment refund policy (real Postgres)', () => {
  it('applies once under 5 concurrent deliveries and goes negative', async () => {
    // Bought 64,000 coins, already spent most: only 1,000 left.
    const b = await buyer({ coinsLeft: 1_000n })
    const purchase = await purchaseRow(b.user.id, 64_000n)

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        paymentRefundService.applyRefund({
          channel: 'EPAY',
          purchaseExternalId: purchase.externalId,
          reason: 'test refund',
        }),
      ),
    )
    expect(results.filter((r) => r.outcome === 'APPLIED')).toHaveLength(1)
    expect(results.filter((r) => r.outcome === 'ALREADY_APPLIED')).toHaveLength(4)

    const refunds = await prisma.paymentTransaction.findMany({
      where: { parentId: purchase.id, kind: 'REFUND' },
    })
    expect(refunds).toHaveLength(1)
    expect(refunds[0]!.actionsDoneAt).not.toBeNull()
    expect(refunds[0]!.units).toBe(64_000n)

    const debits = await prisma.coinLedgerEntry.findMany({
      where: { walletId: b.wallet.id, idempotencyKey: { startsWith: 'payment-refund:' } },
    })
    expect(debits).toHaveLength(1)
    expect(debits[0]!.txType).toBe('ADJUSTMENT')
    expect(await coinBalance(b.wallet.id)).toBe(-63_000n)

    const p = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: purchase.id } })
    expect(p.status).toBe('REFUNDED')

    const u = await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })
    expect(u.status).toBe('suspended')
    expect(u.suspendedUntil).toBeNull()
    expect(u.personalCoinsFrozen && u.tradingCoinsFrozen && u.pointsFrozen).toBe(true)

    expect(await paymentSuspectsService.isSuspect('EMAIL', b.email)).toBe(true)
    expect(await paymentSuspectsService.isSuspect('PHONE', b.phone)).toBe(true)
    expect(await paymentSuspectsService.isSuspect('DEVICE', b.deviceId)).toBe(true)
    expect(await paymentSuspectsService.isSuspect('USER', b.user.id)).toBe(true)

    const flag = await prisma.ledgerAuditFlag.findFirst({
      where: { userId: b.user.id, code: 'PAYMENT_REFUND' },
    })
    expect(flag?.severity).toBe('CRITICAL')

    const session = await prisma.session.findFirst({ where: { userId: b.user.id } })
    expect(session?.isRevoked || session?.isActive === false).toBe(true)
  })

  it('a partial refund takes back a proportional share (rounded up)', async () => {
    const b = await buyer({ coinsLeft: 100_000n })
    const purchase = await purchaseRow(b.user.id, 64_000n)
    const r = await paymentRefundService.applyRefund({
      channel: 'EPAY',
      purchaseExternalId: purchase.externalId,
      refundAmount: new (await import('@prisma/client')).Prisma.Decimal('3.33'),
      reason: 'partial',
    })
    expect(r.outcome).toBe('APPLIED')
    // 64,000 × 3.33 / 9.99 = 21,333.33… → 21,334
    expect(await coinBalance(b.wallet.id)).toBe(100_000n - 21_334n)
  })

  it('never downgrades a banned account to suspended', async () => {
    const b = await buyer({ coinsLeft: 0n })
    await prisma.user.update({ where: { id: b.user.id }, data: { status: 'banned' } })
    const purchase = await purchaseRow(b.user.id, 1_000n)
    await paymentRefundService.applyRefund({
      channel: 'EPAY',
      purchaseExternalId: purchase.externalId,
      reason: 'banned user',
    })
    const u = await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })
    expect(u.status).toBe('banned')
    expect(u.pointsFrozen).toBe(true)
  })

  it('an unknown purchase changes nothing', async () => {
    const r = await paymentRefundService.applyRefund({
      channel: 'EPAY',
      purchaseExternalId: `CP-missing-${rid()}`,
      reason: 'x',
    })
    expect(r.outcome).toBe('PURCHASE_NOT_FOUND')
  })

  it('an Epay callback on a PAID order with refundOrder status 7 applies the policy', async () => {
    const b = await buyer({ coinsLeft: 300n })
    const pkg = await prisma.coinPackage.create({
      data: { coins: 300 + Math.floor(Math.random() * 1_000_000), priceCents: 299 },
    })
    const merchantOrderNo = makeEpayMerchantOrderNo('PERSONAL_TOPUP')
    const order = await prisma.coinTopupOrder.create({
      data: {
        userId: b.user.id,
        packageId: pkg.id,
        coins: 300,
        priceCents: 299,
        status: 'PAID',
        merchantOrderNo,
        idempotencyKey: `idem-${rid()}`,
        paidAmount: '2.99',
        paidCurrency: 'USD',
        paidAt: new Date(),
      },
    })
    await purchaseRow(b.user.id, 300n, merchantOrderNo, '2.99')

    queryPayin.mockResolvedValueOnce({
      merchantOrderNo,
      status: '7',
      amount: '2.99',
      currency: 'USD',
      refundOrder: { amount: '2.99', currency: 'USD', status: '7', completeTime: 'x' },
    })
    expect(await epayPayinService.settlePayin(merchantOrderNo, 'callback')).toBe('REFUNDED')
    expect(
      (await prisma.coinTopupOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('REFUNDED')
    expect(await coinBalance(b.wallet.id)).toBe(0n)

    // A second callback for the same refund: no second debit.
    queryPayin.mockResolvedValueOnce({
      merchantOrderNo,
      status: '7',
      refundOrder: { amount: '2.99', status: '7' },
    })
    expect(await epayPayinService.settlePayin(merchantOrderNo, 'callback')).toBe('ALREADY_FINAL')
    expect(await coinBalance(b.wallet.id)).toBe(0n)
  })

  it('a callback on a PAID order without a refund leaves it alone', async () => {
    const b = await buyer({ coinsLeft: 300n })
    const pkg = await prisma.coinPackage.create({
      data: { coins: 300 + Math.floor(Math.random() * 1_000_000), priceCents: 299 },
    })
    const merchantOrderNo = makeEpayMerchantOrderNo('PERSONAL_TOPUP')
    await prisma.coinTopupOrder.create({
      data: {
        userId: b.user.id,
        packageId: pkg.id,
        coins: 300,
        priceCents: 299,
        status: 'PAID',
        merchantOrderNo,
        idempotencyKey: `idem-${rid()}`,
      },
    })
    queryPayin.mockResolvedValueOnce({ merchantOrderNo, status: '7', amount: '2.99' })
    expect(await epayPayinService.settlePayin(merchantOrderNo, 'callback')).toBe('ALREADY_FINAL')
    const u = await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })
    expect(u.status).toBe('active')
  })
})

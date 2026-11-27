import type { ModerationNotificationType } from '@prisma/client'
import { prismaRead } from '../config/database'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'payment-attention' })

/** A payout still in flight after this long needs a human look. */
export const PAYOUT_STUCK_AFTER_MS = 10 * 60 * 1000
/** Insufficient-balance failures stay on the list this long (while the withdrawal is unpaid). */
const BALANCE_FAILURE_WINDOW_MS = 7 * 86_400_000

export type PaymentAlertType = Extract<
  ModerationNotificationType,
  'PAYMENT_REVIEW_NEEDED' | 'EPAY_PAYOUT_ATTENTION'
>

/**
 * Payments that need a person: pay-ins held for REVIEW (amount / currency mismatch), Epay
 * payouts whose outcome is unknown or stuck, and payouts Epay refused for low merchant balance.
 * Alerts go to every SUPER_ADMIN's bell; call sites fire them once, on the transition.
 */
export const paymentAttentionService = {
  /** Fire-and-forget: never fails or slows the payment path that raised it. */
  alert(type: PaymentAlertType, userId: string, reason: string): void {
    void (async () => {
      const { superAdminNotificationService } = await import('./superAdminNotification.service')
      await superAdminNotificationService.notifyAll(type, {
        targetUserId: userId,
        reason: reason.slice(0, 1000),
        restrictedUntil: null,
        performedByAdminId: 'system',
      })
    })().catch((err) => {
      log.warn({ type, userId, err: (err as Error).message }, 'payment alert failed')
    })
  },

  async list() {
    const now = Date.now()
    const [personalReview, tradingReview, payouts] = await Promise.all([
      prismaRead.coinTopupOrder.findMany({
        where: { status: 'REVIEW' },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      prismaRead.coinTradingTopupOrder.findMany({
        where: { status: 'REVIEW' },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      prismaRead.epayPayoutOrder.findMany({
        where: {
          OR: [
            {
              status: { in: ['SUBMITTING', 'SUBMITTED', 'UNKNOWN'] },
              createdAt: { lt: new Date(now - PAYOUT_STUCK_AFTER_MS) },
            },
            {
              status: 'FAILED',
              failureReason: 'INSUFFICIENT_MERCHANT_BALANCE',
              createdAt: { gte: new Date(now - BALANCE_FAILURE_WINDOW_MS) },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ])

    // A low-balance failure stops mattering once the withdrawal moved on (paid or refunded).
    const withdrawals = payouts.length
      ? await prismaRead.withdrawal.findMany({
          where: { id: { in: [...new Set(payouts.map((p) => p.withdrawalId))] } },
          select: { id: true, userId: true, status: true },
        })
      : []
    const wById = new Map(withdrawals.map((w) => [w.id, w]))
    const payoutItems = payouts
      .filter(
        (p) => p.status !== 'FAILED' || wById.get(p.withdrawalId)?.status === 'PENDING_PLATFORM',
      )
      .map((p) => ({
        payoutId: p.id,
        withdrawalId: p.withdrawalId,
        userId: wById.get(p.withdrawalId)?.userId ?? null,
        merchantOrderNo: p.merchantOrderNo,
        amount: p.amount.toFixed(2),
        currency: p.currency,
        status: p.status,
        problem:
          p.status === 'FAILED'
            ? ('INSUFFICIENT_MERCHANT_BALANCE' as const)
            : ('OUTCOME_UNKNOWN' as const),
        failureReason: p.failureReason,
        createdAt: p.createdAt.toISOString(),
      }))

    const reviewItems = [
      ...personalReview.map((o) => ({
        kind: 'PERSONAL_TOPUP' as const,
        orderId: o.id,
        userId: o.userId,
        merchantOrderNo: o.merchantOrderNo,
        orderAmount: (o.priceCents / 100).toFixed(2),
        currency: o.currency,
        paidAmount: o.paidAmount?.toFixed(2) ?? null,
        paidCurrency: o.paidCurrency,
        units: String(o.coins),
        failureReason: o.failureReason,
        updatedAt: o.updatedAt.toISOString(),
      })),
      ...tradingReview.map((o) => ({
        kind: 'TRADING_TOPUP' as const,
        orderId: o.id,
        userId: o.agentUserId,
        merchantOrderNo: o.merchantOrderNo,
        orderAmount: o.amountUsd.toFixed(2),
        currency: o.currency,
        paidAmount: o.paidAmount?.toFixed(2) ?? null,
        paidCurrency: o.paidCurrency,
        units: o.tradingCoinsAwarded.toString(),
        failureReason: o.failureReason,
        updatedAt: o.updatedAt.toISOString(),
      })),
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return {
      counts: { reviewPayins: reviewItems.length, payouts: payoutItems.length },
      reviewPayins: reviewItems,
      payouts: payoutItems,
    }
  },
}

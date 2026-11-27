import { randomUUID } from 'crypto'
import {
  CoinTxType,
  Prisma,
  WalletCurrencyType,
  type PaymentChannel,
  type PaymentTransaction,
} from '@prisma/client'
import { prisma } from '../config/database'
import { rootLogger } from '../utils/rootLogger'
import { auditService } from './audit.service'
import { coinWalletService } from './coin-wallet.service'
import { epayBookkeeping } from './epay-bookkeeping'
import { paymentTransactionsService } from './payment-transactions.service'
import { collectUserIdentities, paymentSuspectsService } from './payment-suspects.service'

const log = rootLogger.child({ module: 'payment-refund' })

/**
 * Payment refund policy (management, 2026-11-26) — the same for Epay, Google Play and Apple:
 *  1. take the purchased coins back, even if the balance goes negative;
 *  2. suspend the account indefinitely and freeze every wallet (coins, trading coins, points);
 *  3. put the buyer's phone, email, devices and user id on the payment suspect list;
 *  4. flag (admin only, no clawback) the users who received most of the buyer's coins since
 *     the purchase.
 * There is deliberately NO clawback from hosts or withdrawals.
 *
 * Exactly once: the REFUND row is unique per (channel, kind, externalId) and is inserted in
 * the same transaction as the coin debit (ledger key `payment-refund:<refundTxnId>`). A
 * concurrent or repeated call finds the row and does nothing to money.
 *
 * After the commit, sessions are revoked, open withdrawals cancelled and super admins
 * notified. Those steps are retried until they succeed (`actionsDoneAt` marks completion);
 * the notification is sent at most once.
 */

export const PAYMENT_REFUND_IDEM_PREFIX = 'payment-refund:'
export const PAYMENT_REFUND_RECIPIENT_FLAG_CODE = 'PAYMENT_REFUND_GIFT_RECIPIENT'
export const PAYMENT_REFUND_BUYER_FLAG_CODE = 'PAYMENT_REFUND'
/** How many top receivers of the buyer's coins are flagged for admins. */
export const PAYMENT_REFUND_TOP_RECIPIENTS = 5
const TX_TIMEOUT_MS = 20_000

export interface ApplyRefundInput {
  channel: PaymentChannel
  /** `externalId` of the PURCHASE row being refunded (Epay merchantOrderNo, store txn id). */
  purchaseExternalId: string
  /** The provider's own refund id; default `<purchaseExternalId>:refund`. */
  refundExternalId?: string | null
  providerRef?: string | null
  /** Refunded amount in the purchase currency; null/undefined = full refund. */
  refundAmount?: Prisma.Decimal | null
  occurredAt?: Date
  /** Short human reason, e.g. "Epay refundOrder status 7". */
  reason: string
  metadata?: Prisma.InputJsonValue
}

export type ApplyRefundResult =
  | { outcome: 'APPLIED'; refundTxnId: string; userId: string; clawedUnits: string }
  | { outcome: 'ALREADY_APPLIED'; refundTxnId: string; userId: string }
  | { outcome: 'PURCHASE_NOT_FOUND' }

/** Units to take back: all of them for a full refund, else proportional, rounded UP. */
export function refundUnits(
  purchaseUnits: bigint,
  purchaseAmount: Prisma.Decimal,
  refundAmount: Prisma.Decimal | null | undefined,
): bigint {
  if (!refundAmount || purchaseAmount.lte(0) || refundAmount.gte(purchaseAmount)) {
    return purchaseUnits
  }
  if (refundAmount.lte(0)) return 0n
  const units = new Prisma.Decimal(purchaseUnits.toString())
    .mul(refundAmount)
    .div(purchaseAmount)
    .ceil()
  return BigInt(units.toFixed(0))
}

function walletTypeOf(purchase: PaymentTransaction): WalletCurrencyType | null {
  if (purchase.walletCurrency === 'COIN') return WalletCurrencyType.COIN
  if (purchase.walletCurrency === 'TRADING_COIN') return WalletCurrencyType.TRADING_COIN
  return null
}

/** Who received the buyer's coins since the purchase (gifts for coins, transfers for trading). */
async function topRecipients(
  tx: Prisma.TransactionClient,
  buyerUserId: string,
  walletType: WalletCurrencyType,
  since: Date,
): Promise<Array<{ userId: string; units: bigint }>> {
  if (walletType === WalletCurrencyType.COIN) {
    const rows = await tx.giftTransaction.groupBy({
      by: ['receiverUserId'],
      where: { senderUserId: buyerUserId, createdAt: { gte: since } },
      _sum: { coinCost: true },
      orderBy: { _sum: { coinCost: 'desc' } },
      take: PAYMENT_REFUND_TOP_RECIPIENTS,
    })
    return rows
      .filter((r) => (r._sum.coinCost ?? 0) > 0)
      .map((r) => ({ userId: r.receiverUserId, units: BigInt(r._sum.coinCost ?? 0) }))
  }
  const wallet = await tx.wallet.findUnique({
    where: { userId_currencyType: { userId: buyerUserId, currencyType: walletType } },
    select: { id: true },
  })
  if (!wallet) return []
  const rows = await tx.coinLedgerEntry.groupBy({
    by: ['counterpartyId'],
    where: {
      walletId: wallet.id,
      txType: CoinTxType.TRADING_TRANSFER_OUT,
      createdAt: { gte: since },
      counterpartyId: { not: null },
    },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: PAYMENT_REFUND_TOP_RECIPIENTS,
  })
  return rows
    .filter((r) => r.counterpartyId && (r._sum.amount ?? 0n) > 0n)
    .map((r) => ({ userId: r.counterpartyId as string, units: r._sum.amount ?? 0n }))
}

export const paymentRefundService = {
  async applyRefund(input: ApplyRefundInput): Promise<ApplyRefundResult> {
    const purchase = await paymentTransactionsService.findOne(
      prisma,
      input.channel,
      'PURCHASE',
      input.purchaseExternalId,
    )
    if (!purchase) {
      log.error(
        { channel: input.channel, purchaseExternalId: input.purchaseExternalId },
        'payment refund for an unknown purchase: nothing applied',
      )
      return { outcome: 'PURCHASE_NOT_FOUND' }
    }

    const refundExternalId = input.refundExternalId || `${input.purchaseExternalId}:refund`
    const walletType = walletTypeOf(purchase)
    const units = refundUnits(purchase.units ?? 0n, purchase.amount, input.refundAmount)
    const now = new Date()

    const applied = await prisma.$transaction(
      async (tx) => {
        const refundTxnId = await paymentTransactionsService.recordInTx(tx, {
          channel: input.channel,
          kind: 'REFUND',
          status: 'APPLIED',
          externalId: refundExternalId,
          providerRef: input.providerRef ?? null,
          parentId: purchase.id,
          userId: purchase.userId,
          walletCurrency: purchase.walletCurrency as 'COIN' | 'TRADING_COIN' | 'POINT',
          amount: input.refundAmount ?? purchase.amount,
          currency: purchase.currency,
          units,
          sourceTable: purchase.sourceTable,
          sourceId: purchase.sourceId,
          reason: input.reason,
          metadata: input.metadata ?? null,
          occurredAt: input.occurredAt ?? now,
        })
        if (!refundTxnId) return null // already recorded → money already handled

        let ledgerEntryId: string | null = null
        let balanceAfter: bigint | null = null
        if (walletType && units > 0n) {
          const debit = await coinWalletService.debit(
            purchase.userId,
            units,
            CoinTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `${PAYMENT_REFUND_IDEM_PREFIX}${refundTxnId}`,
              currencyType: walletType,
              freezeCheck: false,
              balanceCheck: false,
              description: `Payment refund (${input.channel}): ${units} coins taken back`,
              metadata: {
                source: 'payment_refund',
                channel: input.channel,
                purchaseExternalId: input.purchaseExternalId,
                refundTxnId,
              },
            },
          )
          ledgerEntryId = debit.ledgerEntryId
          balanceAfter = debit.balanceAfter
          await tx.paymentTransaction.update({
            where: { id: refundTxnId },
            data: { ledgerEntryId },
          })
        }

        await tx.paymentTransaction.update({
          where: { id: purchase.id },
          data: { status: 'REFUNDED' },
        })
        if (input.channel === 'EPAY') {
          await epayBookkeeping.refund(tx, {
            amount: input.refundAmount ?? purchase.amount,
            counterpartyUserId: purchase.userId,
            ledgerRefId: refundExternalId,
          })
        }

        // Suspend indefinitely (never downgrade a ban / deletion) and freeze every wallet.
        await tx.user.updateMany({
          where: { id: purchase.userId, status: { notIn: ['banned', 'deleted'] } },
          data: { status: 'suspended', suspendedUntil: null },
        })
        await tx.user.update({
          where: { id: purchase.userId },
          data: { personalCoinsFrozen: true, tradingCoinsFrozen: true, pointsFrozen: true },
        })

        const identities = await collectUserIdentities(tx, purchase.userId)
        await paymentSuspectsService.flagInTx(tx, {
          identities,
          userId: purchase.userId,
          reason: 'PAYMENT_REFUND',
          sourceTxnId: refundTxnId,
        })

        const since = purchase.occurredAt
        const recipients = walletType
          ? await topRecipients(tx, purchase.userId, walletType, since)
          : []
        const category = walletType === WalletCurrencyType.TRADING_COIN ? 'TRADING_COIN' : 'COIN'
        await tx.ledgerAuditFlag.createMany({
          data: [
            {
              id: randomUUID(),
              userId: purchase.userId,
              category,
              code: PAYMENT_REFUND_BUYER_FLAG_CODE,
              severity: 'CRITICAL',
              fingerprint: `payment-refund-buyer:${refundTxnId}`,
              summary: `${input.channel} purchase ${input.purchaseExternalId} refunded: ${units} coins taken back; account suspended and frozen`,
              evidence: {
                refundTxnId,
                purchaseTxnId: purchase.id,
                purchaseExternalId: input.purchaseExternalId,
                units: units.toString(),
                balanceAfter: balanceAfter?.toString() ?? null,
              },
              ledgerEntryId,
              windowStart: since,
              windowEnd: now,
            },
            ...recipients.map((r) => ({
              id: randomUUID(),
              userId: r.userId,
              category: 'POINT' as const,
              code: PAYMENT_REFUND_RECIPIENT_FLAG_CODE,
              severity: 'WARNING' as const,
              fingerprint: `payment-refund-recipient:${refundTxnId}:${r.userId}`,
              summary: `Received ${r.units} coins from a buyer whose ${input.channel} purchase was refunded (no clawback)`,
              evidence: {
                refundTxnId,
                buyerUserId: purchase.userId,
                unitsReceivedSincePurchase: r.units.toString(),
                since: since.toISOString(),
              },
              windowStart: since,
              windowEnd: now,
            })),
          ],
          skipDuplicates: true,
        })

        return { refundTxnId, balanceAfter, recipients: recipients.length }
      },
      { timeout: TX_TIMEOUT_MS },
    )

    if (!applied) {
      const existing = await paymentTransactionsService.findOne(
        prisma,
        input.channel,
        'REFUND',
        refundExternalId,
      )
      if (!existing) throw new Error('payment refund: row vanished after a duplicate insert')
      if (!existing.actionsDoneAt) await paymentRefundService.runPostActions(existing)
      return { outcome: 'ALREADY_APPLIED', refundTxnId: existing.id, userId: existing.userId }
    }

    log.warn(
      {
        channel: input.channel,
        purchaseExternalId: input.purchaseExternalId,
        userId: purchase.userId,
        units: units.toString(),
        balanceAfter: applied.balanceAfter?.toString() ?? null,
        flaggedRecipients: applied.recipients,
      },
      'payment refund applied: coins taken back, account suspended and frozen',
    )

    const refundRow = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: applied.refundTxnId },
    })
    await paymentRefundService.runPostActions(refundRow)
    return {
      outcome: 'APPLIED',
      refundTxnId: applied.refundTxnId,
      userId: purchase.userId,
      clawedUnits: units.toString(),
    }
  },

  /**
   * After-commit steps. Each is safe to repeat; a failure throws so the caller (callback /
   * sweeper) retries. The admin notification is sent once, after the claim on `actionsDoneAt`.
   */
  async runPostActions(refund: PaymentTransaction): Promise<void> {
    const userId = refund.userId
    const { sessionService } = await import('./session.service')
    const { withdrawalService } = await import('./withdrawal.service')
    const { walletService } = await import('./wallet.service')
    const { meService } = await import('./me.service')

    await sessionService.revokeAllSessions(userId)
    const cancelled = await withdrawalService.cancelUnsettledWithdrawalsForPointsFreeze(
      userId,
      'system',
    )
    await walletService.adjustCoinBalanceCache(userId, 0n)
    await walletService.adjustTradingBalanceCache(userId)
    await meService.invalidateUserCaches(userId)

    const claimed = await prisma.paymentTransaction.updateMany({
      where: { id: refund.id, actionsDoneAt: null },
      data: { actionsDoneAt: new Date() },
    })
    if (claimed.count === 0) return

    const { superAdminNotificationService } = await import('./superAdminNotification.service')
    void superAdminNotificationService.notifyAll('PAYMENT_REFUND_SUSPENSION', {
      targetUserId: userId,
      reason: `${refund.channel} refund ${refund.externalId}: ${refund.units ?? 0} coins taken back; account suspended, wallets frozen`,
      restrictedUntil: null,
      performedByAdminId: 'system',
    })
    auditService.log({
      userId,
      actionType: 'PAYMENT_REFUND_APPLIED',
      actionStatus: 'success',
      actionDetails: {
        refundTxnId: refund.id,
        channel: refund.channel,
        externalId: refund.externalId,
        units: refund.units?.toString() ?? null,
        cancelledWithdrawalIds: cancelled.cancelledIds,
        skippedEpayInFlightIds: cancelled.skippedEpayInFlightIds,
      },
    })
    if (cancelled.skippedEpayInFlightIds.length > 0) {
      log.error(
        { userId, refundTxnId: refund.id, withdrawalIds: cancelled.skippedEpayInFlightIds },
        'payment refund: an Epay payout to this user is already in flight and could not be stopped',
      )
    }
  },

  /** Sweeper: finish refunds whose after-commit steps failed (run by the reconcile job). */
  async retryPendingActions(limit = 20): Promise<number> {
    const rows = await prisma.paymentTransaction.findMany({
      where: {
        kind: 'REFUND',
        actionsDoneAt: null,
        createdAt: { lt: new Date(Date.now() - 2 * 60_000) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })
    let done = 0
    for (const row of rows) {
      try {
        await paymentRefundService.runPostActions(row)
        done += 1
      } catch (err) {
        log.warn(
          { refundTxnId: row.id, err: (err as Error).message },
          'payment refund post-actions failed (retried next run)',
        )
      }
    }
    return done
  },
}

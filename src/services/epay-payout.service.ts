import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import {
  classifyEpayStatus,
  EPAY_CODE,
  epayCodeOf,
  EpayRejectedError,
  epayGateway,
  isDefinitelyNotSent,
  isEpayConfigured,
  type EpayOrderData,
} from '../lib/epay/epay-gateway.client'
import { makeEpayMerchantOrderNo } from '../lib/epay/epay-order-no'
import { isUniqueViolation } from '../utils/txRetry'
import { mapPool } from '../utils/map-pool'
import { rootLogger } from '../utils/rootLogger'
import { auditService } from './audit.service'
import {
  EPAY_PAYOUT_LIVE_STATUSES,
  isPlatformHandledWithdrawal,
  withdrawalService,
} from './withdrawal.service'

const log = rootLogger.child({ module: 'epay-payout' })

/** If Epay still has no such order this long after we recorded it, it was never created. */
export const PAYOUT_NOT_FOUND_GRACE_MS = 30 * 60 * 1000

export type PayoutSettleResult =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'ALREADY_FINAL'
  | 'UNKNOWN_ORDER'

type PayoutRow = Prisma.EpayPayoutOrderGetPayload<object>

export function isEpayPayoutEnabled(): boolean {
  return isEpayConfigured() && env.EPAY_PAYOUT_ENABLED
}

function decimalOrNull(v: unknown): Prisma.Decimal | null {
  if (v == null || v === '') return null
  try {
    const d = new Prisma.Decimal(String(v))
    return d.isFinite() ? d : null
  } catch {
    return null
  }
}

function epayFields(data: EpayOrderData) {
  return {
    epayOrderNo: typeof data.epayOrderNo === 'string' && data.epayOrderNo ? data.epayOrderNo : null,
    epayStatus: data.status == null ? null : String(data.status),
    fee: decimalOrNull(data.fee),
  }
}

/** Live (non-final) → final, conditional so concurrent callback/reconcile/admin runs agree. */
async function moveLive(
  id: string,
  data: Prisma.EpayPayoutOrderUpdateManyMutationInput,
): Promise<boolean> {
  const res = await prisma.epayPayoutOrder.updateMany({
    where: { id, status: { in: [...EPAY_PAYOUT_LIVE_STATUSES] } },
    data,
  })
  return res.count > 0
}

/** Withdrawal side of a confirmed transfer. Idempotent (no-op once the withdrawal moved on). */
async function finalizeSuccess(row: PayoutRow): Promise<void> {
  await withdrawalService.markPlatformPayoutSentViaEpay(row.withdrawalId, {
    payoutRef: `EPAY:${row.epayOrderNo ?? row.merchantOrderNo}`,
    adminUserId: row.requestedByAdminId,
    merchantOrderNo: row.merchantOrderNo,
  })
}

function logAmountDrift(row: PayoutRow, data: EpayOrderData) {
  const amount = decimalOrNull(data.amount)
  if (amount && !amount.eq(row.amount)) {
    // Money already moved; record loudly for finance (Epay's example shows amount incl. fee).
    log.warn(
      {
        merchantOrderNo: row.merchantOrderNo,
        requested: row.amount.toFixed(2),
        reported: amount.toFixed(2),
        fee: data.fee,
      },
      'epay payout: Epay reports a different amount than requested',
    )
  }
}

export const epayPayoutService = {
  /**
   * Admin action "Pay via Epay" for a PENDING_PLATFORM EPAY withdrawal: transfers
   * `hostPayoutUsd` from our Epay balance to the host's bound Epay account.
   *
   * Safety:
   *  1. Under the withdrawal row lock, records ONE live attempt (DB partial unique index:
   *     one non-FAILED row per withdrawal), so double clicks / two admins can't pay twice and
   *     a concurrent refund (adminReverseWithdrawal) is blocked while it is live.
   *  2. Sends the transfer exactly once. Epay rejection → FAILED (nothing moved; retry allowed).
   *     Timeout / transport error → UNKNOWN: never resent; the reconcile job queries Epay.
   *  3. Status 7 → withdrawal PENDING_PLATFORM → WAITING (same as the manual proof flow).
   */
  async payWithdrawalViaEpay(adminUserId: string, withdrawalId: string) {
    if (!isEpayPayoutEnabled()) {
      throw new AppError(503, 'Epay payouts are not enabled', 'EPAY_PAYOUT_DISABLED')
    }
    const merchantOrderNo = makeEpayMerchantOrderNo('WITHDRAWAL_PAYOUT')

    let row: PayoutRow
    try {
      row = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM withdrawals WHERE id = ${withdrawalId}::uuid FOR UPDATE`
        const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId } })
        if (!w) throw new AppError(404, 'Withdrawal not found', 'NOT_FOUND')
        if (!isPlatformHandledWithdrawal(w) || w.methodType !== 'EPAY') {
          throw new AppError(
            400,
            'Only EPAY withdrawals can be paid via Epay',
            'NOT_EPAY_WITHDRAWAL',
          )
        }
        if (w.status !== 'PENDING_PLATFORM') {
          throw new AppError(400, 'Withdrawal is not awaiting platform payout', 'INVALID_STATE')
        }
        // Under the row lock: any attempt that is not FAILED (live, or SUCCESS whose withdrawal
        // step has not run yet) means money may already be on its way. The DB partial unique
        // index enforces the same rule; this check does not rely on it.
        const openAttempts = await tx.epayPayoutOrder.count({
          where: { withdrawalId, status: { not: 'FAILED' } },
        })
        if (openAttempts > 0) {
          throw new AppError(
            409,
            'An Epay payout for this withdrawal already exists',
            'EPAY_PAYOUT_EXISTS',
          )
        }
        const amount = w.hostPayoutUsd
        if (!amount || amount.lte(0)) {
          throw new AppError(400, 'Withdrawal has no payable USD amount', 'NO_PAYOUT_AMOUNT')
        }
        const method = w.paymentMethodId
          ? await tx.userPaymentMethod.findUnique({ where: { id: w.paymentMethodId } })
          : null
        const receiveEpayAccount = method?.epayEmail?.trim()
        if (!receiveEpayAccount) {
          throw new AppError(400, 'Host has no Epay account on this withdrawal', 'NO_EPAY_ACCOUNT')
        }
        return tx.epayPayoutOrder.create({
          data: {
            withdrawalId,
            merchantOrderNo,
            receiveEpayAccount,
            amount: amount.toDecimalPlaces(2),
            currency: 'USD',
            status: 'SUBMITTING',
            requestedByAdminId: adminUserId,
          },
        })
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(
          409,
          'An Epay payout for this withdrawal already exists',
          'EPAY_PAYOUT_EXISTS',
        )
      }
      throw err
    }

    auditService.logAdmin({
      adminUserId,
      actionType: 'WITHDRAWAL_EPAY_PAYOUT_SUBMIT',
      actionStatus: 'success',
      actionDetails: {
        withdrawalId,
        merchantOrderNo,
        amount: row.amount.toFixed(2),
        currency: row.currency,
      },
    })

    let data: EpayOrderData
    try {
      data = await epayGateway.createEpayTransfer({
        merchantOrderNo,
        amount: row.amount.toFixed(2),
        currency: row.currency,
        receiveEpayAccount: row.receiveEpayAccount,
        remark: 'Withdrawal',
      })
    } catch (err) {
      const code = epayCodeOf(err)
      if (code === EPAY_CODE.DUPLICATE_ORDER) {
        // "The Order has been exist": Epay already HAS this order, so money may have moved.
        // Never treat it as failed (that would allow a second payout); query it instead.
        await moveLive(row.id, { status: 'UNKNOWN', failureReason: 'DUPLICATE_ORDER_AT_EPAY' })
        log.error({ withdrawalId, merchantOrderNo }, 'epay payout: duplicate order; querying')
        return { merchantOrderNo, status: 'UNKNOWN' as const }
      }
      if (code === EPAY_CODE.INSUFFICIENT_BALANCE) {
        // Our merchant balance is too low. Nothing moved; the withdrawal stays queued
        // (PENDING_PLATFORM) and can be paid once finance tops up.
        await moveLive(row.id, { status: 'FAILED', failureReason: 'INSUFFICIENT_MERCHANT_BALANCE' })
        log.error(
          { withdrawalId, merchantOrderNo, amount: row.amount.toFixed(2) },
          'epay payout: merchant balance insufficient - top up the Epay account',
        )
        return {
          merchantOrderNo,
          status: 'FAILED' as const,
          failureReason: 'INSUFFICIENT_MERCHANT_BALANCE',
        }
      }
      if (err instanceof EpayRejectedError) {
        const reason = `EPAY_REJECTED:${String(err.epayCode)}:${err.epayMessage ?? ''}`
        await moveLive(row.id, { status: 'FAILED', failureReason: reason.slice(0, 255) })
        log.warn({ withdrawalId, merchantOrderNo, reason }, 'epay payout rejected; nothing sent')
        return { merchantOrderNo, status: 'FAILED' as const, failureReason: reason }
      }
      if (isDefinitelyNotSent(err)) {
        // Never reached Epay (connection refused / DNS / 4xx / circuit open): nothing moved,
        // so the admin may retry right away instead of waiting for the not-found grace.
        const reason = `NOT_SENT:${(err as Error).message}`.slice(0, 255)
        await moveLive(row.id, { status: 'FAILED', failureReason: reason })
        log.warn({ withdrawalId, merchantOrderNo, reason }, 'epay payout not sent; safe to retry')
        return { merchantOrderNo, status: 'FAILED' as const, failureReason: reason }
      }
      // Outcome unknown: Epay may or may not have the order. Never resend; query later.
      await moveLive(row.id, {
        status: 'UNKNOWN',
        failureReason: `CREATE_OUTCOME_UNKNOWN:${(err as Error).message}`.slice(0, 255),
      })
      log.error(
        { withdrawalId, merchantOrderNo, err: (err as Error).message },
        'epay payout: create outcome unknown; reconcile will query',
      )
      return { merchantOrderNo, status: 'UNKNOWN' as const }
    }

    const f = epayFields(data)
    const outcome = classifyEpayStatus(f.epayStatus)
    const now = new Date()
    if (outcome === 'SUCCESS') {
      await moveLive(row.id, { ...f, status: 'SUCCESS', submittedAt: now, completedAt: now })
      logAmountDrift(row, data)
      const fresh = await prisma.epayPayoutOrder.findUniqueOrThrow({ where: { id: row.id } })
      await finalizeSuccess(fresh)
      return { merchantOrderNo, status: 'SUCCESS' as const, epayOrderNo: f.epayOrderNo }
    }
    if (outcome === 'FAILED') {
      await moveLive(row.id, {
        ...f,
        status: 'FAILED',
        submittedAt: now,
        failureReason: `EPAY_STATUS_${f.epayStatus}`,
      })
      return {
        merchantOrderNo,
        status: 'FAILED' as const,
        failureReason: `EPAY_STATUS_${f.epayStatus}`,
      }
    }
    await moveLive(row.id, { ...f, status: 'SUBMITTED', submittedAt: now })
    return { merchantOrderNo, status: 'SUBMITTED' as const, epayOrderNo: f.epayOrderNo }
  },

  /**
   * Bring one payout attempt to its true state from Epay's own status query. Used by the
   * callback and the reconcile job. Also repairs a SUCCESS row whose withdrawal step did not
   * run (crash between the two). Throws on transport errors (callback → Epay retries).
   */
  async settlePayout(
    merchantOrderNo: string,
    source: 'callback' | 'reconcile',
  ): Promise<PayoutSettleResult> {
    const row = await prisma.epayPayoutOrder.findUnique({ where: { merchantOrderNo } })
    if (!row) return 'UNKNOWN_ORDER'
    if (row.status === 'SUCCESS') {
      await finalizeSuccess(row)
      return 'ALREADY_FINAL'
    }
    if (row.status === 'FAILED') return 'ALREADY_FINAL'

    let data: EpayOrderData
    try {
      data = await epayGateway.queryPayout(merchantOrderNo)
    } catch (err) {
      if (err instanceof EpayRejectedError) {
        // Only "order doesn't exist" (1013) after the grace period proves nothing moved.
        // Any other refusal (e.g. 5000 System Error) proves nothing: keep asking.
        if (
          epayCodeOf(err) === EPAY_CODE.ORDER_NOT_FOUND &&
          Date.now() - row.createdAt.getTime() > PAYOUT_NOT_FOUND_GRACE_MS
        ) {
          const reason = `EPAY_QUERY_REJECTED:${String(err.epayCode)}`
          await moveLive(row.id, { status: 'FAILED', failureReason: reason })
          log.warn({ merchantOrderNo, source, reason }, 'epay payout closed: unknown at Epay')
          return 'FAILED'
        }
        await moveLive(row.id, { lastQueriedAt: new Date(), queryAttempts: { increment: 1 } })
        return 'PENDING'
      }
      throw err
    }

    const f = epayFields(data)
    const outcome = classifyEpayStatus(f.epayStatus)
    if (outcome === 'SUCCESS') {
      const moved = await moveLive(row.id, {
        ...f,
        status: 'SUCCESS',
        completedAt: new Date(),
        lastQueriedAt: new Date(),
        queryAttempts: { increment: 1 },
      })
      if (moved) logAmountDrift(row, data)
      const fresh = await prisma.epayPayoutOrder.findUniqueOrThrow({ where: { id: row.id } })
      await finalizeSuccess(fresh)
      log.info({ merchantOrderNo, source }, 'epay payout succeeded')
      return 'SUCCESS'
    }
    if (outcome === 'FAILED') {
      await moveLive(row.id, {
        ...f,
        status: 'FAILED',
        failureReason: `EPAY_STATUS_${f.epayStatus}`,
        lastQueriedAt: new Date(),
        queryAttempts: { increment: 1 },
      })
      log.warn({ merchantOrderNo, source, epayStatus: f.epayStatus }, 'epay payout failed')
      return 'FAILED'
    }
    await moveLive(row.id, {
      ...f,
      ...(row.status === 'UNKNOWN' || row.status === 'SUBMITTING' ? { status: 'SUBMITTED' } : {}),
      lastQueriedAt: new Date(),
      queryAttempts: { increment: 1 },
    })
    return 'PENDING'
  },

  /** Re-check live payout attempts (reconcile job). Bounded parallel (4) and capped. */
  async reconcileLive(opts: { minAgeMs?: number; requeryAfterMs?: number; limit?: number } = {}) {
    if (!isEpayConfigured()) return { checked: 0, results: {} as Record<string, number> }
    const now = Date.now()
    const rows = await prisma.epayPayoutOrder.findMany({
      where: {
        status: { in: [...EPAY_PAYOUT_LIVE_STATUSES] },
        createdAt: { lt: new Date(now - (opts.minAgeMs ?? 60_000)) },
        OR: [
          { lastQueriedAt: null },
          { lastQueriedAt: { lt: new Date(now - (opts.requeryAfterMs ?? 120_000)) } },
        ],
      },
      select: { merchantOrderNo: true },
      orderBy: { createdAt: 'asc' },
      take: opts.limit ?? 50,
    })
    const results: Record<string, number> = {}
    await mapPool(rows, 4, async (r) => {
      try {
        const out = await epayPayoutService.settlePayout(r.merchantOrderNo, 'reconcile')
        results[out] = (results[out] ?? 0) + 1
      } catch (err) {
        results.ERROR = (results.ERROR ?? 0) + 1
        log.warn(
          { merchantOrderNo: r.merchantOrderNo, err: (err as Error).message },
          'epay payout reconcile failed (retried next run)',
        )
      }
    })
    const repaired = await epayPayoutService.repairUnfinalizedSuccesses()
    if (repaired > 0) results.REPAIRED_WITHDRAWAL = repaired
    return { checked: rows.length, results }
  },

  /**
   * Crash / DB-blip repair: Epay confirmed the transfer (attempt SUCCESS) but the withdrawal
   * step (PENDING_PLATFORM → WAITING) did not run. Without this, only a later callback would
   * fix it. Looks back 7 days; cheap (indexed by status, small result).
   */
  async repairUnfinalizedSuccesses(): Promise<number> {
    const successes = await prisma.epayPayoutOrder.findMany({
      where: { status: 'SUCCESS', completedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      orderBy: { completedAt: 'desc' },
      take: 200,
    })
    if (!successes.length) return 0
    const stuck = await prisma.withdrawal.findMany({
      where: { id: { in: successes.map((s) => s.withdrawalId) }, status: 'PENDING_PLATFORM' },
      select: { id: true },
    })
    const stuckIds = new Set(stuck.map((w) => w.id))
    let repaired = 0
    for (const row of successes) {
      if (!stuckIds.has(row.withdrawalId)) continue
      try {
        await finalizeSuccess(row)
        repaired++
        log.warn(
          { merchantOrderNo: row.merchantOrderNo, withdrawalId: row.withdrawalId },
          'epay payout: repaired a paid withdrawal that was still PENDING_PLATFORM',
        )
      } catch (err) {
        log.error(
          { merchantOrderNo: row.merchantOrderNo, err: (err as Error).message },
          'epay payout: repair failed (retried next run)',
        )
      }
    }
    return repaired
  },

  /** Admin view: every Epay attempt for a withdrawal, newest first. */
  async listForWithdrawal(withdrawalId: string) {
    const rows = await prisma.epayPayoutOrder.findMany({
      where: { withdrawalId },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((r) => ({
      id: r.id,
      merchantOrderNo: r.merchantOrderNo,
      epayOrderNo: r.epayOrderNo,
      receiveEpayAccount: r.receiveEpayAccount,
      amount: r.amount.toFixed(2),
      currency: r.currency,
      status: r.status,
      epayStatus: r.epayStatus,
      fee: r.fee?.toFixed(2) ?? null,
      failureReason: r.failureReason,
      requestedByAdminId: r.requestedByAdminId,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      lastQueriedAt: r.lastQueriedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
  },
}

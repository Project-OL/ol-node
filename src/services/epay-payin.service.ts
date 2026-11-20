import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { mapPool } from '../utils/map-pool'
import {
  classifyEpayStatus,
  EpayRejectedError,
  epayGateway,
  isEpayConfigured,
  type EpayOrderData,
} from '../lib/epay/epay-gateway.client'
import { epayOrderKindOf } from '../lib/epay/epay-order-no'
import { rootLogger } from '../utils/rootLogger'
import { coinWalletService, type EpayPaidFields } from './coin-wallet.service'
import { coinTradingService } from './coinTrading.service'

const log = rootLogger.child({ module: 'epay-payin' })

/** An unpaid order is closed as EXPIRED after this long (Epay closes its own side sooner). */
export const PAYIN_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000
/** If Epay still says "no such order" this long after we created it, it never got created. */
export const PAYIN_NOT_FOUND_GRACE_MS = 30 * 60 * 1000
/** The buyer's status poll triggers a fresh Epay query at most this often per order. */
export const PAYIN_POLL_QUERY_MIN_INTERVAL_MS = 5_000

export type PayinSettleSource = 'callback' | 'reconcile' | 'poll'

export type PayinSettleResult =
  | 'CREDITED'
  | 'ALREADY_FINAL'
  | 'FAILED'
  | 'EXPIRED'
  | 'PENDING'
  | 'REVIEW'
  | 'UNKNOWN_ORDER'

type Kind = 'PERSONAL_TOPUP' | 'TRADING_TOPUP'

interface LoadedOrder {
  kind: Kind
  id: string
  status: string
  createdAt: Date
  expectedAmount: Prisma.Decimal
  expectedCurrency: string
}

async function loadOrder(kind: Kind, merchantOrderNo: string): Promise<LoadedOrder | null> {
  if (kind === 'PERSONAL_TOPUP') {
    const o = await prisma.coinTopupOrder.findUnique({ where: { merchantOrderNo } })
    if (!o) return null
    return {
      kind,
      id: o.id,
      status: o.status,
      createdAt: o.createdAt,
      // priceCents is an integer; dividing by 100 is exact in Decimal.
      expectedAmount: new Prisma.Decimal(o.priceCents).div(100),
      expectedCurrency: o.currency,
    }
  }
  const o = await prisma.coinTradingTopupOrder.findUnique({ where: { merchantOrderNo } })
  if (!o) return null
  return {
    kind,
    id: o.id,
    status: o.status,
    createdAt: o.createdAt,
    expectedAmount: o.amountUsd,
    expectedCurrency: o.currency,
  }
}

/** Conditional PENDING → final update; never touches an order another runner already settled. */
async function closeOrder(
  order: LoadedOrder,
  status: 'FAILED' | 'EXPIRED' | 'REVIEW',
  data: { epayStatus?: string | null; failureReason: string },
): Promise<boolean> {
  const update = {
    status,
    epayStatus: data.epayStatus ?? undefined,
    failureReason: data.failureReason.slice(0, 255),
    lastQueriedAt: new Date(),
    queryAttempts: { increment: 1 },
  }
  const res =
    order.kind === 'PERSONAL_TOPUP'
      ? await prisma.coinTopupOrder.updateMany({
          where: { id: order.id, status: 'PENDING' },
          data: update,
        })
      : await prisma.coinTradingTopupOrder.updateMany({
          where: { id: order.id, status: 'PENDING' },
          data: update,
        })
  return res.count > 0
}

async function touchOrder(order: LoadedOrder, epayStatus: string | null): Promise<void> {
  const data = {
    lastQueriedAt: new Date(),
    queryAttempts: { increment: 1 },
    ...(epayStatus != null ? { epayStatus } : {}),
  }
  if (order.kind === 'PERSONAL_TOPUP') {
    await prisma.coinTopupOrder.updateMany({ where: { id: order.id, status: 'PENDING' }, data })
  } else {
    await prisma.coinTradingTopupOrder.updateMany({
      where: { id: order.id, status: 'PENDING' },
      data,
    })
  }
}

function parseDecimal(v: unknown): Prisma.Decimal | null {
  if (v == null || v === '') return null
  try {
    const d = new Prisma.Decimal(String(v))
    return d.isFinite() ? d : null
  } catch {
    return null
  }
}

/**
 * Pay-in "paid" must match what we asked for, exactly: same order number, same amount
 * (Decimal compare, never float), same currency. Anything else goes to REVIEW for a human.
 */
export function checkPaidMatchesOrder(
  order: Pick<LoadedOrder, 'expectedAmount' | 'expectedCurrency'>,
  merchantOrderNo: string,
  data: EpayOrderData,
): { ok: true; paid: EpayPaidFields } | { ok: false; reason: string } {
  if (data.merchantOrderNo != null && data.merchantOrderNo !== merchantOrderNo) {
    return { ok: false, reason: `ORDER_NO_MISMATCH:${String(data.merchantOrderNo)}` }
  }
  const amount = parseDecimal(data.amount)
  const currency = typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : ''
  if (!amount || !currency) return { ok: false, reason: 'PAID_AMOUNT_OR_CURRENCY_MISSING' }
  if (currency !== order.expectedCurrency.toUpperCase()) {
    return { ok: false, reason: `CURRENCY_MISMATCH:${currency}` }
  }
  if (!amount.eq(order.expectedAmount)) {
    return { ok: false, reason: `AMOUNT_MISMATCH:${amount.toFixed(2)}` }
  }
  return {
    ok: true,
    paid: {
      epayOrderNo: typeof data.epayOrderNo === 'string' ? data.epayOrderNo : null,
      epayStatus: String(data.status),
      paidAmount: amount,
      paidCurrency: currency,
    },
  }
}

export const epayPayinService = {
  /**
   * Bring one pay-in order to its true state. Never trusts the caller's payload: the outcome
   * always comes from Epay's own status query (`/payinApi/queryTransaction`).
   *  - 7 + amount/currency/order match → credit exactly once (status PAID / COMPLETED)
   *  - 7 but mismatch                   → REVIEW (no credit, logged at error level)
   *  - 5 / 6 / 8 / 20                   → FAILED
   *  - anything else                    → stays PENDING (EXPIRED after 24 h)
   * Safe to run concurrently and repeatedly. Throws on transport errors so a callback gets a
   * non-2xx and Epay retries it.
   */
  async settlePayin(
    merchantOrderNo: string,
    source: PayinSettleSource,
  ): Promise<PayinSettleResult> {
    const kind = epayOrderKindOf(merchantOrderNo)
    if (kind !== 'PERSONAL_TOPUP' && kind !== 'TRADING_TOPUP') return 'UNKNOWN_ORDER'
    const order = await loadOrder(kind, merchantOrderNo)
    if (!order) return 'UNKNOWN_ORDER'
    if (order.status !== 'PENDING') return 'ALREADY_FINAL'

    const ageMs = Date.now() - order.createdAt.getTime()
    let data: EpayOrderData
    try {
      data = await epayGateway.queryPayin(merchantOrderNo)
    } catch (err) {
      if (err instanceof EpayRejectedError) {
        // Epay answered but has no usable order (typically "not found": the create call
        // failed in transit). Give it a grace period, then close.
        if (ageMs > PAYIN_NOT_FOUND_GRACE_MS) {
          const reason = `EPAY_QUERY_REJECTED:${String(err.epayCode)}`
          await closeOrder(order, 'FAILED', { failureReason: reason })
          log.warn({ merchantOrderNo, source, reason }, 'epay pay-in closed: unknown at Epay')
          return 'FAILED'
        }
        await touchOrder(order, null)
        return 'PENDING'
      }
      throw err
    }

    const epayStatus = data?.status == null ? null : String(data.status)
    const outcome = classifyEpayStatus(epayStatus)

    if (outcome === 'PENDING') {
      if (ageMs > PAYIN_EXPIRE_AFTER_MS) {
        await closeOrder(order, 'EXPIRED', { epayStatus, failureReason: 'UNPAID_24H' })
        return 'EXPIRED'
      }
      await touchOrder(order, epayStatus)
      return 'PENDING'
    }

    if (outcome === 'FAILED') {
      await closeOrder(order, 'FAILED', { epayStatus, failureReason: `EPAY_STATUS_${epayStatus}` })
      log.info({ merchantOrderNo, source, epayStatus }, 'epay pay-in failed')
      return 'FAILED'
    }

    const check = checkPaidMatchesOrder(order, merchantOrderNo, data)
    if (!check.ok) {
      await closeOrder(order, 'REVIEW', { epayStatus, failureReason: check.reason })
      log.error(
        {
          merchantOrderNo,
          source,
          reason: check.reason,
          expected: order.expectedAmount.toFixed(2),
          expectedCurrency: order.expectedCurrency,
        },
        'epay pay-in PAID but does not match the order: held for review, NOT credited',
      )
      return 'REVIEW'
    }

    const credited =
      kind === 'PERSONAL_TOPUP'
        ? (await coinWalletService.creditPaidTopup(order.id, check.paid)) != null
        : await coinTradingService.creditPaidTopup(order.id, check.paid)
    if (credited) {
      log.info({ merchantOrderNo, source, kind }, 'epay pay-in credited')
      return 'CREDITED'
    }
    return 'ALREADY_FINAL'
  },

  /**
   * Re-check PENDING pay-ins that the callback has not settled. Run by the epay-reconcile
   * repeat job. Sequential and capped: Epay is a third party, not a bulk API.
   */
  async reconcilePending(
    opts: { minAgeMs?: number; requeryAfterMs?: number; limit?: number } = {},
  ) {
    if (!isEpayConfigured()) return { checked: 0, results: {} as Record<string, number> }
    const minAgeMs = opts.minAgeMs ?? 60_000
    const requeryAfterMs = opts.requeryAfterMs ?? 120_000
    const limit = opts.limit ?? 50
    const now = Date.now()
    const where = {
      status: 'PENDING',
      merchantOrderNo: { not: null },
      createdAt: { lt: new Date(now - minAgeMs) },
      OR: [{ lastQueriedAt: null }, { lastQueriedAt: { lt: new Date(now - requeryAfterMs) } }],
    }
    const [personal, trading] = await Promise.all([
      prisma.coinTopupOrder.findMany({
        where,
        select: { merchantOrderNo: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
      prisma.coinTradingTopupOrder.findMany({
        where,
        select: { merchantOrderNo: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    ])
    const rows = [...personal, ...trading].filter(
      (r): r is { merchantOrderNo: string } => r.merchantOrderNo != null,
    )
    const results: Record<string, number> = {}
    // Bounded parallelism: fast enough at volume (~RECONCILE_CONCURRENCY × Epay RTT), but never
    // a burst against a third party. Orders a poll/callback is already querying are skipped.
    await mapPool(rows, RECONCILE_CONCURRENCY, async (row) => {
      if (!(await acquireEpayQueryGate(row.merchantOrderNo, PAYIN_POLL_QUERY_MIN_INTERVAL_MS))) {
        results.SKIPPED_IN_FLIGHT = (results.SKIPPED_IN_FLIGHT ?? 0) + 1
        return
      }
      try {
        const r = await epayPayinService.settlePayin(row.merchantOrderNo, 'reconcile')
        results[r] = (results[r] ?? 0) + 1
      } catch (err) {
        results.ERROR = (results.ERROR ?? 0) + 1
        log.warn(
          { merchantOrderNo: row.merchantOrderNo, err: (err as Error).message },
          'epay reconcile: settle failed (retried next run)',
        )
      }
    })
    return { checked: rows.length, results }
  },

  /**
   * Status-poll hook. NEVER blocks the poll: if this order may have been paid (PENDING) and no
   * instance queried Epay for it in the last few seconds, start one settle in the background
   * and return immediately. The buyer's next poll (~2 s later) sees the result.
   * Single-flight across all instances via a Redis gate, so polling clients can't stampede Epay.
   */
  kickRefresh(merchantOrderNo: string | null): void {
    if (!merchantOrderNo || !isEpayConfigured()) return
    void (async () => {
      if (!(await acquireEpayQueryGate(merchantOrderNo, PAYIN_POLL_QUERY_MIN_INTERVAL_MS))) return
      await epayPayinService.settlePayin(merchantOrderNo, 'poll')
    })().catch((err) => {
      log.debug({ merchantOrderNo, err: (err as Error).message }, 'epay poll refresh failed')
    })
  },
}

/** Max parallel Epay queries per reconcile run. */
export const RECONCILE_CONCURRENCY = 8

/**
 * Single-flight gate for Epay status queries on one order (Redis `SET NX PX`, shared by every
 * instance). Returns true if the caller may query now. Fails OPEN when Redis is unavailable:
 * the gate only saves Epay round-trips; exactly-once crediting is enforced in Postgres.
 */
export async function acquireEpayQueryGate(
  merchantOrderNo: string,
  ttlMs: number,
): Promise<boolean> {
  try {
    const ok = await redisClient.set(
      RedisKeys.epayQueryGate(merchantOrderNo),
      '1',
      'PX',
      ttlMs,
      'NX',
    )
    return ok === 'OK'
  } catch {
    return true
  }
}

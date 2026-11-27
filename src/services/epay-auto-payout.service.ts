import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { epayGateway } from '../lib/epay/epay-gateway.client'
import { rootLogger } from '../utils/rootLogger'
import { EPAY_PAYOUT_LIVE_STATUSES } from './withdrawal.service'
import { paymentAttentionService } from './payment-attention.service'

const log = rootLogger.child({ module: 'epay-auto-payout' })

const WINDOW_MS = 24 * 60 * 60 * 1000
/** Withdrawals looked at per run (oldest first). The job runs every minute. */
export const AUTO_PAYOUT_BATCH = 20
const LAST_RUN_KEY = 'epay:auto-payout:last-run'
const LOW_BALANCE_ALERT_KEY = 'epay:auto-payout:low-balance-alerted'
const LOW_BALANCE_ALERT_TTL_S = 6 * 60 * 60

/** Statuses whose amount counts toward the 24 h caps (sent, or possibly sent). */
const COUNTED_STATUSES = [...EPAY_PAYOUT_LIVE_STATUSES, 'SUCCESS']

export type AutoPayoutConfigDto = {
  enabled: boolean
  maxSinglePayoutUsd: string
  userDailyCapUsd: string
  platformDailyCapUsd: string
  emailChangeHoldHours: number
  minBalanceBufferUsd: string
  feeReserveUsd: string
  updatedAt: string
}

export type AutoPayoutSkip =
  | 'ABOVE_SINGLE_LIMIT'
  | 'USER_DAILY_CAP'
  | 'EMAIL_RECENTLY_CHANGED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'POINTS_FROZEN'
  | 'SUSPECT_LIST'
  | 'NO_EPAY_ACCOUNT'

export type AutoPayoutRun = {
  at: string
  enabled: boolean
  /** Why the run did nothing / stopped early, if it did. */
  stoppedBy:
    | null
    | 'DISABLED'
    | 'EPAY_PAYOUT_OFF'
    | 'PLATFORM_DAILY_CAP'
    | 'LOW_BALANCE'
    | 'BALANCE_UNAVAILABLE'
  balanceUsd: string | null
  paid: Array<{ withdrawalId: string; amountUsd: string; status: string }>
  skipped: Array<{ withdrawalId: string; amountUsd: string; reason: AutoPayoutSkip }>
}

function toDto(row: Prisma.EpayAutoPayoutConfigGetPayload<object>): AutoPayoutConfigDto {
  return {
    enabled: row.enabled,
    maxSinglePayoutUsd: row.maxSinglePayoutUsd.toFixed(2),
    userDailyCapUsd: row.userDailyCapUsd.toFixed(2),
    platformDailyCapUsd: row.platformDailyCapUsd.toFixed(2),
    emailChangeHoldHours: row.emailChangeHoldHours,
    minBalanceBufferUsd: row.minBalanceBufferUsd.toFixed(2),
    feeReserveUsd: row.feeReserveUsd.toFixed(2),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function getConfigRow() {
  return prisma.epayAutoPayoutConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
}

/** USD sent or in flight in the last 24 h, platform-wide and per user (one grouped query). */
async function spentLast24h(since: Date) {
  const rows = await prismaRead.$queryRaw<Array<{ user_id: string; total: Prisma.Decimal }>>`
    SELECT w.user_id, SUM(p.amount) AS total
    FROM epay_payout_orders p
    JOIN withdrawals w ON w.id = p.withdrawal_id
    WHERE p.created_at >= ${since} AND p.status = ANY(${COUNTED_STATUSES})
    GROUP BY w.user_id`
  const perUser = new Map<string, Prisma.Decimal>()
  let platform = new Prisma.Decimal(0)
  for (const r of rows) {
    const t = new Prisma.Decimal(r.total.toString())
    perUser.set(r.user_id, t)
    platform = platform.add(t)
  }
  return { perUser, platform }
}

export const epayAutoPayoutService = {
  async getConfig(): Promise<AutoPayoutConfigDto> {
    return toDto(await getConfigRow())
  },

  async updateConfig(
    adminUserId: string,
    patch: Partial<{
      enabled: boolean
      maxSinglePayoutUsd: number
      userDailyCapUsd: number
      platformDailyCapUsd: number
      emailChangeHoldHours: number
      minBalanceBufferUsd: number
      feeReserveUsd: number
    }>,
  ): Promise<AutoPayoutConfigDto> {
    await getConfigRow()
    const dec = (n: number | undefined) =>
      n == null ? undefined : new Prisma.Decimal(n).toDecimalPlaces(2)
    const row = await prisma.epayAutoPayoutConfig.update({
      where: { id: 1 },
      data: {
        enabled: patch.enabled,
        maxSinglePayoutUsd: dec(patch.maxSinglePayoutUsd),
        userDailyCapUsd: dec(patch.userDailyCapUsd),
        platformDailyCapUsd: dec(patch.platformDailyCapUsd),
        emailChangeHoldHours: patch.emailChangeHoldHours,
        minBalanceBufferUsd: dec(patch.minBalanceBufferUsd),
        feeReserveUsd: dec(patch.feeReserveUsd),
        updatedByAdminId: adminUserId,
      },
    })
    return toDto(row)
  },

  async lastRun(): Promise<AutoPayoutRun | null> {
    try {
      const raw = await redisClient.get(LAST_RUN_KEY)
      return raw ? (JSON.parse(raw) as AutoPayoutRun) : null
    } catch {
      return null
    }
  },

  /**
   * One run of automatic payouts (the `epay-auto-payout` job, every minute, concurrency 1 and
   * a fixed repeat id, so one run at a time cluster-wide). Oldest PENDING_PLATFORM EPAY
   * withdrawal first; each goes through `epayPayoutService.payWithdrawalViaEpay` (row lock +
   * partial unique index: never two payouts for one withdrawal, never a payout racing a
   * refund). A withdrawal that fails a rule is left for an admin and listed in the run summary.
   * Low merchant balance stops the run (oldest-first order is kept: nothing younger jumps it).
   */
  async runOnce(): Promise<AutoPayoutRun> {
    const { isEpayPayoutEnabled, epayPayoutService } = await import('./epay-payout.service')
    const cfg = await getConfigRow()
    const run: AutoPayoutRun = {
      at: new Date().toISOString(),
      enabled: cfg.enabled,
      stoppedBy: null,
      balanceUsd: null,
      paid: [],
      skipped: [],
    }
    const finish = async () => {
      try {
        await redisClient.set(LAST_RUN_KEY, JSON.stringify(run), 'EX', 24 * 60 * 60)
      } catch {
        /* the summary is informational */
      }
      return run
    }
    if (!cfg.enabled) {
      run.stoppedBy = 'DISABLED'
      return finish()
    }
    if (!isEpayPayoutEnabled()) {
      run.stoppedBy = 'EPAY_PAYOUT_OFF'
      return finish()
    }

    const queued = await prismaRead.withdrawal.findMany({
      where: { status: 'PENDING_PLATFORM', methodType: 'EPAY', hostPayoutUsd: { gt: 0 } },
      orderBy: { requestedAt: 'asc' },
      take: AUTO_PAYOUT_BATCH * 2,
      select: { id: true, userId: true, hostPayoutUsd: true, paymentMethodId: true },
    })
    // Already being paid (live or sent, not FAILED): the payout path owns it.
    const busy = queued.length
      ? await prismaRead.epayPayoutOrder.findMany({
          where: { withdrawalId: { in: queued.map((q) => q.id) }, status: { not: 'FAILED' } },
          select: { withdrawalId: true },
        })
      : []
    const busyIds = new Set(busy.map((b) => b.withdrawalId))
    const candidates = queued.filter((q) => !busyIds.has(q.id)).slice(0, AUTO_PAYOUT_BATCH)
    if (candidates.length === 0) return finish()

    const since = new Date(Date.now() - WINDOW_MS)
    const spent = await spentLast24h(since)
    const userIds = [...new Set(candidates.map((c) => c.userId))]
    const methodIds = candidates.map((c) => c.paymentMethodId).filter((x): x is string => !!x)
    const [users, methods, suspects] = await Promise.all([
      prismaRead.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, status: true, pointsFrozen: true },
      }),
      prismaRead.userPaymentMethod.findMany({
        where: { id: { in: methodIds } },
        select: { id: true, epayEmail: true, epayEmailChangedAt: true, updatedAt: true },
      }),
      prismaRead.paymentSuspect.findMany({
        where: { identityType: 'USER', identityValue: { in: userIds }, status: 'ACTIVE' },
        select: { identityValue: true },
      }),
    ])
    const userById = new Map(users.map((u) => [u.id, u]))
    const methodById = new Map(methods.map((m) => [m.id, m]))
    const suspect = new Set(suspects.map((s) => s.identityValue))
    const holdMs = cfg.emailChangeHoldHours * 60 * 60 * 1000

    let balance: Prisma.Decimal | null = null
    try {
      const b = await epayGateway.getBalance('USD')
      balance = b ? new Prisma.Decimal(b.balance) : null
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'auto payout: balance check failed')
    }
    if (!balance || !balance.isFinite()) {
      run.stoppedBy = 'BALANCE_UNAVAILABLE'
      return finish()
    }
    run.balanceUsd = balance.toFixed(2)

    let platformSpent = spent.platform
    for (const c of candidates) {
      const amount = new Prisma.Decimal(c.hostPayoutUsd!.toString())
      const skip = (reason: AutoPayoutSkip) =>
        run.skipped.push({ withdrawalId: c.id, amountUsd: amount.toFixed(2), reason })

      if (amount.gt(cfg.maxSinglePayoutUsd)) {
        skip('ABOVE_SINGLE_LIMIT')
        continue
      }
      const u = userById.get(c.userId)
      if (!u || u.status !== 'active') {
        skip('ACCOUNT_NOT_ACTIVE')
        continue
      }
      if (u.pointsFrozen) {
        skip('POINTS_FROZEN')
        continue
      }
      if (suspect.has(c.userId)) {
        skip('SUSPECT_LIST')
        continue
      }
      const m = c.paymentMethodId ? methodById.get(c.paymentMethodId) : undefined
      if (!m?.epayEmail) {
        skip('NO_EPAY_ACCOUNT')
        continue
      }
      const changedAt = m.epayEmailChangedAt ?? m.updatedAt
      if (Date.now() - changedAt.getTime() < holdMs) {
        skip('EMAIL_RECENTLY_CHANGED')
        continue
      }
      const userSpent = spent.perUser.get(c.userId) ?? new Prisma.Decimal(0)
      if (userSpent.add(amount).gt(cfg.userDailyCapUsd)) {
        skip('USER_DAILY_CAP')
        continue
      }
      // Checked only for a payout that would really be sent: the platform cap stops the run.
      if (platformSpent.add(amount).gt(cfg.platformDailyCapUsd)) {
        run.stoppedBy = 'PLATFORM_DAILY_CAP'
        break
      }
      const needed = amount.add(cfg.feeReserveUsd).add(cfg.minBalanceBufferUsd)
      if (balance.lt(needed)) {
        run.stoppedBy = 'LOW_BALANCE'
        await alertLowBalanceOnce(c.userId, balance, needed)
        break
      }

      try {
        const r = await epayPayoutService.payWithdrawalViaEpay('system', c.id)
        run.paid.push({ withdrawalId: c.id, amountUsd: amount.toFixed(2), status: r.status })
        if (r.status !== 'FAILED') {
          // Counted as spent whether it settled or is still in flight (UNKNOWN / SUBMITTED).
          balance = balance.sub(amount).sub(cfg.feeReserveUsd)
          platformSpent = platformSpent.add(amount)
          spent.perUser.set(c.userId, userSpent.add(amount))
        }
        if (
          r.status === 'FAILED' &&
          'failureReason' in r &&
          r.failureReason === 'INSUFFICIENT_MERCHANT_BALANCE'
        ) {
          run.stoppedBy = 'LOW_BALANCE'
          break
        }
      } catch (err) {
        // Another path got there first (admin click, refund): nothing was sent by us.
        const code = err instanceof AppError ? err.code : 'ERROR'
        log.warn({ withdrawalId: c.id, code }, 'auto payout: withdrawal not paid')
        run.paid.push({ withdrawalId: c.id, amountUsd: amount.toFixed(2), status: `ERROR:${code}` })
      }
    }

    if (run.paid.length > 0 || run.stoppedBy) {
      log.info(
        {
          paid: run.paid.length,
          skipped: run.skipped.length,
          stoppedBy: run.stoppedBy,
          balanceUsd: run.balanceUsd,
        },
        'epay auto payout run',
      )
    }
    return finish()
  },
}

/** Low merchant balance: alert super admins at most once per 6 h while it lasts. */
async function alertLowBalanceOnce(
  userId: string,
  balance: Prisma.Decimal,
  needed: Prisma.Decimal,
): Promise<void> {
  let first = true
  try {
    first =
      (await redisClient.set(LOW_BALANCE_ALERT_KEY, '1', 'EX', LOW_BALANCE_ALERT_TTL_S, 'NX')) ===
      'OK'
  } catch {
    /* Redis down: alert anyway */
  }
  if (!first) return
  paymentAttentionService.alert(
    'EPAY_PAYOUT_ATTENTION',
    userId,
    `Automatic Epay payouts paused: merchant balance $${balance.toFixed(2)}, next payout needs $${needed.toFixed(2)}. Top up the Epay account; payouts resume oldest first.`,
  )
}

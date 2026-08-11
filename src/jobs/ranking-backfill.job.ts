import { RankingBoard } from '@prisma/client'
import type { Job } from 'bullmq'
import { prisma } from '../config/database'
import { rankingRepository } from '../repositories/ranking.repository'
import { getPeriodKeys, RANKING_HISTORY_MAX_DAYS } from '../utils/periodKeys'
import { normalizeCountryOptional } from '../utils/agency-country'
import { RANKING_BACKFILL_JOB, RANKING_RECONCILE_JOB } from '../queues/ranking.constants'
import { rankingService } from '../services/ranking.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'ranking-backfill.job' })

function dayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

async function wipeBoardDays(board: RankingBoard, from: Date, toExclusive: Date) {
  await prisma.$executeRaw`
    DELETE FROM ranking_daily_scores
    WHERE board = ${board}::"RankingBoard"
      AND day >= ${from}::date
      AND day < ${toExclusive}::date
  `
}

/**
 * Rebuild HOST/GIFT/AGENCY/RICH daily scores for a date window from ledger + ADE + recharge.
 */
export async function rebuildRankingWindow(from: Date, toExclusive: Date): Promise<void> {
  log.info({ from, toExclusive }, 'ranking_rebuild_start')

  // HOST from point ledger credits
  await wipeBoardDays(RankingBoard.HOST, from, toExclusive)
  const hostRows = await prisma.$queryRaw<
    { user_id: string; day: Date; score: bigint; country: string | null }[]
  >`
    SELECT w.user_id,
           (ple.created_at AT TIME ZONE 'UTC')::date AS day,
           SUM(ple.amount)::bigint AS score,
           u.country
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id AND w.currency_type = 'POINT'
    INNER JOIN users u ON u.id = w.user_id
    WHERE ple.direction = 'CREDIT'
      AND ple.tx_type IN (
        'GIFT_RECEIVE', 'LIVESTREAM_GIFT', 'VIDEO_CALL', 'SUBSCRIPTION', 'GUARDIAN_PURCHASE'
      )
      AND ple.created_at >= ${from}
      AND ple.created_at < ${toExclusive}
    GROUP BY w.user_id, (ple.created_at AT TIME ZONE 'UTC')::date, u.country
  `
  for (const r of hostRows) {
    if (r.score <= 0n) continue
    await rankingRepository.incrementScore({
      board: RankingBoard.HOST,
      entityId: r.user_id,
      day: dayUtc(new Date(r.day)),
      delta: r.score,
      country: normalizeCountryOptional(r.country),
    })
  }

  // GIFT
  await wipeBoardDays(RankingBoard.GIFT, from, toExclusive)
  const giftRows = await prisma.$queryRaw<
    { user_id: string; day: Date; score: bigint; country: string | null }[]
  >`
    SELECT w.user_id,
           (ple.created_at AT TIME ZONE 'UTC')::date AS day,
           SUM(ple.amount)::bigint AS score,
           u.country
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id AND w.currency_type = 'POINT'
    INNER JOIN users u ON u.id = w.user_id
    WHERE ple.direction = 'CREDIT'
      AND ple.tx_type IN ('GIFT_RECEIVE', 'LIVESTREAM_GIFT')
      AND ple.created_at >= ${from}
      AND ple.created_at < ${toExclusive}
    GROUP BY w.user_id, (ple.created_at AT TIME ZONE 'UTC')::date, u.country
  `
  for (const r of giftRows) {
    if (r.score <= 0n) continue
    await rankingRepository.incrementScore({
      board: RankingBoard.GIFT,
      entityId: r.user_id,
      day: dayUtc(new Date(r.day)),
      delta: r.score,
      country: normalizeCountryOptional(r.country),
    })
  }

  // AGENCY from agency_daily_earnings
  await wipeBoardDays(RankingBoard.AGENCY, from, toExclusive)
  const agencyRows = await prisma.$queryRaw<
    { agency_user_id: string; day: Date; score: bigint; country: string | null }[]
  >`
    SELECT ade.agency_user_id,
           ade.day,
           SUM(ade.host_earnings_points)::bigint AS score,
           u.country
    FROM agency_daily_earnings ade
    INNER JOIN users u ON u.id = ade.agency_user_id
    WHERE ade.day >= ${from}::date
      AND ade.day < ${toExclusive}::date
    GROUP BY ade.agency_user_id, ade.day, u.country
  `
  for (const r of agencyRows) {
    if (r.score <= 0n) continue
    await rankingRepository.incrementScore({
      board: RankingBoard.AGENCY,
      entityId: r.agency_user_id,
      day: dayUtc(new Date(r.day)),
      delta: r.score,
      country: normalizeCountryOptional(r.country),
    })
  }

  // RICH — prefer coin ledger TOPUP/recharge credits if available; else monthly aggregates spread is skipped for day accuracy.
  // Source: monthly_recharge is too coarse for mid-period; scan coin ledger ADJUSTMENT/purchase descriptions via monthly table attribution by last_recharge_at day.
  await wipeBoardDays(RankingBoard.RICH, from, toExclusive)
  const richRows = await prisma.$queryRaw<
    { user_id: string; day: Date; score: bigint; country: string | null }[]
  >`
    SELECT m.user_id,
           (m.last_recharge_at AT TIME ZONE 'UTC')::date AS day,
           m.total_recharge_coins::bigint AS score,
           u.country
    FROM monthly_recharge_aggregates m
    INNER JOIN users u ON u.id = m.user_id
    WHERE (m.last_recharge_at AT TIME ZONE 'UTC')::date >= ${from}::date
      AND (m.last_recharge_at AT TIME ZONE 'UTC')::date < ${toExclusive}::date
      AND m.total_recharge_coins > 0
  `
  // Note: monthly aggregate is month-total assigned on last_recharge_at day — imperfect historic backfill.
  // Live writes use applyRecharge → onRecharge for accurate daily increments going forward.
  for (const r of richRows) {
    if (r.score <= 0n) continue
    await rankingRepository.incrementScore({
      board: RankingBoard.RICH,
      entityId: r.user_id,
      day: dayUtc(new Date(r.day)),
      delta: r.score,
      country: normalizeCountryOptional(r.country),
    })
  }

  await Promise.all([
    rankingService.bumpEpoch(RankingBoard.HOST),
    rankingService.bumpEpoch(RankingBoard.GIFT),
    rankingService.bumpEpoch(RankingBoard.AGENCY),
    rankingService.bumpEpoch(RankingBoard.RICH),
  ])

  log.info({ from, toExclusive }, 'ranking_rebuild_done')
}

export async function processRankingBackfillJob(job: Job): Promise<void> {
  if (job.name !== RANKING_BACKFILL_JOB && job.name !== RANKING_RECONCILE_JOB) return

  const todayKey = getPeriodKeys().dayKey
  const today = new Date(`${todayKey}T00:00:00.000Z`)
  const days = job.name === RANKING_RECONCILE_JOB ? 3 : RANKING_HISTORY_MAX_DAYS
  const from = new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
  const toExclusive = new Date(today.getTime() + 24 * 60 * 60 * 1000)
  await rebuildRankingWindow(from, toExclusive)
}

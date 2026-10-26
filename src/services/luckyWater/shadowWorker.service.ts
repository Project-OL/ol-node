/**
 * F4 shadow worker: tail settled lucky `gift_transactions`, run virtual water draws against
 * `lucky_tier_pool_shadow`, audit to `lucky_draw_audit` (mode=shadow). Never touches live pools,
 * wallets, or coin ledger.
 */
import { randomInt } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { isUniqueViolation } from '../../utils/txRetry'
import { resolveCategory } from './categoryMap'
import { resolveTierConfig, type ResolvedTierConfig } from './resolveTier'
import { collapseBreakdown, computeInflow, drawUnits } from './waterEngine'
import {
  LUCKY_SHADOW_CURSOR_ID,
  SHADOW_SETTLE_LAG_MS,
  SHADOW_WORKER_BATCH_SIZE,
  shadowAuditIdempotencyKey,
} from './shadowWorker.constants'

type Tx = Prisma.TransactionClient

export type ShadowGiftRow = {
  id: string
  senderUserId: string
  giftId: string
  totalCoinCost: number
  quantity: number
  context: string
  createdAt: Date
  unitPrice: number
}

function utcDayStart(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
}

/** True when any tier's lucky_tier_mode row is shadow (B7 authoritative mode table). */
export async function anyTierInShadowMode(db: typeof prisma = prisma): Promise<boolean> {
  const rows = await db.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM lucky_tier_mode WHERE mode = 'shadow' LIMIT 1`
  return rows.length > 0
}

/** SQL fragment: created_at must be older than ledger settle lag (uses Postgres clock). */
export function shadowSettleLagMs(): number {
  return SHADOW_SETTLE_LAG_MS
}

async function readShadowUserCaps(
  tx: Tx,
  senderId: string,
  dailyWinCapCoins: bigint,
  coolDownSeconds: number,
): Promise<{ priorDailyWon: bigint; coolDownActive: boolean }> {
  let priorDailyWon = 0n
  let coolDownActive = false
  if (dailyWinCapCoins > 0n) {
    const rows = await tx.$queryRaw<{ won: bigint }[]>`
      SELECT COALESCE(SUM(paid_reward), 0)::bigint AS won
      FROM lucky_draw_audit
      WHERE sender_user_id = ${senderId}::uuid
        AND mode = 'shadow'
        AND created_at >= ${utcDayStart(new Date())}`
    priorDailyWon = rows[0]?.won ?? 0n
  }
  if (coolDownSeconds > 0) {
    const cutoff = new Date(Date.now() - coolDownSeconds * 1000)
    const rows = await tx.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one
      FROM lucky_draw_audit
      WHERE sender_user_id = ${senderId}::uuid
        AND mode = 'shadow'
        AND created_at >= ${cutoff}
        AND (drawn_json->>'bigWin') = 'true'
      LIMIT 1`
    coolDownActive = rows.length > 0
  }
  return { priorDailyWon, coolDownActive }
}

async function ensureShadowPoolAtL0(tx: Tx, config: ResolvedTierConfig): Promise<bigint> {
  await tx.$executeRaw`
    INSERT INTO lucky_tier_pool_shadow (tier_id, balance, config_version, updated_at)
    VALUES (${config.tierId}, ${config.l0}, ${config.version}, NOW())
    ON CONFLICT (tier_id) DO NOTHING`
  const poolRows = await tx.$queryRaw<{ balance: bigint }[]>`
    SELECT balance FROM lucky_tier_pool_shadow WHERE tier_id = ${config.tierId} FOR UPDATE`
  return poolRows[0]?.balance ?? config.l0
}

async function advanceCursor(tx: Tx, createdAt: Date, id: string): Promise<void> {
  await tx.luckyShadowCursor.upsert({
    where: { id: LUCKY_SHADOW_CURSOR_ID },
    create: { id: LUCKY_SHADOW_CURSOR_ID, lastCreatedAt: createdAt, lastId: id },
    update: { lastCreatedAt: createdAt, lastId: id },
  })
}

/** Sorts after every uuid, so a parked cursor skips all rows at its timestamp. */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

/**
 * Move the cursor to "now − settle lag" (only ever forward). Called while no tier is in shadow,
 * so enabling shadow starts from fresh sends instead of replaying all lucky history.
 */
export async function parkShadowCursor(db: typeof prisma = prisma): Promise<void> {
  const parkAt = new Date(Date.now() - SHADOW_SETTLE_LAG_MS)
  const cursor = await db.luckyShadowCursor.findUnique({ where: { id: LUCKY_SHADOW_CURSOR_ID } })
  if (cursor?.lastCreatedAt && cursor.lastCreatedAt >= parkAt) return
  await db.luckyShadowCursor.upsert({
    where: { id: LUCKY_SHADOW_CURSOR_ID },
    create: { id: LUCKY_SHADOW_CURSOR_ID, lastCreatedAt: parkAt, lastId: MAX_UUID },
    update: { lastCreatedAt: parkAt, lastId: MAX_UUID },
  })
}

export async function fetchShadowGiftBatch(
  db: typeof prisma = prisma,
  limit = SHADOW_WORKER_BATCH_SIZE,
): Promise<ShadowGiftRow[]> {
  const cursor = await db.luckyShadowCursor.findUnique({ where: { id: LUCKY_SHADOW_CURSOR_ID } })
  const lastCreatedAt = cursor?.lastCreatedAt ?? null
  const lastId = cursor?.lastId ?? null

  if (lastCreatedAt == null || lastId == null) {
    // No cursor yet: start from now, never from the beginning of lucky history.
    await parkShadowCursor(db)
    return []
  }

  return db.$queryRaw<ShadowGiftRow[]>`
    SELECT
      gt.id,
      gt.sender_user_id AS "senderUserId",
      gt.gift_id AS "giftId",
      gt.coin_cost AS "totalCoinCost",
      gt.quantity,
      gt.context,
      gt.created_at AS "createdAt",
      g.coin_cost AS "unitPrice"
    FROM gift_transactions gt
    INNER JOIN gifts g ON g.id = gt.gift_id
    WHERE gt.context IN ('LUCKY_SINGLE', 'LUCKY_COMBO')
      AND gt.created_at < NOW() - (${SHADOW_SETTLE_LAG_MS}::int * INTERVAL '1 millisecond')
      AND (gt.created_at, gt.id) > (${lastCreatedAt}, ${lastId}::uuid)
    ORDER BY gt.created_at ASC, gt.id ASC
    LIMIT ${limit}`
}

async function processShadowDraw(tx: Tx, row: ShadowGiftRow, config: ResolvedTierConfig): Promise<void> {
  const unitPrice = BigInt(row.unitPrice)
  const count = row.quantity
  const totalCost = unitPrice * BigInt(count)
  const idempotencyKey = shadowAuditIdempotencyKey(row.id)

  const existing = await tx.luckyDrawAudit.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  })
  if (existing) {
    await advanceCursor(tx, row.createdAt, row.id)
    return
  }

  const poolBalance = await ensureShadowPoolAtL0(tx, config)
  const inflow = computeInflow(totalCost, config.rBp)
  const caps = await readShadowUserCaps(
    tx,
    row.senderUserId,
    config.dailyWinCapCoins,
    config.coolDownAfterBigWinSeconds,
  )

  const draw = drawUnits({
    unitPrice,
    count,
    weights: config.bandWeights,
    thresholds: config.thresholds,
    l0: config.l0,
    floor: config.floor,
    mMax: config.mMax,
    startingWater: poolBalance + inflow,
    dailyWinCapCoins: config.dailyWinCapCoins,
    priorDailyWon: caps.priorDailyWon,
    coolDownActive: caps.coolDownActive,
    randomInt: (min, max) => randomInt(min, max),
  })

  const category = resolveCategory({ count, unitPrice, totalPaid: draw.totalPaid })
  const breakdownArray = collapseBreakdown(draw.rewards).map((v) => Number(v))

  const affected = await tx.$executeRaw`
    UPDATE lucky_tier_pool_shadow
    SET balance = ${draw.finalWater}, config_version = ${config.version}, updated_at = NOW()
    WHERE tier_id = ${config.tierId}
      AND (${draw.totalPaid} = 0 OR ${draw.finalWater} >= ${config.floor})`
  if (affected !== 1) {
    throw new Error(`Shadow pool floor violation tier=${config.tierId} giftTx=${row.id}`)
  }

  const drawnJson = {
    engine: 'water_v1',
    mode: 'shadow',
    tierId: config.tierId,
    configVersion: config.version,
    weightTableId: config.weightTableId,
    wBefore: poolBalance.toString(),
    inflow: inflow.toString(),
    wFinal: draw.finalWater.toString(),
    l0: config.l0.toString(),
    floor: config.floor.toString(),
    rBp: config.rBp,
    bigWin: draw.bigWin,
    units: draw.units,
    giftTransactionId: row.id,
    context: row.context,
  }

  try {
    await tx.luckyDrawAudit.create({
      data: {
        idempotencyKey,
        engine: 'water_v1',
        mode: 'shadow',
        tierId: config.tierId,
        senderUserId: row.senderUserId,
        giftTransactionId: row.id,
        drawnJson: drawnJson as unknown as Prisma.InputJsonValue,
        breakdownArray: breakdownArray as Prisma.InputJsonValue,
        category,
        paidReward: draw.totalPaid,
        senderBalanceAfter: null,
        configVersion: config.version,
      },
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      await advanceCursor(tx, row.createdAt, row.id)
      return
    }
    throw err
  }

  await advanceCursor(tx, row.createdAt, row.id)
}

/** Tail one gift row: resolve tier; shadow draw only when that tier is in shadow mode. */
export async function processShadowGiftRow(row: ShadowGiftRow): Promise<'drawn' | 'skipped' | 'noop'> {
  return prisma.$transaction(async (tx) => {
    const config = await resolveTierConfig(tx, row.unitPrice)
    if (!config || config.mode !== 'shadow') {
      await advanceCursor(tx, row.createdAt, row.id)
      return 'skipped'
    }

    const idempotencyKey = shadowAuditIdempotencyKey(row.id)
    const existing = await tx.luckyDrawAudit.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    })
    if (existing) {
      await advanceCursor(tx, row.createdAt, row.id)
      return 'noop'
    }

    await processShadowDraw(tx, row, config)
    return 'drawn'
  })
}

export type ShadowWorkerTickResult = {
  processed: number
  drawn: number
  skipped: number
  noops: number
  errors: number
}

/**
 * One worker tick: when no tier is in shadow, park the cursor at now (so a later shadow flip never
 * replays the off-period); otherwise tail up to one batch.
 */
export async function runShadowWorkerTick(): Promise<ShadowWorkerTickResult> {
  if (!(await anyTierInShadowMode())) {
    await parkShadowCursor()
    return { processed: 0, drawn: 0, skipped: 0, noops: 0, errors: 0 }
  }

  const batch = await fetchShadowGiftBatch()
  const result: ShadowWorkerTickResult = {
    processed: 0,
    drawn: 0,
    skipped: 0,
    noops: 0,
    errors: 0,
  }

  for (const row of batch) {
    try {
      const outcome = await processShadowGiftRow(row)
      result.processed++
      if (outcome === 'drawn') result.drawn++
      else if (outcome === 'skipped') result.skipped++
      else result.noops++
    } catch (err) {
      result.errors++
      console.error('[lucky-shadow-worker] row failed', {
        giftTransactionId: row.id,
        err,
      })
      break
    }
  }

  return result
}

import type { LuckyTierConfig, Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { hostRevenueShareConfigService } from './hostRevenueShareConfig.service'
import {
  LUCKY_TIER_IDS,
  LuckyWeightsError,
  validateBandWeights,
  type BandWeightsByBand,
  type LuckyTierId,
} from './luckyWater/bandWeights'
import { buildLuckyF2Econ } from './luckyWater/f2Econ'
import { assertEnforceF10Gate } from './luckyWater/enforceGate'
import { bandForWater, lambdaBp } from './luckyWater/waterEngine'
export type LuckyTierConfigDto = {
  id: string
  tierId: string
  version: number
  mode: string
  priceMin: number
  priceMax: number | null
  rBp: number
  jBp: number
  l0: string
  floor: string
  lambdaCriticalMaxBp: number
  lambdaLowMaxBp: number
  lambdaNormalMaxBp: number
  bandWeights: BandWeightsByBand
  weightTableId: string
  mMax: number
  vMaxBp: number
  safetyMarginBp: number
  minGapBp: number
  dailyWinCapCoins: string
  coolDownAfterBigWinSeconds: number
  createdBy: string | null
  createdAt: string
}

export type LuckyTierListItemDto = LuckyTierConfigDto & {
  poolBalance: string | null
  shadowPoolBalance: string | null
  hasSeedDecision: boolean
  latestSeedChoice: string | null
}

export type LuckyTierDashboardDto = {
  tierId: string
  configVersion: number
  mode: string
  poolBalance: string
  shadowPoolBalance: string | null
  l0: string
  floor: string
  lambdaBp: string
  band: string
  rBp: number
  rtpTodayBp: number | null
  drawCountToday: number
  snapshotRtp7dBp: number | null
}

function serializeConfig(row: LuckyTierConfig): LuckyTierConfigDto {
  return {
    id: row.id,
    tierId: row.tierId,
    version: row.version,
    mode: row.mode,
    priceMin: row.priceMin,
    priceMax: row.priceMax,
    rBp: row.rBp,
    jBp: row.jBp,
    l0: row.l0.toString(),
    floor: row.floor.toString(),
    lambdaCriticalMaxBp: row.lambdaCriticalMaxBp,
    lambdaLowMaxBp: row.lambdaLowMaxBp,
    lambdaNormalMaxBp: row.lambdaNormalMaxBp,
    bandWeights: row.bandWeightsJson as unknown as BandWeightsByBand,
    weightTableId: row.weightTableId,
    mMax: row.mMax,
    vMaxBp: row.vMaxBp,
    safetyMarginBp: row.safetyMarginBp,
    minGapBp: row.minGapBp,
    dailyWinCapCoins: row.dailyWinCapCoins.toString(),
    coolDownAfterBigWinSeconds: row.coolDownAfterBigWinSeconds,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

async function getLatestConfig(tierId: LuckyTierId): Promise<LuckyTierConfig | null> {
  return prismaRead.luckyTierConfig.findFirst({
    where: { tierId },
    orderBy: { version: 'desc' },
  })
}

async function validateWeightsForTier(
  weights: BandWeightsByBand,
  tier: Pick<LuckyTierConfig, 'rBp' | 'jBp' | 'vMaxBp' | 'safetyMarginBp' | 'minGapBp'>,
): Promise<Record<string, number>> {
  if (tier.rBp + tier.jBp > 10_000) {
    throw new AppError(422, 'r_bp + j_bp must be ≤ 10000', 'LUCKY_TIER_ECON_INVALID')
  }
  const shares = await hostRevenueShareConfigService.getShares()
  const econ = await buildLuckyF2Econ(shares, tier)
  try {
    return validateBandWeights(weights, econ)
  } catch (e) {
    if (e instanceof LuckyWeightsError) {
      throw new AppError(422, e.message, 'LUCKY_TIER_F2_VIOLATION')
    }
    throw e
  }
}

async function assertEnforceAllowed(
  tierId: string,
  enforceOverrideReason: string | undefined,
): Promise<void> {
  const [hasSeed, hadShadowConfig, hadShadowAudit] = await Promise.all([
    prismaRead.luckyTierSeedLog.findFirst({ where: { tierId }, select: { id: true } }),
    prismaRead.luckyTierConfig.findFirst({ where: { tierId, mode: 'shadow' }, select: { id: true } }),
    prismaRead.luckyDrawAudit.findFirst({
      where: { tierId, mode: 'shadow', engine: 'water_v1' },
      select: { id: true },
    }),
  ])
  assertEnforceF10Gate({
    hasSeedDecision: hasSeed != null,
    hadShadowConfig: hadShadowConfig != null,
    hadShadowAudit: hadShadowAudit != null,
    enforceOverrideReason,
  })
}

function utcTodayStart(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

export const luckyTierAdminService = {
  async listTiers(): Promise<{ tiers: LuckyTierListItemDto[] }> {
    const tiers: LuckyTierListItemDto[] = []
    for (const tierId of LUCKY_TIER_IDS) {
      const config = await getLatestConfig(tierId)
      if (!config) continue
      const [pool, shadowPool, latestSeed] = await Promise.all([
        prismaRead.luckyTierPool.findUnique({ where: { tierId } }),
        prismaRead.luckyTierPoolShadow.findUnique({ where: { tierId } }),
        prismaRead.luckyTierSeedLog.findFirst({
          where: { tierId },
          orderBy: { createdAt: 'desc' },
        }),
      ])
      tiers.push({
        ...serializeConfig(config),
        poolBalance: pool?.balance.toString() ?? null,
        shadowPoolBalance: shadowPool?.balance.toString() ?? null,
        hasSeedDecision: latestSeed != null,
        latestSeedChoice: latestSeed?.choice ?? null,
      })
    }
    return { tiers }
  },

  async getTier(tierId: LuckyTierId): Promise<LuckyTierListItemDto> {
    const config = await getLatestConfig(tierId)
    if (!config) throw new AppError(404, 'Tier config not found', 'LUCKY_TIER_NOT_FOUND')
    const listed = await this.listTiers()
    const hit = listed.tiers.find((t) => t.tierId === tierId)
    if (!hit) throw new AppError(404, 'Tier config not found', 'LUCKY_TIER_NOT_FOUND')
    return hit
  },

  async getDashboard(tierId: LuckyTierId): Promise<LuckyTierDashboardDto> {
    const config = await getLatestConfig(tierId)
    if (!config) throw new AppError(404, 'Tier config not found', 'LUCKY_TIER_NOT_FOUND')

    const pool =
      (await prismaRead.luckyTierPool.findUnique({ where: { tierId } })) ??
      ({ balance: 0n } as { balance: bigint })
    const shadowPool = await prismaRead.luckyTierPoolShadow.findUnique({ where: { tierId } })

    const lam = lambdaBp(pool.balance, config.l0)
    const band = bandForWater(pool.balance, config.l0, {
      criticalMaxBp: config.lambdaCriticalMaxBp,
      lowMaxBp: config.lambdaLowMaxBp,
      normalMaxBp: config.lambdaNormalMaxBp,
    })

    const dayStart = utcTodayStart()
    const auditsToday = await prismaRead.luckyDrawAudit.findMany({
      where: {
        tierId,
        engine: 'water_v1',
        createdAt: { gte: dayStart },
      },
      select: { paidReward: true, drawnJson: true },
    })

    let rtpTodayBp: number | null = null
    if (auditsToday.length > 0) {
      let spent = 0n
      let paid = 0n
      for (const row of auditsToday) {
        paid += row.paidReward
        const dj = row.drawnJson as { inflow?: string; rBp?: number }
        const inflow = dj.inflow ? BigInt(dj.inflow) : 0n
        const r = dj.rBp ?? config.rBp
        if (r > 0 && inflow > 0n) spent += (inflow * 10_000n) / BigInt(r)
      }
      if (spent > 0n) rtpTodayBp = Number((paid * 10_000n) / spent)
    }

    const weekAgo = new Date(dayStart)
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7)
    const snap = await prismaRead.luckyTierDailySnapshot.findMany({
      where: { tierId, dayUtc: { gte: weekAgo } },
      orderBy: { dayUtc: 'desc' },
      take: 7,
    })
    let snapshotRtp7dBp: number | null = null
    if (snap.length > 0) {
      let spent = 0n
      let paid = 0n
      for (const row of snap) {
        spent += row.totalSpent
        paid += row.totalPaid
      }
      if (spent > 0n) snapshotRtp7dBp = Number((paid * 10_000n) / spent)
    }

    return {
      tierId,
      configVersion: config.version,
      mode: config.mode,
      poolBalance: pool.balance.toString(),
      shadowPoolBalance: shadowPool?.balance.toString() ?? null,
      l0: config.l0.toString(),
      floor: config.floor.toString(),
      lambdaBp: lam.toString(),
      band,
      rBp: config.rBp,
      rtpTodayBp,
      drawCountToday: auditsToday.length,
      snapshotRtp7dBp,
    }
  },

  async createConfigVersion(
    adminUserId: string,
    tierId: LuckyTierId,
    patch: {
      rBp?: number
      jBp?: number
      l0?: bigint
      floor?: bigint
      lambdaCriticalMaxBp?: number
      lambdaLowMaxBp?: number
      lambdaNormalMaxBp?: number
      bandWeights?: BandWeightsByBand
      weightTableId?: string
      mMax?: number
      vMaxBp?: number
      safetyMarginBp?: number
      minGapBp?: number
      dailyWinCapCoins?: bigint
      coolDownAfterBigWinSeconds?: number
    },
  ): Promise<LuckyTierConfigDto> {
    const latest = await getLatestConfig(tierId)
    if (!latest) throw new AppError(404, 'Tier config not found', 'LUCKY_TIER_NOT_FOUND')

    const next: Omit<Prisma.LuckyTierConfigCreateInput, 'id'> = {
      tierId,
      version: latest.version + 1,
      mode: latest.mode,
      priceMin: latest.priceMin,
      priceMax: latest.priceMax,
      rBp: patch.rBp ?? latest.rBp,
      jBp: patch.jBp ?? latest.jBp,
      l0: patch.l0 ?? latest.l0,
      floor: patch.floor ?? latest.floor,
      lambdaCriticalMaxBp: patch.lambdaCriticalMaxBp ?? latest.lambdaCriticalMaxBp,
      lambdaLowMaxBp: patch.lambdaLowMaxBp ?? latest.lambdaLowMaxBp,
      lambdaNormalMaxBp: patch.lambdaNormalMaxBp ?? latest.lambdaNormalMaxBp,
      bandWeightsJson: (patch.bandWeights ?? latest.bandWeightsJson) as object,
      weightTableId: patch.weightTableId ?? latest.weightTableId,
      mMax: patch.mMax ?? latest.mMax,
      vMaxBp: patch.vMaxBp ?? latest.vMaxBp,
      safetyMarginBp: patch.safetyMarginBp ?? latest.safetyMarginBp,
      minGapBp: patch.minGapBp ?? latest.minGapBp,
      dailyWinCapCoins: patch.dailyWinCapCoins ?? latest.dailyWinCapCoins,
      coolDownAfterBigWinSeconds:
        patch.coolDownAfterBigWinSeconds ?? latest.coolDownAfterBigWinSeconds,
      createdBy: adminUserId,
    }

    if (next.floor > next.l0) {
      throw new AppError(422, 'floor must be ≤ l0', 'LUCKY_TIER_ECON_INVALID')
    }
    const lambdaCriticalMaxBp = next.lambdaCriticalMaxBp ?? latest.lambdaCriticalMaxBp
    const lambdaLowMaxBp = next.lambdaLowMaxBp ?? latest.lambdaLowMaxBp
    const lambdaNormalMaxBp = next.lambdaNormalMaxBp ?? latest.lambdaNormalMaxBp
    if (!(lambdaCriticalMaxBp < lambdaLowMaxBp && lambdaLowMaxBp < lambdaNormalMaxBp)) {
      throw new AppError(422, 'Lambda thresholds must be strictly increasing', 'LUCKY_TIER_ECON_INVALID')
    }

    await validateWeightsForTier(next.bandWeightsJson as unknown as BandWeightsByBand, {
      rBp: next.rBp ?? latest.rBp,
      jBp: next.jBp ?? latest.jBp,
      vMaxBp: next.vMaxBp ?? latest.vMaxBp,
      safetyMarginBp: next.safetyMarginBp ?? latest.safetyMarginBp,
      minGapBp: next.minGapBp ?? latest.minGapBp,
    })

    const row = await prisma.luckyTierConfig.create({ data: next })
    return serializeConfig(row)
  },

  async setMode(
    adminUserId: string,
    tierId: LuckyTierId,
    mode: 'off' | 'shadow' | 'enforce',
    enforceOverrideReason?: string,
  ): Promise<LuckyTierConfigDto> {
    const latest = await getLatestConfig(tierId)
    if (!latest) throw new AppError(404, 'Tier config not found', 'LUCKY_TIER_NOT_FOUND')
    if (latest.mode === mode) return serializeConfig(latest)

    if (mode === 'enforce') {
      await assertEnforceAllowed(tierId, enforceOverrideReason)
    }

    const row = await prisma.luckyTierConfig.create({
      data: {
        tierId,
        version: latest.version + 1,
        mode,
        priceMin: latest.priceMin,
        priceMax: latest.priceMax,
        rBp: latest.rBp,
        jBp: latest.jBp,
        l0: latest.l0,
        floor: latest.floor,
        lambdaCriticalMaxBp: latest.lambdaCriticalMaxBp,
        lambdaLowMaxBp: latest.lambdaLowMaxBp,
        lambdaNormalMaxBp: latest.lambdaNormalMaxBp,
        bandWeightsJson: latest.bandWeightsJson as object,
        weightTableId: latest.weightTableId,
        mMax: latest.mMax,
        vMaxBp: latest.vMaxBp,
        safetyMarginBp: latest.safetyMarginBp,
        minGapBp: latest.minGapBp,
        dailyWinCapCoins: latest.dailyWinCapCoins,
        coolDownAfterBigWinSeconds: latest.coolDownAfterBigWinSeconds,
        createdBy: adminUserId,
      },
    })

    return serializeConfig(row)
  },

  async recordSeedDecision(
    adminUserId: string,
    tierId: LuckyTierId,
    choice: 'seed' | 'start_empty' | 'capped_ladder',
    amount: bigint,
    reason?: string,
  ): Promise<{ seedLogId: string; poolBalance: string | null }> {
    if (choice === 'seed' && amount <= 0n) {
      throw new AppError(422, 'Seed amount must be positive when choice=seed', 'LUCKY_TIER_SEED_INVALID')
    }
    if (choice !== 'seed' && amount !== 0n) {
      throw new AppError(422, 'amount must be 0 unless choice=seed', 'LUCKY_TIER_SEED_INVALID')
    }

    const latest = await getLatestConfig(tierId)
    if (!latest) throw new AppError(404, 'Tier config not found', 'LUCKY_TIER_NOT_FOUND')

    const result = await prisma.$transaction(async (tx) => {
      const log = await tx.luckyTierSeedLog.create({
        data: {
          tierId,
          amount,
          adminId: adminUserId,
          reason: reason ?? null,
          choice,
        },
      })

      let poolBalance: string | null = null
      if (choice === 'seed') {
        const pool = await tx.luckyTierPool.upsert({
          where: { tierId },
          create: {
            tierId,
            balance: amount,
            configVersion: latest.version,
          },
          update: {
            balance: amount,
            configVersion: latest.version,
          },
        })
        poolBalance = pool.balance.toString()
      }

      return { seedLogId: log.id, poolBalance }
    })

    return result
  },

  /** Used by host-revenue update and unit tests. */
  async tierHasSeedDecision(tierId: string): Promise<boolean> {
    const row = await prismaRead.luckyTierSeedLog.findFirst({
      where: { tierId },
      select: { id: true },
    })
    return row != null
  },
}

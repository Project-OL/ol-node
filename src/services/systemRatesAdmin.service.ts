import { LevelType, Prisma } from '@prisma/client'
import { PERSONAL_COIN_EXCHANGE_RATES } from '../config/coin-trading-rates.defaults'
import { prisma } from '../config/database'
import {
  CT_RATES_TTL,
  RedisKeys,
  SYSTEM_RATES_CONFIG_TTL,
  redisClient,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { coinTradingRepository } from '../repositories/coinTrading.repository'
import { walletUserLevelRepository } from '../repositories/wallet-user-level.repository'
import { agencyCommissionConfigService } from './agencyCommissionConfig.service'
import { agencyCommissionService } from './agencyCommission.service'
import { hostRevenueShareConfigService } from './hostRevenueShareConfig.service'
import { payrollAdminService } from './payrollAdmin.service'
import { walletLevelService } from './user-level.service'
import { videoCallPriceCapService } from './videoCallPriceCap.service'

export type RateTierInput = {
  minUsd: number
  maxUsd?: number | null
  coinsPerUsd: number
}

export type CoinPackageInput = {
  coins: number
  priceCents: number
  currency?: string
  label?: string | null
}

export type TradingTopupPackageInput = {
  tradingCoins: string
  priceCents: number
  coinsPerUsd: number
  currency?: string
  label?: string | null
}

export type WalletLevelThresholdInput = {
  level: number
  threshold: string
  label?: string | null
  iconKey?: string | null
}

export type CommissionLevelInput = {
  level: string
  minWindowPoints: string
  liveRateBp: number
  matchChatRateBp: number
  sortOrder: number
}

function formatRateTier(row: {
  minUsd?: Prisma.Decimal
  maxUsd?: Prisma.Decimal | null
  minUsdEquiv?: Prisma.Decimal
  maxUsdEquiv?: Prisma.Decimal | null
  coinsPerUsd: number
  sortOrder: number
}) {
  const min = row.minUsd ?? row.minUsdEquiv!
  const max = row.maxUsd !== undefined ? row.maxUsd : (row.maxUsdEquiv ?? null)
  return {
    minUsd: Number(min.toString()),
    maxUsd: max == null ? null : Number(max.toString()),
    coinsPerUsd: row.coinsPerUsd,
    sortOrder: row.sortOrder,
  }
}

function formatCoinPackage(row: {
  id: string
  coins: number
  priceCents: number
  currency: string
  label: string | null
  sortOrder: number
}) {
  return {
    id: row.id,
    coins: row.coins,
    priceCents: row.priceCents,
    amountUsd: (row.priceCents / 100).toFixed(2),
    currency: row.currency,
    label: row.label,
    sortOrder: row.sortOrder,
  }
}

function formatTradingPackage(row: {
  id: string
  tradingCoins: bigint
  priceCents: number
  coinsPerUsd: number
  currency: string
  label: string | null
  sortOrder: number
}) {
  return {
    id: row.id,
    tradingCoins: row.tradingCoins.toString(),
    priceCents: row.priceCents,
    amountUsd: (row.priceCents / 100).toFixed(2),
    coinsPerUsd: row.coinsPerUsd,
    currency: row.currency,
    label: row.label,
    sortOrder: row.sortOrder,
  }
}

export const systemRatesAdminService = {
  // ── Trading topup rates ──────────────────────────────────────────────
  async getTopupRates() {
    const rows = await coinTradingRepository.getTopupRates()
    return { tiers: rows.map((r) => formatRateTier(r)) }
  },

  async replaceTopupRates(tiers: RateTierInput[]) {
    await prisma.$transaction(async (tx) => {
      await tx.coinTradingTopupRate.updateMany({ data: { isActive: false } })
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i]!
        await tx.coinTradingTopupRate.create({
          data: {
            minUsd: tier.minUsd,
            maxUsd: tier.maxUsd ?? null,
            coinsPerUsd: tier.coinsPerUsd,
            sortOrder: i + 1,
            isActive: true,
          },
        })
      }
    })
    await redisClient.del(RedisKeys.ctTopupRates(), RedisKeys.ctTopupPackages())
    return this.getTopupRates()
  },

  // ── Agent exchange rates ─────────────────────────────────────────────
  async getAgentExchangeRates() {
    const rows = await coinTradingRepository.getExchangeRates()
    return {
      tiers: rows.map((r) =>
        formatRateTier({
          minUsdEquiv: r.minUsdEquiv,
          maxUsdEquiv: r.maxUsdEquiv,
          coinsPerUsd: r.coinsPerUsd,
          sortOrder: r.sortOrder,
        }),
      ),
    }
  },

  async replaceAgentExchangeRates(tiers: RateTierInput[]) {
    await prisma.$transaction(async (tx) => {
      await tx.agentExchangeRate.updateMany({ data: { isActive: false } })
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i]!
        await tx.agentExchangeRate.create({
          data: {
            minUsdEquiv: tier.minUsd,
            maxUsdEquiv: tier.maxUsd ?? null,
            coinsPerUsd: tier.coinsPerUsd,
            sortOrder: i + 1,
            isActive: true,
          },
        })
      }
    })
    await redisClient.del(
      RedisKeys.ctExchangeRates(),
      RedisKeys.ctExchangePackages('agent'),
      RedisKeys.ctExchangePackages('personal'),
    )
    return this.getAgentExchangeRates()
  },

  // ── Personal exchange rates ──────────────────────────────────────────
  async getPersonalExchangeRates() {
    const key = RedisKeys.ctPersonalExchangeRates()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as { tiers: ReturnType<typeof formatRateTier>[] }
    } catch {
      /* miss */
    }

    let rows = await coinTradingRepository.getPersonalExchangeRates()
    if (rows.length === 0) {
      // Fallback seed from defaults if migration seed missing
      rows = PERSONAL_COIN_EXCHANGE_RATES.map((t, i) => ({
        id: `fallback-${i}`,
        minUsdEquiv: new Prisma.Decimal(t.minUsd),
        maxUsdEquiv: t.maxUsd == null ? null : new Prisma.Decimal(t.maxUsd),
        coinsPerUsd: t.coinsPerUsd,
        sortOrder: i + 1,
        isActive: true,
        updatedAt: new Date(),
      }))
    }

    const dto = {
      tiers: rows.map((r) =>
        formatRateTier({
          minUsdEquiv: r.minUsdEquiv,
          maxUsdEquiv: r.maxUsdEquiv,
          coinsPerUsd: r.coinsPerUsd,
          sortOrder: r.sortOrder,
        }),
      ),
    }
    try {
      await redisClient.setex(key, SYSTEM_RATES_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async replacePersonalExchangeRates(tiers: RateTierInput[]) {
    await prisma.$transaction(async (tx) => {
      await tx.personalExchangeRate.updateMany({ data: { isActive: false } })
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i]!
        await tx.personalExchangeRate.create({
          data: {
            minUsdEquiv: tier.minUsd,
            maxUsdEquiv: tier.maxUsd ?? null,
            coinsPerUsd: tier.coinsPerUsd,
            sortOrder: i + 1,
            isActive: true,
          },
        })
      }
    })
    await redisClient.del(
      RedisKeys.ctPersonalExchangeRates(),
      RedisKeys.ctExchangePackages('personal'),
    )
    return this.getPersonalExchangeRates()
  },

  /** Runtime loader for personal exchange (DB rows or defaults). */
  async loadPersonalExchangeRateRows() {
    const rows = await coinTradingRepository.getPersonalExchangeRates()
    if (rows.length > 0) return rows
    return PERSONAL_COIN_EXCHANGE_RATES.map((t, i) => ({
      id: `fallback-${i}`,
      minUsdEquiv: new Prisma.Decimal(t.minUsd),
      maxUsdEquiv: t.maxUsd == null ? null : new Prisma.Decimal(t.maxUsd),
      coinsPerUsd: t.coinsPerUsd,
      sortOrder: i + 1,
      isActive: true,
      updatedAt: new Date(),
    }))
  },

  // ── Trading topup packages ───────────────────────────────────────────
  async getTradingTopupPackages() {
    const rows = await coinTradingRepository.getTopupPackages()
    return { packages: rows.map(formatTradingPackage) }
  },

  async replaceTradingTopupPackages(packages: TradingTopupPackageInput[]) {
    await prisma.$transaction(async (tx) => {
      const keepIds: string[] = []
      for (let i = 0; i < packages.length; i++) {
        const pkg = packages[i]!
        const tradingCoins = BigInt(pkg.tradingCoins)
        if (tradingCoins <= 0n) {
          throw new AppError(400, 'tradingCoins must be positive', 'VALIDATION_ERROR')
        }
        const row = await tx.coinTradingTopupPackage.upsert({
          where: {
            tradingCoins_priceCents: {
              tradingCoins,
              priceCents: pkg.priceCents,
            },
          },
          create: {
            tradingCoins,
            priceCents: pkg.priceCents,
            coinsPerUsd: pkg.coinsPerUsd,
            currency: pkg.currency ?? 'USD',
            label: pkg.label ?? null,
            sortOrder: i + 1,
            isActive: true,
          },
          update: {
            coinsPerUsd: pkg.coinsPerUsd,
            currency: pkg.currency ?? 'USD',
            label: pkg.label ?? null,
            sortOrder: i + 1,
            isActive: true,
          },
        })
        keepIds.push(row.id)
      }
      await tx.coinTradingTopupPackage.updateMany({
        where: keepIds.length ? { id: { notIn: keepIds } } : {},
        data: { isActive: false },
      })
    })
    await redisClient.del(RedisKeys.ctTopupPackages())
    return this.getTradingTopupPackages()
  },

  // ── Personal coin packages ───────────────────────────────────────────
  async getCoinPackages() {
    const key = RedisKeys.coinPackages()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as { packages: ReturnType<typeof formatCoinPackage>[] }
    } catch {
      /* miss */
    }
    const rows = await coinTradingRepository.getCoinPackages()
    const dto = { packages: rows.map(formatCoinPackage) }
    try {
      await redisClient.setex(key, CT_RATES_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async replaceCoinPackages(packages: CoinPackageInput[]) {
    await prisma.$transaction(async (tx) => {
      const keepIds: string[] = []
      for (let i = 0; i < packages.length; i++) {
        const pkg = packages[i]!
        const row = await tx.coinPackage.upsert({
          where: {
            coins_priceCents: {
              coins: pkg.coins,
              priceCents: pkg.priceCents,
            },
          },
          create: {
            coins: pkg.coins,
            priceCents: pkg.priceCents,
            currency: pkg.currency ?? 'USD',
            label: pkg.label ?? null,
            sortOrder: i + 1,
            isActive: true,
          },
          update: {
            currency: pkg.currency ?? 'USD',
            label: pkg.label ?? null,
            sortOrder: i + 1,
            isActive: true,
          },
        })
        keepIds.push(row.id)
      }
      await tx.coinPackage.updateMany({
        where: keepIds.length ? { id: { notIn: keepIds } } : {},
        data: { isActive: false },
      })
    })
    await redisClient.del(RedisKeys.coinPackages())
    return this.getCoinPackages()
  },

  // ── Wallet level thresholds ──────────────────────────────────────────
  async getWalletLevelConfigs() {
    const [wealth, livestream] = await Promise.all([
      walletUserLevelRepository.getConfigs(LevelType.WEALTH),
      walletUserLevelRepository.getConfigs(LevelType.LIVESTREAM),
    ])
    const map = (rows: Awaited<ReturnType<typeof walletUserLevelRepository.getConfigs>>) =>
      rows.map((r) => ({
        level: r.level,
        threshold: r.threshold.toString(),
        label: r.label,
        iconKey: r.iconKey,
      }))
    return { wealth: map(wealth), livestream: map(livestream) }
  },

  async replaceWalletLevelConfigs(body: {
    wealth?: WalletLevelThresholdInput[]
    livestream?: WalletLevelThresholdInput[]
  }) {
    if (!body.wealth && !body.livestream) {
      throw new AppError(400, 'Provide wealth and/or livestream thresholds', 'VALIDATION_ERROR')
    }

    await prisma.$transaction(async (tx) => {
      const replaceType = async (levelType: LevelType, items: WalletLevelThresholdInput[]) => {
        await tx.walletLevelConfig.updateMany({
          where: { levelType },
          data: { isActive: false },
        })
        for (const item of items) {
          const threshold = BigInt(item.threshold)
          if (threshold < 0n) {
            throw new AppError(400, 'threshold must be non-negative', 'VALIDATION_ERROR')
          }
          await tx.walletLevelConfig.upsert({
            where: { levelType_level: { levelType, level: item.level } },
            create: {
              levelType,
              level: item.level,
              threshold,
              label: item.label ?? null,
              iconKey: item.iconKey ?? null,
              isActive: true,
            },
            update: {
              threshold,
              label: item.label ?? null,
              iconKey: item.iconKey ?? null,
              isActive: true,
            },
          })
        }
      }
      if (body.wealth) await replaceType(LevelType.WEALTH, body.wealth)
      if (body.livestream) await replaceType(LevelType.LIVESTREAM, body.livestream)
    })

    await walletLevelService.invalidateConfigCache()
    return this.getWalletLevelConfigs()
  },

  // ── Commission levels ────────────────────────────────────────────────
  async getCommissionLevels() {
    const levels = await agencyCommissionService.getLevelConfig()
    return { levels }
  },

  async replaceCommissionLevels(levels: CommissionLevelInput[]) {
    if (levels.length === 0) {
      throw new AppError(400, 'levels must be a non-empty array', 'VALIDATION_ERROR')
    }
    await prisma.$transaction(async (tx) => {
      for (const row of levels) {
        const minWindowPoints = BigInt(row.minWindowPoints)
        if (minWindowPoints < 0n) {
          throw new AppError(400, 'minWindowPoints must be non-negative', 'VALIDATION_ERROR')
        }
        if (row.liveRateBp < 0 || row.liveRateBp > 10_000) {
          throw new AppError(422, 'liveRateBp must be 0–10000', 'INVALID_RATE_BP')
        }
        if (row.matchChatRateBp < 0 || row.matchChatRateBp > 10_000) {
          throw new AppError(422, 'matchChatRateBp must be 0–10000', 'INVALID_RATE_BP')
        }
        await tx.agencyCommissionLevel.upsert({
          where: { level: row.level },
          create: {
            level: row.level,
            minWindowPoints,
            liveRateBp: row.liveRateBp,
            matchChatRateBp: row.matchChatRateBp,
            sortOrder: row.sortOrder,
          },
          update: {
            minWindowPoints,
            liveRateBp: row.liveRateBp,
            matchChatRateBp: row.matchChatRateBp,
            sortOrder: row.sortOrder,
          },
        })
      }
    })
    await redisClient.del(RedisKeys.agencyLevelConfig())
    await agencyCommissionService.enqueueDailyRecomputeMaster({ force: true })
    const dto = await this.getCommissionLevels()
    return { ...dto, recomputeEnqueued: true as const }
  },

  // ── Aggregate snapshot for Settings home ─────────────────────────────
  async getAggregateRates() {
    const [
      hostRevenueShares,
      personalExchangeRates,
      coinPackages,
      walletLevelConfigs,
      videoCallPriceCaps,
      topupRates,
      agentExchangeRates,
      tradingTopupPackages,
      commissionLevels,
      commissionWindow,
      payroll,
    ] = await Promise.all([
      hostRevenueShareConfigService.getConfig(),
      this.getPersonalExchangeRates(),
      this.getCoinPackages(),
      this.getWalletLevelConfigs(),
      videoCallPriceCapService.getCaps(),
      this.getTopupRates(),
      this.getAgentExchangeRates(),
      this.getTradingTopupPackages(),
      this.getCommissionLevels(),
      agencyCommissionConfigService.getConfig(),
      payrollAdminService.getConfig(),
    ])

    return {
      hostRevenueShares,
      personalExchangeRates,
      coinPackages,
      walletLevelConfigs,
      videoCallPriceCaps,
      tradingTopupRates: topupRates,
      agentExchangeRates,
      tradingTopupPackages,
      commissionLevels,
      commissionWindow,
      payroll,
    }
  },
}

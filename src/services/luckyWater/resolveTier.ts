/**
 * Tier + engine resolution for the water_v1 lucky engine (Phase 3).
 *
 * Tier is a function of the unit price (`gift.coinCost`) at send time, not the gift id: every
 * positive price maps to exactly one tier (ranges are contiguous, T50K is the open ceiling). We pin
 * the latest config `version` for that tier; in-flight draws keep the version read at tx start.
 *
 * Engine: water_v1 runs only when the caller advertised a server draw AND the tier is in `enforce`
 * mode AND a seed decision has been logged for it. Anything else keeps the exact legacy path.
 */
import type { Prisma } from '@prisma/client'
import type { BandWeightsByBand } from './bandWeights'
import type { LambdaThresholds } from './waterEngine'

type Tx = Prisma.TransactionClient

export interface ResolvedTierConfig {
  id: string
  tierId: string
  version: number
  mode: string
  priceMin: number
  priceMax: number | null
  rBp: number
  jBp: number
  l0: bigint
  floor: bigint
  thresholds: LambdaThresholds
  bandWeights: BandWeightsByBand
  weightTableId: string
  mMax: number
  vMaxBp: number
  dailyWinCapCoins: bigint
  coolDownAfterBigWinSeconds: number
}

export interface EngineResolution {
  engine: 'legacy' | 'water_v1'
  config: ResolvedTierConfig | null
  seedExists: boolean
}

/**
 * Latest config version whose price range contains `unitPrice`. Ranges never overlap, so ordering
 * by version desc returns the newest config of the single matching tier. null = no tier (unmapped).
 */
export async function resolveTierConfig(
  tx: Tx,
  unitPrice: number,
): Promise<ResolvedTierConfig | null> {
  const row = await tx.luckyTierConfig.findFirst({
    where: {
      priceMin: { lte: unitPrice },
      OR: [{ priceMax: null }, { priceMax: { gte: unitPrice } }],
    },
    orderBy: { version: 'desc' },
  })
  if (!row) return null
  return {
    id: row.id,
    tierId: row.tierId,
    version: row.version,
    mode: row.mode,
    priceMin: row.priceMin,
    priceMax: row.priceMax ?? null,
    rBp: row.rBp,
    jBp: row.jBp,
    l0: row.l0,
    floor: row.floor,
    thresholds: {
      criticalMaxBp: row.lambdaCriticalMaxBp,
      lowMaxBp: row.lambdaLowMaxBp,
      normalMaxBp: row.lambdaNormalMaxBp,
    },
    bandWeights: row.bandWeightsJson as unknown as BandWeightsByBand,
    weightTableId: row.weightTableId,
    mMax: row.mMax,
    vMaxBp: row.vMaxBp,
    dailyWinCapCoins: row.dailyWinCapCoins,
    coolDownAfterBigWinSeconds: row.coolDownAfterBigWinSeconds,
  }
}

/** F-gate: water_v1 only runs for a tier that has a seed decision logged (enforce requires it). */
export async function tierHasSeed(tx: Tx, tierId: string): Promise<boolean> {
  const row = await tx.luckyTierSeedLog.findFirst({ where: { tierId }, select: { id: true } })
  return row != null
}

/**
 * Decide the engine for a lucky send inside the money tx.
 *   water_v1  iff  supportsServerDraw && config.mode === 'enforce' && a seed row exists
 *   legacy    otherwise (no server-draw support, no tier, non-enforce mode, or no seed)
 */
export async function resolveEngine(
  tx: Tx,
  unitPrice: number,
  supportsServerDraw: boolean,
): Promise<EngineResolution> {
  if (!supportsServerDraw) return { engine: 'legacy', config: null, seedExists: false }
  const config = await resolveTierConfig(tx, unitPrice)
  if (!config) return { engine: 'legacy', config: null, seedExists: false }
  const seedExists = await tierHasSeed(tx, config.tierId)
  const engine = config.mode === 'enforce' && seedExists ? 'water_v1' : 'legacy'
  return { engine, config, seedExists }
}

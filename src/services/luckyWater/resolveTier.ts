/**
 * Tier + engine resolution for the water_v1 lucky engine.
 *
 * Mode (B6/B7): always read from `lucky_tier_mode` inside the money transaction — no mode cache,
 * no FOR UPDATE. Instant cross-instance rollback when admin flips mode.
 *
 * Immutable config (weights, thresholds, L0/floor for a version): cached by config version id.
 * C1: all DB reads that run under resolveEngine / resolveTierConfig use the transaction client `tx`
 * (never the global prisma) so the money tx cannot nest a second pool connection.
 */
import type { Prisma } from '@prisma/client'
import type { BandWeightsByBand } from './bandWeights'
import type { LambdaThresholds } from './waterEngine'

type Tx = Prisma.TransactionClient
/** Prisma client or interactive tx — both support the reads we need. */
type Db = Tx

export interface ResolvedTierConfig {
  id: string
  tierId: string
  version: number
  /** Runtime mode from lucky_tier_mode (not the deprecated config.mode column). */
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

/** Immutable config rows keyed by config id (version identity). */
const immutableConfigById = new Map<string, Omit<ResolvedTierConfig, 'mode'>>()
/** Latest config id per tier (price routing); not used for mode. */
let latestConfigMeta: {
  at: number
  byTier: Map<string, { id: string; priceMin: number; priceMax: number | null }>
} | null = null
const seedCache = new Map<string, { at: number; exists: boolean }>()

/** TTL for immutable latest-config index + seed existence (mode is never cached). */
export const LUCKY_TIER_CONFIG_CACHE_TTL_MS = 10_000

export function bustLuckyTierConfigCache(): void {
  immutableConfigById.clear()
  latestConfigMeta = null
  seedCache.clear()
}

function rowToImmutable(row: {
  id: string
  tierId: string
  version: number
  priceMin: number
  priceMax: number | null
  rBp: number
  jBp: number
  l0: bigint
  floor: bigint
  lambdaCriticalMaxBp: number
  lambdaLowMaxBp: number
  lambdaNormalMaxBp: number
  bandWeightsJson: unknown
  weightTableId: string
  mMax: number
  vMaxBp: number
  dailyWinCapCoins: bigint
  coolDownAfterBigWinSeconds: number
}): Omit<ResolvedTierConfig, 'mode'> {
  return {
    id: row.id,
    tierId: row.tierId,
    version: row.version,
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

/**
 * Refresh latest-config index using the provided DB handle (must be `tx` when called
 * from inside a money transaction — C1 nested-connection fix).
 */
async function refreshLatestConfigIndex(
  db: Db,
): Promise<Map<string, { id: string; priceMin: number; priceMax: number | null }>> {
  const now = Date.now()
  if (latestConfigMeta && now - latestConfigMeta.at < LUCKY_TIER_CONFIG_CACHE_TTL_MS) {
    return latestConfigMeta.byTier
  }
  const rows = await db.luckyTierConfig.findMany({
    orderBy: [{ tierId: 'asc' }, { version: 'desc' }],
    select: {
      id: true,
      tierId: true,
      version: true,
      priceMin: true,
      priceMax: true,
      rBp: true,
      jBp: true,
      l0: true,
      floor: true,
      lambdaCriticalMaxBp: true,
      lambdaLowMaxBp: true,
      lambdaNormalMaxBp: true,
      bandWeightsJson: true,
      weightTableId: true,
      mMax: true,
      vMaxBp: true,
      dailyWinCapCoins: true,
      coolDownAfterBigWinSeconds: true,
    },
  })
  const byTier = new Map<string, { id: string; priceMin: number; priceMax: number | null }>()
  for (const row of rows) {
    if (!byTier.has(row.tierId)) {
      byTier.set(row.tierId, {
        id: row.id,
        priceMin: row.priceMin,
        priceMax: row.priceMax ?? null,
      })
      immutableConfigById.set(row.id, rowToImmutable(row))
    }
  }
  latestConfigMeta = { at: now, byTier }
  return byTier
}

function pickTierMetaForPrice(
  byTier: Map<string, { id: string; priceMin: number; priceMax: number | null }>,
  unitPrice: number,
): { id: string; priceMin: number; priceMax: number | null } | null {
  for (const meta of byTier.values()) {
    if (unitPrice < meta.priceMin) continue
    if (meta.priceMax != null && unitPrice > meta.priceMax) continue
    return meta
  }
  return null
}

/** Read mode for a tier inside the money tx — single-row SELECT, no lock, no cache. */
export async function readTierModeInTx(tx: Tx, tierId: string): Promise<string> {
  const rows = await tx.$queryRaw<{ mode: string }[]>`
    SELECT mode FROM lucky_tier_mode WHERE tier_id = ${tierId}`
  return rows[0]?.mode ?? 'off'
}

/**
 * Latest config whose price range contains `unitPrice`, with live mode from lucky_tier_mode.
 * All reads go through `tx` (C1).
 */
export async function resolveTierConfig(
  tx: Tx,
  unitPrice: number,
): Promise<ResolvedTierConfig | null> {
  const byTier = await refreshLatestConfigIndex(tx)
  let meta = pickTierMetaForPrice(byTier, unitPrice)
  if (!meta) {
    const row = await tx.luckyTierConfig.findFirst({
      where: {
        priceMin: { lte: unitPrice },
        OR: [{ priceMax: null }, { priceMax: { gte: unitPrice } }],
      },
      orderBy: { version: 'desc' },
    })
    if (!row) return null
    immutableConfigById.set(row.id, rowToImmutable(row))
    meta = { id: row.id, priceMin: row.priceMin, priceMax: row.priceMax ?? null }
  }
  let immutable = immutableConfigById.get(meta.id)
  if (!immutable) {
    const row = await tx.luckyTierConfig.findUnique({ where: { id: meta.id } })
    if (!row) return null
    immutable = rowToImmutable(row)
    immutableConfigById.set(row.id, immutable)
  }
  const mode = await readTierModeInTx(tx, immutable.tierId)
  return { ...immutable, mode }
}

export async function tierHasSeed(tx: Tx, tierId: string): Promise<boolean> {
  const now = Date.now()
  const cached = seedCache.get(tierId)
  if (cached && now - cached.at < LUCKY_TIER_CONFIG_CACHE_TTL_MS) return cached.exists
  const row = await tx.luckyTierSeedLog.findFirst({ where: { tierId }, select: { id: true } })
  const exists = row != null
  seedCache.set(tierId, { at: now, exists })
  return exists
}

/**
 * water_v1 iff supportsServerDraw && lucky_tier_mode.mode === 'enforce' && seed exists.
 * Mode is always read in-tx (B6); seed only queried when mode is enforce.
 */
export async function resolveEngine(
  tx: Tx,
  unitPrice: number,
  supportsServerDraw: boolean,
): Promise<EngineResolution> {
  if (!supportsServerDraw) return { engine: 'legacy', config: null, seedExists: false }
  const config = await resolveTierConfig(tx, unitPrice)
  if (!config) return { engine: 'legacy', config: null, seedExists: false }
  if (config.mode !== 'enforce') {
    return { engine: 'legacy', config, seedExists: false }
  }
  const seedExists = await tierHasSeed(tx, config.tierId)
  const engine = seedExists ? 'water_v1' : 'legacy'
  return { engine, config, seedExists }
}

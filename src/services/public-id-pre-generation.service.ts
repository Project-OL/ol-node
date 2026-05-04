import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { classifyPublicId, type VipClassification } from './vip-classifier.service'
import { priceCreditsForTier } from './vip-rare-id-pricing'
import { publicIdRepository } from '../repositories/public-id.repository'
import { classificationProgressRepository } from '../repositories/classification-progress.repository'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'public-id-pre-generation' })

export type HorizonJobResult = {
  scanned: number
  vipsAdded: number
  skipped: number
}

async function runHorizonJobInner(): Promise<HorizonJobResult> {
  const horizon = env.PUBLIC_ID_PREGEN_HORIZON_AHEAD
  const batchSize = BigInt(Math.max(1, env.PUBLIC_ID_PREGEN_BATCH_SIZE))

  const currentNext = await publicIdRepository.peekNextValue()
  const lastClassified = await classificationProgressRepository.get()
  const target = currentNext + horizon

  if (lastClassified >= target) {
    return { scanned: 0, vipsAdded: 0, skipped: 0 }
  }

  const maxUserRow = await prisma.user.aggregate({ _max: { publicId: true } })
  const maxUserPublicId = maxUserRow._max.publicId ?? 0n

  let scanned = 0
  let vipsAdded = 0
  let skipped = 0

  let cursor = lastClassified + 1n
  while (cursor <= target) {
    const batchEnd = cursor + batchSize - 1n > target ? target : cursor + batchSize - 1n
    const batch = await processBatch(cursor, batchEnd, maxUserPublicId)
    scanned += batch.scanned
    vipsAdded += batch.vipsAdded
    skipped += batch.skipped
    await classificationProgressRepository.set(batchEnd)
    cursor = batchEnd + 1n
  }

  log.info({ scanned, vipsAdded, skipped, target: target.toString() }, '[pregen] horizon batch complete')
  return { scanned, vipsAdded, skipped }
}

export async function processBatch(
  from: bigint,
  to: bigint,
  maxUserPublicId: bigint,
): Promise<{ scanned: number; vipsAdded: number; skipped: number }> {
  const vips: Array<{ publicId: bigint; classification: VipClassification }> = []
  let scanned = 0
  let skipped = 0

  for (let id = from; id <= to; id += 1n) {
    scanned += 1
    const classification = classifyPublicId(id)
    if (!classification.isVip) continue
    if (id <= maxUserPublicId) {
      skipped += 1
      continue
    }
    vips.push({ publicId: id, classification })
  }

  if (vips.length === 0) {
    return { scanned, vipsAdded: 0, skipped }
  }

  const createRes = await prisma.vipPublicId.createMany({
    data: vips.map(({ publicId, classification: c }) => ({
      publicId,
      tier: c.tier,
      priceGroup: c.priceGroup,
      rarityScore: c.rarityScore,
      matchedRules: c.matchedRules,
      detectedAt: new Date(),
      isAvailable: true,
      priceCredits: priceCreditsForTier(c.tier),
      currentOwnerId: null,
      assignedAt: null,
    })),
    skipDuplicates: true,
  })

  const pipeline = redisClient.pipeline()
  for (const { publicId } of vips) {
    pipeline.sadd(RedisKeys.vipReserved(), publicId.toString())
  }
  try {
    await pipeline.exec()
  } catch (err) {
    log.error({ err }, '[pregen] Redis SADD pipeline failed (DB is authoritative; next run repairs)')
  }

  log.info(
    {
      from: from.toString(),
      to: to.toString(),
      vipCandidates: vips.length,
      inserted: createRes.count,
      skippedCollisions: skipped,
    },
    '[pregen] batch summary',
  )

  return { scanned, vipsAdded: createRes.count, skipped }
}

export const publicIdPreGenerationService = {
  runHorizonJob: runHorizonJobInner,
  processBatch,
}

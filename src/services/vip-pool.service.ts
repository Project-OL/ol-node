import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import type { VipClassification } from './vip-classifier.service'
import { VipTier } from './vip-classifier.service'

/**
 * Redis + Postgres VIP inventory: pool sorted sets, meta hashes, reserved set (no TTL on vip:* keys).
 */
export const vipPoolService = {
  /**
   * Adds a classified VIP ID to Redis pool + reserved set and upserts the Postgres row.
   */
  async add(publicId: bigint, classification: VipClassification): Promise<void> {
    const tier = classification.tier
    const pid = String(publicId)
    const detectedAt = Date.now()
    const detectedIso = new Date(detectedAt).toISOString()

    const pipeline = redisClient.pipeline()
    pipeline.zadd(RedisKeys.vipPool(tier), detectedAt, pid)
    pipeline.hset(RedisKeys.vipMeta(publicId), {
      tier: classification.tier,
      priceGroup: classification.priceGroup,
      rarityScore: String(classification.rarityScore),
      matchedRules: JSON.stringify(classification.matchedRules),
      detectedAt: detectedIso,
    })
    pipeline.sadd(RedisKeys.vipReserved(), pid)
    try {
      await pipeline.exec()
    } catch (err) {
      console.error('[vip-pool] Redis pipeline failed in add()', err)
      return
    }

    try {
      await prisma.vipPublicId.upsert({
        where: { publicId },
        create: {
          publicId,
          tier: classification.tier,
          priceGroup: classification.priceGroup,
          rarityScore: classification.rarityScore,
          matchedRules: classification.matchedRules,
          detectedAt: new Date(detectedAt),
          isAvailable: true,
        },
        update: {
          tier: classification.tier,
          priceGroup: classification.priceGroup,
          rarityScore: classification.rarityScore,
          matchedRules: classification.matchedRules,
          detectedAt: new Date(detectedAt),
        },
      })
    } catch (err) {
      console.error('[vip-pool] Prisma upsert failed in add()', err)
    }
  },

  /**
   * Rehydrates Redis VIP pool and meta from Postgres (unassigned rows only).
   */
  async warmCache(): Promise<void> {
    const rows = await prisma.vipPublicId.findMany({
      where: { assignedAt: null },
    })

    for (const row of rows) {
      const tier = row.tier as VipTier
      const pid = String(row.publicId)
      const score = row.detectedAt.getTime()
      const pipeline = redisClient.pipeline()
      pipeline.zadd(RedisKeys.vipPool(tier), score, pid)
      pipeline.hset(RedisKeys.vipMeta(row.publicId), {
        tier: row.tier,
        priceGroup: row.priceGroup,
        rarityScore: String(row.rarityScore),
        matchedRules: JSON.stringify(row.matchedRules),
        detectedAt: row.detectedAt.toISOString(),
      })
      try {
        await pipeline.exec()
      } catch (err) {
        console.error('[vip-pool] Redis pipeline failed in warmCache()', err)
      }
    }
  },

  /**
   * Removes an ID from the available pool (e.g. after purchase) and marks it assigned in Postgres.
   */
  async consume(publicId: bigint, tier: VipTier): Promise<void> {
    const pid = String(publicId)
    const pipeline = redisClient.pipeline()
    pipeline.zrem(RedisKeys.vipPool(tier), pid)
    pipeline.del(RedisKeys.vipMeta(publicId))
    try {
      await pipeline.exec()
    } catch (err) {
      console.error('[vip-pool] Redis pipeline failed in consume()', err)
    }

    try {
      await prisma.vipPublicId.update({
        where: { publicId },
        data: { assignedAt: new Date() },
      })
    } catch (err) {
      console.error('[vip-pool] Prisma update failed in consume()', err)
    }
  },
}

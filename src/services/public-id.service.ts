import { redisClient, RedisKeys } from '../config/redis'
import { publicIdRepository } from '../repositories/public-id.repository'
import { prisma } from '../config/database'
import { classifyPublicId, type VipClassification } from './vip-classifier.service'
import { vipPoolService } from './vip-pool.service'
import { userPublicIdService } from './user-public-id.service'
import { priceCreditsForTier } from './vip-rare-id-pricing'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'public-id' })

export interface PublicIdResult {
  publicId: bigint
  classification: VipClassification
}

export const publicIdService = {
  /**
   * Returns the next sequential public ID suitable as a new user’s permanent base ID: not VIP-reserved and
   * not matching any VIP pattern. VIP-pattern sequence values are enrolled in the VIP pool and skipped.
   */
  async getNextPublicId(userId: string): Promise<PublicIdResult> {
    const { publicId: id, classification } = await this._nextNonReservedNonVip()
    if (userId.length > 0) {
      userPublicIdService.setOriginalPublicId(userId, id).catch((err) => {
        console.error(`[public-id] Failed to store originalPublicId for ${userId}`, err)
      })
    }
    return { publicId: id, classification }
  },

  /**
   * Next sequence value that is neither VIP-reserved nor VIP-classified; VIP hits are catalogued for the store.
   */
  async _nextNonReservedNonVip(): Promise<{
    publicId: bigint
    classification: VipClassification
  }> {
    const MAX_ITERATIONS = 200
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const id = await publicIdRepository.getNextAndIncrement()
      if (await this.isReserved(id)) continue

      const classification = classifyPublicId(id)
      if (classification.isVip) {
        log.error(
          { id: id.toString(), tier: classification.tier },
          '[public-id] pregen miss; classifying inline',
        )
        try {
          await prisma.vipPublicId.create({
            data: {
              publicId: id,
              tier: classification.tier,
              priceGroup: classification.priceGroup,
              rarityScore: classification.rarityScore,
              matchedRules: classification.matchedRules,
              detectedAt: new Date(),
              isAvailable: true,
              priceCredits: priceCreditsForTier(classification.tier),
            },
          })
        } catch (err) {
          log.error({ err }, '[public-id] inline vipPublicId.create failed')
        }
        try {
          await redisClient.sadd(RedisKeys.vipReserved(), id.toString())
        } catch {
          /* ignore */
        }
        continue
      }
      return { publicId: id, classification }
    }
    throw new Error('[public-id] exhausted MAX_ITERATIONS for non-VIP allocation')
  },

  /**
   * Classifies an arbitrary public ID (e.g. diagnostics).
   */
  classifyExisting(publicId: bigint): VipClassification {
    return classifyPublicId(publicId)
  },

  /**
   * Loads all `vip_public_ids` into Redis `vip:reserved`.
   */
  async warmVipCache(): Promise<void> {
    await vipPoolService.warmReservedSet()
  },

  /**
   * Check if public ID is in VIP reserved list (DB + cache).
   */
  async isReserved(publicId: bigint): Promise<boolean> {
    const cached = await redisClient.sismember(RedisKeys.vipReserved(), String(publicId))
    if (cached === 1) return true
    const row = await prisma.vipPublicId.findUnique({
      where: { publicId },
    })
    if (row) {
      await redisClient.sadd(RedisKeys.vipReserved(), String(publicId))
      return true
    }
    return false
  },
}

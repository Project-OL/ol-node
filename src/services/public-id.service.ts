import { redisClient, RedisKeys } from '../config/redis'
import { publicIdRepository } from '../repositories/public-id.repository'
import { prisma } from '../config/database'
import { classifyPublicId, type VipClassification } from './vip-classifier.service'
import { vipPoolService } from './vip-pool.service'
import { userPublicIdService } from './user-public-id.service'

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
   * Next sequence value that is neither VIP-reserved nor VIP-classified; VIP hits go to pool only.
   */
  async _nextNonReservedNonVip(): Promise<{
    publicId: bigint
    classification: VipClassification
  }> {
    while (true) {
      const id = await publicIdRepository.getNextAndIncrement()
      if (await this.isReserved(id)) {
        continue
      }
      const classification = classifyPublicId(id)
      if (classification.isVip) {
        void vipPoolService.add(id, classification).catch((err) => {
          console.error(`[public-id] vipPoolService.add failed for ${id}`, err)
        })
        continue
      }
      return { publicId: id, classification }
    }
  },

  /**
   * Classifies an arbitrary public ID (e.g. diagnostics).
   */
  classifyExisting(publicId: bigint): VipClassification {
    return classifyPublicId(publicId)
  },

  /**
   * Loads unassigned VIP rows from Postgres into Redis pool/meta.
   */
  async warmVipCache(): Promise<void> {
    await vipPoolService.warmCache()
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

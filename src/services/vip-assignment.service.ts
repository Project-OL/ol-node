import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { vipAssignmentRepository } from '../repositories/vip-assignment.repository'
import { PriceGroup, VipTier } from './vip-classifier.service'

export interface ActiveVipAssignment {
  publicId: bigint
  tier: VipTier
  priceGroup: PriceGroup
  expiresAt: Date
  ttlSeconds: number
}

async function getActiveAssignmentFromDb(userId: string): Promise<ActiveVipAssignment | null> {
  const row = await vipAssignmentRepository.findActive(userId)
  if (!row) return null
  const meta = await prisma.vipPublicId.findUnique({ where: { publicId: row.publicId } })
  const ttlSeconds = Math.max(0, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000))
  return {
    publicId: row.publicId,
    tier: (meta?.tier as VipTier) ?? VipTier.NONE,
    priceGroup: (meta?.priceGroup as PriceGroup) ?? PriceGroup.STANDARD,
    expiresAt: row.expiresAt,
    ttlSeconds,
  }
}

/**
 * Revokes an active VIP assignment and clears the Redis active VIP key.
 */
export async function revokeVip(userId: string, assignmentId: string): Promise<void> {
  const assignment = await vipAssignmentRepository.findById(assignmentId, userId)
  if (!assignment) throw new Error('Assignment not found')
  if (!assignment.isActive) throw new Error('Assignment is not active')

  await vipAssignmentRepository.revoke(assignmentId, userId)

  try {
    await redisClient.del(RedisKeys.userActiveVipId(userId))
  } catch (err) {
    console.error('[vip-assignment] Redis DEL failed on revoke', err)
  }
}

/**
 * Active rare-public-ID assignment: Redis fast path when present; otherwise DB (store purchases, legacy rows).
 */
export async function getActiveAssignment(userId: string): Promise<ActiveVipAssignment | null> {
  try {
    const raw = await redisClient.get(RedisKeys.userActiveVipId(userId))
    if (raw) {
      const publicId = BigInt(raw)
      const [meta, ttl] = await Promise.all([
        redisClient.hgetall(RedisKeys.vipMeta(publicId)),
        redisClient.ttl(RedisKeys.userActiveVipId(userId)),
      ])

      return {
        publicId,
        tier: (meta?.tier as VipTier) ?? VipTier.NONE,
        priceGroup: (meta?.priceGroup as PriceGroup) ?? PriceGroup.STANDARD,
        expiresAt: new Date(Date.now() + ttl * 1000),
        ttlSeconds: Math.max(0, ttl),
      }
    }
  } catch (redisErr) {
    console.warn('[vip-assignment] Redis unavailable, falling back to DB', redisErr)
    return getActiveAssignmentFromDb(userId)
  }
  return getActiveAssignmentFromDb(userId)
}

export const vipAssignmentService = {
  revokeVip,
  getActiveAssignment,
}

import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { vipAssignmentRepository } from '../repositories/vip-assignment.repository'
import { PriceGroup, VipTier } from './vip-classifier.service'
import type { UserVipAssignment } from '@prisma/client'

export interface AssignVipOptions {
  userId: string
  publicId: bigint
  durationMs: number
}

export interface ActiveVipAssignment {
  publicId: bigint
  tier: VipTier
  priceGroup: PriceGroup
  expiresAt: Date
  ttlSeconds: number
}

/**
 * Assigns a VIP public ID to a user (DB transaction + Redis TTL on active VIP key).
 */
export async function assignVip(options: AssignVipOptions): Promise<UserVipAssignment> {
  const vipRow = await prisma.vipPublicId.findUnique({ where: { publicId: options.publicId } })
  if (!vipRow) throw new Error('VIP ID not found')
  if (vipRow.assignedAt) throw new Error('VIP ID already assigned')

  const assignment = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM vip_public_ids WHERE public_id = ${options.publicId} FOR UPDATE`

    const locked = await tx.vipPublicId.findUnique({ where: { publicId: options.publicId } })
    if (locked?.assignedAt) throw new Error('VIP ID already assigned')

    await tx.vipPublicId.update({
      where: { publicId: options.publicId },
      data: { assignedAt: new Date() },
    })

    await tx.userVipAssignment.updateMany({
      where: { userId: options.userId, isActive: true },
      data: { isActive: false },
    })

    const startsAt = new Date()
    const expiresAt = new Date(startsAt.getTime() + options.durationMs)

    return tx.userVipAssignment.create({
      data: {
        userId: options.userId,
        publicId: options.publicId,
        startsAt,
        expiresAt,
      },
    })
  })

  try {
    const durationSeconds = Math.ceil(options.durationMs / 1000)
    const tier = vipRow.tier as VipTier

    const user = await prisma.user.findUnique({
      where: { id: options.userId },
      select: { originalPublicId: true },
    })

    const pipeline = redisClient.pipeline()
    pipeline.zrem(RedisKeys.vipPool(tier), String(options.publicId))
    pipeline.set(
      RedisKeys.userActiveVipId(options.userId),
      String(options.publicId),
      'EX',
      durationSeconds,
    )
    if (user?.originalPublicId != null) {
      pipeline.set(
        RedisKeys.userOriginalId(options.userId),
        String(user.originalPublicId),
        'NX',
      )
    }
    await pipeline.exec()
  } catch (err) {
    console.error('[vip-assignment] Redis write failed after DB assignment', err)
  }

  return assignment
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
 * Returns the user's active VIP assignment from Redis (hot path); falls back to DB if Redis is down.
 */
export async function getActiveAssignment(userId: string): Promise<ActiveVipAssignment | null> {
  try {
    const raw = await redisClient.get(RedisKeys.userActiveVipId(userId))
    if (!raw) return null

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
  } catch (redisErr) {
    console.warn('[vip-assignment] Redis unavailable, falling back to DB', redisErr)
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
}

export const vipAssignmentService = {
  assignVip,
  revokeVip,
  getActiveAssignment,
}

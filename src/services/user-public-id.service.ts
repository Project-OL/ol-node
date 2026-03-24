import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { vipAssignmentService, type ActiveVipAssignment } from './vip-assignment.service'

export interface PublicIdProfile {
  activePublicId: bigint
  originalPublicId: bigint
  isVip: boolean
  vipAssignment: ActiveVipAssignment | null
}

/**
 * Resolves the effective public ID for API use: active VIP if subscribed, else permanent base ID.
 */
async function getActivePublicId(userId: string): Promise<bigint> {
  try {
    const vipRaw = await redisClient.get(RedisKeys.userActiveVipId(userId))
    if (vipRaw) return BigInt(vipRaw)
  } catch {
    /* fall through */
  }

  try {
    const origRaw = await redisClient.get(RedisKeys.userOriginalId(userId))
    if (origRaw) return BigInt(origRaw)
  } catch {
    /* fall through */
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { originalPublicId: true },
  })
  if (!user?.originalPublicId) {
    throw new Error(`User ${userId} has no publicId`)
  }
  void redisClient
    .set(RedisKeys.userOriginalId(userId), String(user.originalPublicId), 'NX')
    .catch(() => {})
  return user.originalPublicId
}

/**
 * Full profile: active ID, original base ID, and optional VIP assignment metadata.
 */
async function getPublicIdProfile(userId: string): Promise<PublicIdProfile> {
  const [activePublicId, vipAssignment, originalRaw] = await Promise.all([
    getActivePublicId(userId),
    vipAssignmentService.getActiveAssignment(userId),
    redisClient.get(RedisKeys.userOriginalId(userId)).catch(() => null),
  ])

  let originalPublicId: bigint
  if (originalRaw) {
    originalPublicId = BigInt(originalRaw)
  } else {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { originalPublicId: true },
    })
    originalPublicId = user?.originalPublicId ?? activePublicId
  }

  return {
    activePublicId,
    originalPublicId,
    isVip: vipAssignment !== null,
    vipAssignment,
  }
}

/**
 * Persists the user's permanent base public ID (DB + Redis NX).
 */
async function setOriginalPublicId(userId: string, publicId: bigint): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { originalPublicId: publicId },
  })

  try {
    await redisClient.set(RedisKeys.userOriginalId(userId), String(publicId), 'NX')
  } catch (err) {
    console.warn('[user-public-id] Redis NX write failed for originalPublicId', err)
  }
}

export const userPublicIdService = {
  getActivePublicId,
  getPublicIdProfile,
  setOriginalPublicId,
}

import { prisma, prismaRead } from '../config/database'
import type { Guardian, GuardianTier, Prisma } from '@prisma/client'

export type GuardianUserCard = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  avatarUrl: string | null
  publicId: bigint
  country: string | null
  gender: string | null
  dateOfBirth: Date | null
}

export type GuardianWithTargetUser = Guardian & {
  targetUser: GuardianUserCard
}

export type GuardianWithGuardianUser = Guardian & {
  guardianUser: GuardianUserCard
}

const userCardSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  publicId: true,
  country: true,
  gender: true,
  dateOfBirth: true,
} satisfies Prisma.UserSelect

export type UpsertGuardianInput = {
  guardianUserId: string
  targetUserId: string
  tier: GuardianTier
  durationMonths: number
  coinsPaid: bigint
  expiresAt: Date
}

export const guardianRepository = {
  async upsertGuardian(
    data: UpsertGuardianInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Guardian> {
    const db = tx ?? prisma
    return db.guardian.upsert({
      where: {
        guardianUserId_targetUserId: {
          guardianUserId: data.guardianUserId,
          targetUserId: data.targetUserId,
        },
      },
      create: {
        guardianUserId: data.guardianUserId,
        targetUserId: data.targetUserId,
        tier: data.tier,
        durationMonths: data.durationMonths,
        coinsPaid: data.coinsPaid,
        expiresAt: data.expiresAt,
      },
      update: {
        tier: data.tier,
        durationMonths: data.durationMonths,
        coinsPaid: data.coinsPaid,
        expiresAt: data.expiresAt,
        isExpired: false,
        purchasedAt: new Date(),
      },
    })
  },

  async findActiveGuardiansForTarget(targetUserId: string): Promise<Guardian[]> {
    return prismaRead.guardian.findMany({
      where: {
        targetUserId,
        isExpired: false,
        expiresAt: { gt: new Date() },
      },
    })
  },

  async findActiveByTargetIds(targetUserIds: string[]): Promise<Guardian[]> {
    if (targetUserIds.length === 0) return []
    return prismaRead.guardian.findMany({
      where: {
        targetUserId: { in: targetUserIds },
        isExpired: false,
        expiresAt: { gt: new Date() },
      },
    })
  },

  async findById(id: string): Promise<Guardian | null> {
    return prismaRead.guardian.findUnique({ where: { id } })
  },

  async markExpired(id: string): Promise<void> {
    await prisma.guardian.updateMany({
      where: { id, isExpired: false },
      data: { isExpired: true },
    })
  },

  async findMyGuardians(guardianUserId: string): Promise<GuardianWithTargetUser[]> {
    return prismaRead.guardian.findMany({
      where: {
        guardianUserId,
        isExpired: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: 'desc' },
      include: {
        targetUser: { select: userCardSelect },
      },
    })
  },

  async findGuardiansOfMe(targetUserId: string): Promise<GuardianWithGuardianUser[]> {
    return prismaRead.guardian.findMany({
      where: {
        targetUserId,
        isExpired: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: 'desc' },
      include: {
        guardianUser: { select: userCardSelect },
      },
    })
  },
}

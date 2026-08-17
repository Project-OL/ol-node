import type { FaceProfileStatus, FaceVerificationDecision, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

function getDb(tx?: Prisma.TransactionClient) {
  return tx ?? prisma
}

export const faceVerificationRepository = {
  getProfileByUserId(userId: string) {
    return prismaRead.userFaceProfile.findUnique({ where: { userId } })
  },

  /** Indexed face profile or agency KYC `face_verified` (same gate as host leave / agency dashboard). */
  async isVerifiedForUser(userId: string): Promise<boolean> {
    const state = await this.getMeFaceState(userId)
    return state.faceVerified
  },

  /** `/users/me` face block: verified flag plus status so clients can re-register without logging out. */
  async getMeFaceState(userId: string): Promise<{
    faceVerified: boolean
    faceStatus: string
    faceCanReRegister: boolean
  }> {
    const [kyc, profile] = await Promise.all([
      prismaRead.agencyApplicationKyc.findUnique({
        where: { userId },
        select: { faceVerified: true },
      }),
      prismaRead.userFaceProfile.findUnique({
        where: { userId },
        select: { status: true },
      }),
    ])
    const faceStatus = profile?.status ?? 'NONE'
    return {
      faceVerified: Boolean(kyc?.faceVerified) || profile?.status === 'INDEXED',
      faceStatus,
      faceCanReRegister: faceStatus === 'REVOKED' || faceStatus === 'FAILED',
    }
  },

  /**
   * Strict Rekognition gate: profile must be INDEXED with a face id and reference image.
   * Does not accept KYC `face_verified` alone (unlike `isVerifiedForUser`).
   */
  async isIndexedForUser(userId: string): Promise<boolean> {
    const profile = await prismaRead.userFaceProfile.findUnique({
      where: { userId },
      select: { status: true, rekognitionFaceId: true, s3KeyReference: true },
    })
    return (
      profile?.status === 'INDEXED' &&
      Boolean(profile.rekognitionFaceId?.trim()) &&
      Boolean(profile.s3KeyReference?.trim())
    )
  },

  createPendingProfile(
    input: {
      userId: string
      collectionId: string
      s3KeyReference: string
      qualityScore?: number | null
      /** Set when registration used Amazon Face Liveness (GetFaceLivenessSessionResults confidence). */
      livenessConfidence?: number | null
      qualityChecksPassed?: Prisma.InputJsonValue | null
      detectedGender?: string | null
      genderUpdatedAt?: Date | null
      moderationLabels?: Prisma.InputJsonValue | null
      faceMatchSimilarity?: number | null
      matchedUserId?: string | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = getDb(tx)
    return db.userFaceProfile.upsert({
      where: { userId: input.userId },
      update: {
        collectionId: input.collectionId,
        s3KeyReference: input.s3KeyReference,
        imageQualityScore: input.qualityScore ?? null,
        livenessConfidence: input.livenessConfidence ?? null,
        qualityChecksPassed: input.qualityChecksPassed ?? undefined,
        detectedGender: input.detectedGender ?? undefined,
        genderUpdatedAt: input.genderUpdatedAt ?? undefined,
        moderationLabels: input.moderationLabels ?? undefined,
        faceMatchSimilarity: input.faceMatchSimilarity ?? undefined,
        matchedUserId: input.matchedUserId ?? undefined,
        status: 'PENDING_INDEX',
        rekognitionFaceId: null,
        failureReason: null,
        revokedAt: null,
        indexedAt: null,
      },
      create: {
        userId: input.userId,
        collectionId: input.collectionId,
        s3KeyReference: input.s3KeyReference,
        imageQualityScore: input.qualityScore ?? null,
        livenessConfidence: input.livenessConfidence ?? null,
        qualityChecksPassed: input.qualityChecksPassed ?? undefined,
        detectedGender: input.detectedGender ?? undefined,
        genderUpdatedAt: input.genderUpdatedAt ?? undefined,
        moderationLabels: input.moderationLabels ?? undefined,
        faceMatchSimilarity: input.faceMatchSimilarity ?? undefined,
        matchedUserId: input.matchedUserId ?? undefined,
        status: 'PENDING_INDEX',
      },
    })
  },

  findProfileByRekognitionFaceId(faceId: string) {
    return prismaRead.userFaceProfile.findFirst({
      where: { rekognitionFaceId: faceId, status: 'INDEXED' },
      select: { userId: true },
    })
  },

  findProfileByRekognitionFaceIdAnyStatus(faceId: string) {
    return prismaRead.userFaceProfile.findFirst({
      where: { rekognitionFaceId: faceId },
    })
  },

  findProfilesByRekognitionFaceIds(faceIds: string[]) {
    if (faceIds.length === 0) return Promise.resolve([])
    return prismaRead.userFaceProfile.findMany({
      where: { rekognitionFaceId: { in: faceIds } },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            currentVipPublicId: true,
          },
        },
      },
    })
  },

  findProfilesByUserIds(userIds: string[]) {
    if (userIds.length === 0) return Promise.resolve([])
    return prismaRead.userFaceProfile.findMany({
      where: { userId: { in: userIds } },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            currentVipPublicId: true,
          },
        },
        matchedUser: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    })
  },

  findRelatedProfiles(ownerUserId: string) {
    return prismaRead.userFaceProfile.findMany({
      where: {
        status: { not: 'REVOKED' },
        OR: [{ matchedUserId: ownerUserId }, { duplicateOfUserId: ownerUserId }],
        userId: { not: ownerUserId },
      },
      select: { userId: true, status: true },
    })
  },

  async listProfilesForAdmin(input: {
    page: number
    limit: number
    status?: FaceProfileStatus
    includeRevoked?: boolean
  }) {
    const where: Prisma.UserFaceProfileWhereInput = {}
    if (input.status) {
      where.status = input.status
    } else if (!input.includeRevoked) {
      where.status = { not: 'REVOKED' }
    }

    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      prismaRead.userFaceProfile.findMany({
        where,
        skip,
        take: input.limit,
        orderBy: { updatedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              publicId: true,
              currentVipPublicId: true,
            },
          },
          matchedUser: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      prismaRead.userFaceProfile.count({ where }),
    ])

    return { items, total, page: input.page, limit: input.limit }
  },

  countProfilesByStatus() {
    return prismaRead.userFaceProfile.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
  },

  markDuplicate(
    input: {
      userId: string
      collectionId: string
      s3KeyReference: string
      qualityScore?: number | null
      duplicateOfUserId: string | null
      faceMatchSimilarity?: number | null
      moderationLabels?: Prisma.InputJsonValue | null
      qualityChecksPassed?: Prisma.InputJsonValue | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    return getDb(tx).userFaceProfile.upsert({
      where: { userId: input.userId },
      update: {
        collectionId: input.collectionId,
        s3KeyReference: input.s3KeyReference,
        imageQualityScore: input.qualityScore ?? null,
        status: 'DUPLICATE_FACE',
        duplicateOfUserId: input.duplicateOfUserId,
        matchedUserId: input.duplicateOfUserId,
        faceMatchSimilarity: input.faceMatchSimilarity ?? null,
        moderationLabels: input.moderationLabels ?? undefined,
        qualityChecksPassed: input.qualityChecksPassed ?? undefined,
        rekognitionFaceId: null,
        failureReason: 'duplicate_face',
      } as any,
      create: {
        userId: input.userId,
        collectionId: input.collectionId,
        s3KeyReference: input.s3KeyReference,
        imageQualityScore: input.qualityScore ?? null,
        status: 'DUPLICATE_FACE',
        duplicateOfUserId: input.duplicateOfUserId,
        matchedUserId: input.duplicateOfUserId,
        faceMatchSimilarity: input.faceMatchSimilarity ?? null,
        moderationLabels: input.moderationLabels ?? undefined,
        qualityChecksPassed: input.qualityChecksPassed ?? undefined,
      } as any,
    })
  },

  markProfileIndexed(
    input: { userId: string; rekognitionFaceId: string },
    tx?: Prisma.TransactionClient,
  ) {
    return getDb(tx).userFaceProfile.update({
      where: { userId: input.userId },
      data: {
        status: 'INDEXED',
        rekognitionFaceId: input.rekognitionFaceId,
        indexedAt: new Date(),
        failureReason: null,
      },
    })
  },

  markProfileFailed(input: { userId: string; reason: string }, tx?: Prisma.TransactionClient) {
    return getDb(tx).userFaceProfile.update({
      where: { userId: input.userId },
      data: { status: 'FAILED', failureReason: input.reason },
    })
  },

  revokeProfile(input: { userId: string }, tx?: Prisma.TransactionClient) {
    return getDb(tx).userFaceProfile.update({
      where: { userId: input.userId },
      data: {
        status: 'REVOKED',
        rekognitionFaceId: null,
        revokedAt: new Date(),
        duplicateOfUserId: null,
        matchedUserId: null,
        faceMatchSimilarity: null,
        failureReason: null,
      },
    })
  },

  /** Clears DUPLICATE_FACE block so the user may start a new registration. */
  clearDuplicateBlock(input: { userId: string }, tx?: Prisma.TransactionClient) {
    return getDb(tx).userFaceProfile.update({
      where: { userId: input.userId },
      data: {
        status: 'REVOKED',
        rekognitionFaceId: null,
        revokedAt: new Date(),
        duplicateOfUserId: null,
        matchedUserId: null,
        faceMatchSimilarity: null,
        failureReason: null,
      },
    })
  },

  touchLastVerifiedAt(userId: string, tx?: Prisma.TransactionClient) {
    return getDb(tx).userFaceProfile.update({
      where: { userId },
      data: { lastVerifiedAt: new Date() },
    })
  },

  async recordAttempt(
    input: {
      userId: string
      s3Key: string
      decision: FaceVerificationDecision
      similarityScore?: number
      reason?: string
      rekognitionRequestId?: string
      latencyMs: number
      ipAddress?: string
      userAgent?: string
      clientRequestId?: string
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = getDb(tx)
    if (input.clientRequestId) {
      return db.faceVerificationAttempt.upsert({
        where: {
          userId_clientRequestId: {
            userId: input.userId,
            clientRequestId: input.clientRequestId,
          },
        },
        update: {},
        create: {
          userId: input.userId,
          s3Key: input.s3Key,
          decision: input.decision,
          similarityScore: input.similarityScore,
          reason: input.reason,
          rekognitionRequestId: input.rekognitionRequestId,
          latencyMs: input.latencyMs,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          clientRequestId: input.clientRequestId,
        },
      })
    }
    return db.faceVerificationAttempt.create({
      data: {
        userId: input.userId,
        s3Key: input.s3Key,
        decision: input.decision,
        similarityScore: input.similarityScore,
        reason: input.reason,
        rekognitionRequestId: input.rekognitionRequestId,
        latencyMs: input.latencyMs,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    })
  },

  countAttemptsInWindow(input: { userId: string; sinceMs: number }) {
    const since = new Date(Date.now() - input.sinceMs)
    return prismaRead.faceVerificationAttempt.count({
      where: { userId: input.userId, createdAt: { gte: since } },
    })
  },

  findRecentSuccessful(input: { userId: string; withinMs: number }) {
    const since = new Date(Date.now() - input.withinMs)
    return prismaRead.faceVerificationAttempt.findFirst({
      where: {
        userId: input.userId,
        decision: 'PASS',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  createRevocationRecord(
    input: {
      userId: string
      faceProfileId?: string | null
      revokedByUserId?: string | null
      revokedByAdminId?: string | null
      revokeReason?: string | null
      rekognitionFaceId?: string | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    return getDb(tx).faceProfileRevocation.create({
      data: {
        userId: input.userId,
        faceProfileId: input.faceProfileId ?? undefined,
        revokedByUserId: input.revokedByUserId ?? undefined,
        revokedByAdminId: input.revokedByAdminId ?? undefined,
        revokeReason: input.revokeReason ?? undefined,
        rekognitionFaceId: input.rekognitionFaceId ?? undefined,
      },
    })
  },
}

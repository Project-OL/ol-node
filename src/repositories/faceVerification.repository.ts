import type { FaceVerificationDecision, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

function getDb(tx?: Prisma.TransactionClient) {
  return tx ?? prisma
}

export const faceVerificationRepository = {
  getProfileByUserId(userId: string) {
    return prismaRead.userFaceProfile.findUnique({ where: { userId } })
  },

  createPendingProfile(
    input: {
      userId: string
      collectionId: string
      s3KeyReference: string
      qualityScore?: number | null
      /** Set when registration used Amazon Face Liveness (GetFaceLivenessSessionResults confidence). */
      livenessConfidence?: number | null
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

  markDuplicate(
    input: {
      userId: string
      collectionId: string
      s3KeyReference: string
      qualityScore?: number | null
      duplicateOfUserId: string | null
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
}

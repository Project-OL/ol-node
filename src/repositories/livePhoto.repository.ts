import type { LivePhotoVerificationState, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type UserLivePhotoRow = NonNullable<
  Awaited<ReturnType<typeof livePhotoRepository.findByUserId>>
>

export const livePhotoRepository = {
  findByUserId(userId: string) {
    return prismaRead.userLivePhoto.findUnique({ where: { userId } })
  },

  async upsertPendingUpload(
    userId: string,
    data: { s3Key: string; s3Bucket: string; verificationState: LivePhotoVerificationState },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma
    return db.userLivePhoto.upsert({
      where: { userId },
      create: {
        userId,
        s3Key: data.s3Key,
        s3Bucket: data.s3Bucket,
        verificationState: data.verificationState,
      },
      update: {
        s3Key: data.s3Key,
        s3Bucket: data.s3Bucket,
        verificationState: data.verificationState,
        imageUrl: null,
        similarityScore: null,
        verifiedAt: null,
        failedReason: null,
        faceProfileId: null,
        verifyGeneration: 0,
      },
    })
  },

  /**
   * Transition PENDING_UPLOAD → PROCESSING and bump generation. Returns updated row or null if no match.
   */
  async tryBeginProcessing(userId: string, s3Key: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? prisma
    const updated = await db.userLivePhoto.updateMany({
      where: {
        userId,
        s3Key,
        verificationState: 'PENDING_UPLOAD',
      },
      data: {
        verificationState: 'PROCESSING',
        verifyGeneration: { increment: 1 },
      },
    })
    if (updated.count === 0) return null
    return db.userLivePhoto.findUniqueOrThrow({ where: { userId } })
  },

  async markVerified(
    userId: string,
    data: {
      imageUrl: string
      similarityScore: number
      faceProfileId: string
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma
    return db.userLivePhoto.update({
      where: { userId },
      data: {
        verificationState: 'VERIFIED',
        similarityScore: data.similarityScore,
        verifiedAt: new Date(),
        imageUrl: data.imageUrl,
        faceProfileId: data.faceProfileId,
        failedReason: null,
      },
    })
  },

  async markFailed(userId: string, reason: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? prisma
    return db.userLivePhoto.update({
      where: { userId },
      data: {
        verificationState: 'FAILED',
        failedReason: reason.slice(0, 2000),
        similarityScore: null,
        verifiedAt: null,
        imageUrl: null,
        faceProfileId: null,
      },
    })
  },

  async softReset(userId: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? prisma
    return db.userLivePhoto.updateMany({
      where: { userId },
      data: {
        verificationState: 'NOT_UPLOADED',
        s3Key: '',
        s3Bucket: '',
        imageUrl: null,
        similarityScore: null,
        verifiedAt: null,
        failedReason: null,
        faceProfileId: null,
        verifyGeneration: 0,
      },
    })
  },

  async createAttempt(
    data: {
      userId: string
      livePhotoId: string
      similarityScore: number | null
      matched: boolean
      rekognitionRequestId: string | null
      failureReason: string | null
      metadata?: Prisma.InputJsonValue
      processingLatencyMs: number
      rekognitionLatencyMs: number | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma
    return db.livePhotoVerificationAttempt.create({
      data: {
        userId: data.userId,
        livePhotoId: data.livePhotoId,
        similarityScore: data.similarityScore,
        matched: data.matched,
        rekognitionRequestId: data.rekognitionRequestId,
        failureReason: data.failureReason,
        metadata: data.metadata,
        processingLatencyMs: data.processingLatencyMs,
        rekognitionLatencyMs: data.rekognitionLatencyMs,
      },
    })
  },

  async deleteRow(userId: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? prisma
    return db.userLivePhoto.deleteMany({ where: { userId } })
  },
}

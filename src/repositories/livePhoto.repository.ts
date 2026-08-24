import type { LivePhotoVerificationState, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type UserLivePhotoRow = NonNullable<
  Awaited<ReturnType<typeof livePhotoRepository.findByUserId>>
>

export const livePhotoRepository = {
  findByUserId(userId: string) {
    return prismaRead.userLivePhoto.findUnique({ where: { userId } })
  },

  findLatestAttempt(livePhotoId: string) {
    return prismaRead.livePhotoVerificationAttempt.findFirst({
      where: { livePhotoId },
      orderBy: { createdAt: 'desc' },
    })
  },

  /** First upload / retry after fail — clears verified fields and any prior pending replace. */
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
        pendingS3Key: null,
        pendingS3Bucket: null,
        replaceFailedReason: null,
        verifyGeneration: 0,
      },
    })
  },

  /**
   * Start/replace a pending upload while keeping the current verified photo visible.
   * Sets state to PENDING_VERIFICATION; does not touch s3Key / imageUrl / verifiedAt.
   */
  async setPendingReplace(
    userId: string,
    data: { pendingS3Key: string; pendingS3Bucket: string },
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma
    return db.userLivePhoto.update({
      where: { userId },
      data: {
        pendingS3Key: data.pendingS3Key,
        pendingS3Bucket: data.pendingS3Bucket,
        verificationState: 'PENDING_VERIFICATION',
        replaceFailedReason: null,
        failedReason: null,
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

  /**
   * Transition PENDING_VERIFICATION → PROCESSING for a replace key. Keeps verified fields.
   */
  async tryBeginReplaceProcessing(
    userId: string,
    pendingS3Key: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? prisma
    const updated = await db.userLivePhoto.updateMany({
      where: {
        userId,
        pendingS3Key,
        verificationState: 'PENDING_VERIFICATION',
      },
      data: {
        verificationState: 'PROCESSING',
        verifyGeneration: { increment: 1 },
      },
    })
    if (updated.count === 0) return null
    return db.userLivePhoto.findUniqueOrThrow({ where: { userId } })
  },

  /**
   * Promote `verifiedS3Key` to the live photo. Clears pending. Returns previous verified key to purge when replacing.
   */
  async completeVerification(
    userId: string,
    data: {
      imageUrl: string
      similarityScore: number
      faceProfileId: string
      verifiedS3Key: string
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ previousS3KeyToPurge: string | null }> {
    const db = tx ?? prisma
    const row = await db.userLivePhoto.findUniqueOrThrow({ where: { userId } })
    const isReplace = row.pendingS3Key === data.verifiedS3Key
    const previousS3KeyToPurge =
      isReplace && row.s3Key.trim() && row.s3Key !== data.verifiedS3Key ? row.s3Key.trim() : null
    const bucket = isReplace ? row.pendingS3Bucket?.trim() || row.s3Bucket : row.s3Bucket

    await db.userLivePhoto.update({
      where: { userId },
      data: {
        s3Key: data.verifiedS3Key,
        s3Bucket: bucket,
        pendingS3Key: null,
        pendingS3Bucket: null,
        verificationState: 'VERIFIED',
        similarityScore: data.similarityScore,
        verifiedAt: new Date(),
        imageUrl: data.imageUrl,
        faceProfileId: data.faceProfileId,
        failedReason: null,
        replaceFailedReason: null,
      },
    })
    return { previousS3KeyToPurge }
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
        pendingS3Key: null,
        pendingS3Bucket: null,
        replaceFailedReason: null,
      },
    })
  },

  /** First-upload moderation reject (content policy / nudity). */
  async markRejected(userId: string, reason: string, tx?: Prisma.TransactionClient) {
    const db = tx ?? prisma
    return db.userLivePhoto.update({
      where: { userId },
      data: {
        verificationState: 'REJECTED',
        failedReason: reason.slice(0, 2000),
        similarityScore: null,
        verifiedAt: null,
        imageUrl: null,
        faceProfileId: null,
        pendingS3Key: null,
        pendingS3Bucket: null,
        replaceFailedReason: null,
      },
    })
  },

  /**
   * Replace verify failed — keep previous verified photo; clear pending; record replaceFailedReason.
   * Returns the abandoned pending key for S3 purge.
   */
  async abortReplace(
    userId: string,
    reason: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ pendingKeyToPurge: string | null }> {
    const db = tx ?? prisma
    const row = await db.userLivePhoto.findUniqueOrThrow({ where: { userId } })
    const pendingKeyToPurge = row.pendingS3Key?.trim() || null
    await db.userLivePhoto.update({
      where: { userId },
      data: {
        verificationState: 'VERIFIED',
        pendingS3Key: null,
        pendingS3Bucket: null,
        replaceFailedReason: reason.slice(0, 2000),
      },
    })
    return { pendingKeyToPurge }
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
        pendingS3Key: null,
        pendingS3Bucket: null,
        replaceFailedReason: null,
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

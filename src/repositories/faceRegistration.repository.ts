import type { FaceRegistrationSessionStatus, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

function getDb(tx?: Prisma.TransactionClient) {
  return tx ?? prisma
}

export type CreateFaceRegistrationSessionInput = {
  userId: string
  awsSessionId: string
  challengeSequence: Prisma.InputJsonValue
  challengeNonce: string
  uploadNonce: string
  riskScore: number
  deviceMetadata?: Prisma.InputJsonValue | null
  ipAddress?: string | null
  expiresAt: Date
}

export const faceRegistrationRepository = {
  findById(id: string) {
    return prismaRead.faceRegistrationSession.findUnique({ where: { id } })
  },

  findByIdForUser(id: string, userId: string) {
    return prismaRead.faceRegistrationSession.findFirst({
      where: { id, userId },
    })
  },

  async expireOpenSessionsForUser(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = getDb(tx)
    await db.faceRegistrationSession.updateMany({
      where: {
        userId,
        status: { in: ['PENDING', 'UPLOADED', 'PROCESSING'] },
      },
      data: { status: 'EXPIRED', failureReason: 'superseded_by_new_session' },
    })
  },

  createSession(input: CreateFaceRegistrationSessionInput, tx?: Prisma.TransactionClient) {
    const db = getDb(tx)
    return db.faceRegistrationSession.create({
      data: {
        userId: input.userId,
        status: 'PENDING',
        awsSessionId: input.awsSessionId,
        challengeSequence: input.challengeSequence,
        challengeNonce: input.challengeNonce,
        uploadNonce: input.uploadNonce,
        riskScore: input.riskScore,
        deviceMetadata: input.deviceMetadata ?? undefined,
        ipAddress: input.ipAddress ?? undefined,
        expiresAt: input.expiresAt,
      },
    })
  },

  updateSession(
    id: string,
    data: {
      status?: FaceRegistrationSessionStatus
      supplementalVideoS3Key?: string | null
      failureReason?: string | null
      livenessConfidence?: number | null
      rekognitionRawStatus?: string | null
      idempotencyKey?: string | null
      awsRequestId?: string | null
      verifiedAt?: Date | null
      indexedAt?: Date | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = getDb(tx)
    return db.faceRegistrationSession.update({
      where: { id },
      data: {
        ...data,
      },
    })
  },

  appendAudit(
    input: {
      sessionId: string
      userId: string
      action: string
      details?: Prisma.InputJsonValue | null
      ipAddress?: string | null
      userAgent?: string | null
      latencyMs?: number | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    const db = getDb(tx)
    return db.faceRegistrationAuditLog.create({
      data: {
        sessionId: input.sessionId,
        userId: input.userId,
        action: input.action,
        details: input.details ?? undefined,
        ipAddress: input.ipAddress ?? undefined,
        userAgent: input.userAgent ?? undefined,
        latencyMs: input.latencyMs ?? undefined,
      },
    })
  },

  /** Mark latest INDEX_PENDING session as INDEXED after Rekognition collection indexing completes. */
  async markLatestIndexPendingAsIndexed(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const db = getDb(tx)
    const row = await db.faceRegistrationSession.findFirst({
      where: { userId, status: 'INDEX_PENDING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (!row) return null
    await db.faceRegistrationSession.update({
      where: { id: row.id },
      data: { status: 'INDEXED', indexedAt: new Date() },
    })
    return row.id
  },
}

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

  /** Most recent registration attempt for a user, regardless of status — used to
   * detect an in-flight or recently-failed attempt that a stale/missing
   * UserFaceProfile row wouldn't otherwise reflect. */
  findLatestForUser(userId: string) {
    return prismaRead.faceRegistrationSession.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
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

  /** Every non-terminal session for a user (open early-stage attempts plus ones that
   * hung after passing liveness or during indexing — a worker outage or a client that
   * never called /verify can leave one of these stuck indefinitely). */
  findOpenSessionsForUser(userId: string, tx?: Prisma.TransactionClient) {
    const db = getDb(tx)
    return db.faceRegistrationSession.findMany({
      where: {
        userId,
        status: { in: ['PENDING', 'UPLOADED', 'PROCESSING', 'LIVENESS_PASSED', 'INDEX_PENDING'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        awsSessionId: true,
        riskScore: true,
        failureReason: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  },

  /** Paginated, admin-facing view of every non-terminal session across all users (or one,
   * via `userId`) older than `minAgeSec` — the "stuck registrations" worklist. */
  async listStuckSessions(input: {
    minAgeSec: number
    page: number
    limit: number
    userId?: string
  }): Promise<{
    items: Array<{
      id: string
      status: FaceRegistrationSessionStatus
      awsSessionId: string | null
      riskScore: number
      createdAt: Date
      updatedAt: Date
      user: {
        id: string
        username: string | null
        firstName: string | null
        lastName: string | null
        publicId: bigint | null
        currentVipPublicId: bigint | null
      }
    }>
    total: number
  }> {
    const where: Prisma.FaceRegistrationSessionWhereInput = {
      status: { in: ['PENDING', 'UPLOADED', 'PROCESSING', 'LIVENESS_PASSED', 'INDEX_PENDING'] },
      createdAt: { lte: new Date(Date.now() - input.minAgeSec * 1000) },
      ...(input.userId ? { userId: input.userId } : {}),
    }
    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      prismaRead.faceRegistrationSession.findMany({
        where,
        skip,
        take: input.limit,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          awsSessionId: true,
          riskScore: true,
          createdAt: true,
          updatedAt: true,
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
      }),
      prismaRead.faceRegistrationSession.count({ where }),
    ])
    return { items, total }
  },

  /** Admin-forced terminal EXPIRED on every non-terminal session for a user, so
   * `GET /face-verification/me` stops preferring a hung session over the profile and
   * the client's `expireOpenSessionsForUser` re-registration path is unblocked. */
  async clearStuckSessionsForUser(
    userId: string,
    failureReason: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const db = getDb(tx)
    const open = await this.findOpenSessionsForUser(userId, tx)
    if (open.length === 0) return []
    await db.faceRegistrationSession.updateMany({
      where: { id: { in: open.map((s) => s.id) } },
      data: { status: 'EXPIRED', failureReason },
    })
    return open.map((s) => s.id)
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
      qualityCheckFailures?: string[]
      detectedGender?: string | null
      genderAutoUpdated?: boolean | null
      duplicateMatchUserId?: string | null
      contentPolicyViolation?: boolean | null
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
        qualityCheckFailures: input.qualityCheckFailures ?? [],
        detectedGender: input.detectedGender ?? undefined,
        genderAutoUpdated: input.genderAutoUpdated ?? undefined,
        duplicateMatchUserId: input.duplicateMatchUserId ?? undefined,
        contentPolicyViolation: input.contentPolicyViolation ?? undefined,
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

import { Prisma } from '@prisma/client'
import type { FaceRegistrationSessionStatus } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

/** A user's most-recent registration attempt landed here -> still needs admin
 * attention (hung, or ended in a failure the user hasn't successfully retried
 * past yet). Excludes EXPIRED (cleanly superseded by the user's own retry) and
 * INDEXED (succeeded). */
export const ATTENTION_NEEDED_STATUSES: FaceRegistrationSessionStatus[] = [
  'PENDING',
  'UPLOADED',
  'PROCESSING',
  'LIVENESS_PASSED',
  'INDEX_PENDING',
  'LIVENESS_FAILED',
  'VALIDATION_FAILED',
  'REJECTED',
]

export type AttentionNeededSessionRow = {
  id: string
  status: FaceRegistrationSessionStatus
  aws_session_id: string | null
  risk_score: number
  failure_reason: string | null
  created_at: Date
  updated_at: Date
  user_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  public_id: bigint
  current_vip_public_id: bigint | null
}

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

  /**
   * Paginated, admin-facing worklist of users whose MOST RECENT registration
   * attempt still needs attention — either hung (non-terminal) or ended in a
   * failure they haven't successfully retried past (LIVENESS_FAILED/
   * VALIDATION_FAILED/REJECTED). A user whose latest session is EXPIRED
   * (cleanly superseded by their own retry) or INDEXED (succeeded) never
   * appears here, even if an OLDER session of theirs once failed — only the
   * latest attempt per user is considered. Requires `DISTINCT ON` (per-user
   * latest row), which Prisma's query builder can't express, hence raw SQL.
   */
  async listStuckSessions(input: {
    minAgeSec: number
    page: number
    limit: number
    userId?: string
  }): Promise<{ items: AttentionNeededSessionRow[]; total: number }> {
    const cutoff = new Date(Date.now() - input.minAgeSec * 1000)
    const skip = (input.page - 1) * input.limit
    const statusList = Prisma.join(
      ATTENTION_NEEDED_STATUSES.map((s) => Prisma.sql`${s}::"FaceRegistrationSessionStatus"`),
    )
    const userFilter = input.userId
      ? Prisma.sql`AND ls.user_id = ${input.userId}::uuid`
      : Prisma.empty

    const [items, totalRows] = await Promise.all([
      prismaRead.$queryRaw<AttentionNeededSessionRow[]>(Prisma.sql`
        WITH latest_sessions AS (
          SELECT DISTINCT ON (user_id) *
          FROM face_registration_sessions
          ORDER BY user_id, created_at DESC
        )
        SELECT
          ls.id, ls.status, ls.aws_session_id, ls.risk_score, ls.failure_reason,
          ls.created_at, ls.updated_at, ls.user_id,
          u.username, u.first_name, u.last_name, u.public_id, u.current_vip_public_id
        FROM latest_sessions ls
        JOIN users u ON u.id = ls.user_id
        WHERE ls.status IN (${statusList})
          AND ls.created_at <= ${cutoff}
          ${userFilter}
        ORDER BY ls.created_at ASC
        LIMIT ${input.limit} OFFSET ${skip}
      `),
      prismaRead.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        WITH latest_sessions AS (
          SELECT DISTINCT ON (user_id) *
          FROM face_registration_sessions
          ORDER BY user_id, created_at DESC
        )
        SELECT COUNT(*)::bigint AS count
        FROM latest_sessions ls
        WHERE ls.status IN (${statusList})
          AND ls.created_at <= ${cutoff}
          ${userFilter}
      `),
    ])
    return { items, total: Number(totalRows[0]?.count ?? 0n) }
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

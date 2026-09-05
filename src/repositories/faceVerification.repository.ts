import type { FaceProfileStatus, FaceVerificationDecision, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

function getDb(tx?: Prisma.TransactionClient) {
  return tx ?? prisma
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  /**
   * Paired duplicate-face cases for admin review: each blocked (`DUPLICATE_FACE`) profile plus
   * the owner's own `UserFaceProfile` row (for their image/status), so a single view can render
   * both sides of the match without a separate "flagged pairs" table.
   */
  /**
   * Users matching a free-text admin search — exact user id / public id, or a
   * partial match on public id, username or name. Capped because the ids feed an
   * `in` filter on the duplicate worklist.
   */
  async findUserIdsBySearch(search: string, take = 500): Promise<string[]> {
    const q = search.trim()
    if (!q) return []
    const or: Prisma.UserWhereInput[] = [
      { username: { contains: q, mode: 'insensitive' } },
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
    ]
    if (UUID_RE.test(q)) or.push({ id: q })
    // publicId / currentVipPublicId are BigInt columns — exact match only.
    if (/^\d{1,18}$/.test(q)) {
      const publicId = BigInt(q)
      or.push({ publicId }, { currentVipPublicId: publicId })
    }
    const spaceIdx = q.indexOf(' ')
    // "Jane Doe" → firstName contains Jane AND lastName contains Doe.
    if (spaceIdx > 0) {
      const first = q.slice(0, spaceIdx).trim()
      const last = q.slice(spaceIdx + 1).trim()
      if (first && last) {
        or.push({
          AND: [
            { firstName: { contains: first, mode: 'insensitive' } },
            { lastName: { contains: last, mode: 'insensitive' } },
          ],
        })
      }
    }
    const rows = await prismaRead.user.findMany({
      where: { OR: or },
      select: { id: true },
      take,
    })
    return rows.map((r) => r.id)
  },

  /**
   * `search` matches either side of the pair (blocked user or matched owner), so
   * searching an owner surfaces every duplicate case pointing at them. Rows sent
   * to the bottom by an admin (`adminSortWeight` > 0) sort after everything else.
   */
  async listDuplicatePairsForAdmin(input: { page: number; limit: number; search?: string }) {
    const userSelect = {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      publicId: true,
      currentVipPublicId: true,
    } as const

    let where: Prisma.UserFaceProfileWhereInput = { status: 'DUPLICATE_FACE' }
    const search = input.search?.trim()
    if (search) {
      const matchedUserIds = await this.findUserIdsBySearch(search)
      if (matchedUserIds.length === 0) {
        return { items: [], total: 0, page: input.page, limit: input.limit }
      }
      where = {
        ...where,
        OR: [{ userId: { in: matchedUserIds } }, { matchedUserId: { in: matchedUserIds } }],
      }
    }

    const skip = (input.page - 1) * input.limit
    const [blocked, total] = await Promise.all([
      prismaRead.userFaceProfile.findMany({
        where,
        skip,
        take: input.limit,
        orderBy: [{ adminSortWeight: 'asc' }, { updatedAt: 'desc' }],
        include: { user: { select: userSelect } },
      }),
      prismaRead.userFaceProfile.count({ where }),
    ])

    const ownerIds = [
      ...new Set(blocked.map((p) => p.matchedUserId).filter((id): id is string => Boolean(id))),
    ]
    const ownerProfiles = ownerIds.length
      ? await prismaRead.userFaceProfile.findMany({
          where: { userId: { in: ownerIds } },
          include: { user: { select: userSelect } },
        })
      : []
    const ownerByUserId = new Map(ownerProfiles.map((p) => [p.userId, p]))

    return {
      items: blocked.map((profile) => ({
        blocked: profile,
        owner: profile.matchedUserId ? (ownerByUserId.get(profile.matchedUserId) ?? null) : null,
      })),
      total,
      page: input.page,
      limit: input.limit,
    }
  },

  /**
   * Park a duplicate case at the bottom of the admin worklist: one past the
   * heaviest weight currently in the queue, so repeated calls keep their
   * relative order instead of collapsing into one bucket.
   */
  async sendDuplicateToBottom(userId: string) {
    const heaviest = await prismaRead.userFaceProfile.findFirst({
      where: { status: 'DUPLICATE_FACE' },
      orderBy: { adminSortWeight: 'desc' },
      select: { adminSortWeight: true },
    })
    return prisma.userFaceProfile.update({
      where: { userId },
      data: { adminSortWeight: (heaviest?.adminSortWeight ?? 0) + 1 },
      select: { userId: true, adminSortWeight: true },
    })
  },

  /** Undo `sendDuplicateToBottom` — back to the default newest-first position. */
  restoreDuplicateOrder(userId: string) {
    return prisma.userFaceProfile.update({
      where: { userId },
      data: { adminSortWeight: 0 },
      select: { userId: true, adminSortWeight: true },
    })
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

  /**
   * Admin override: index a DUPLICATE_FACE profile anyway ("accept both accounts"). Unlike
   * `markProfileIndexed`, this also clears the duplicate-linkage fields so an accepted profile
   * doesn't keep stale `duplicateOfUserId`/`matchedUserId`/`faceMatchSimilarity` around.
   */
  acceptDuplicateAsIndexed(
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
        duplicateOfUserId: null,
        matchedUserId: null,
        faceMatchSimilarity: null,
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

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getProfileByUserId = vi.fn()
const findRelatedProfiles = vi.fn()
const revokeProfile = vi.fn()
const createRevocationRecord = vi.fn()
const findProfileByRekognitionFaceIdAnyStatus = vi.fn()

vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: {
    getProfileByUserId: (...args: unknown[]) => getProfileByUserId(...args),
    findRelatedProfiles: (...args: unknown[]) => findRelatedProfiles(...args),
    revokeProfile: (...args: unknown[]) => revokeProfile(...args),
    createRevocationRecord: (...args: unknown[]) => createRevocationRecord(...args),
    findProfileByRekognitionFaceIdAnyStatus: (...args: unknown[]) =>
      findProfileByRekognitionFaceIdAnyStatus(...args),
    listProfilesForAdmin: vi.fn(),
    countProfilesByStatus: vi.fn(),
    findProfilesByRekognitionFaceIds: vi.fn(),
    findProfilesByUserIds: vi.fn(),
    clearDuplicateBlock: vi.fn(),
  },
}))

const getKycByUserId = vi.fn()
const setFaceVerified = vi.fn()
vi.mock('../../src/repositories/agencyApplicationKyc.repository', () => ({
  agencyApplicationKycRepository: {
    getKycByUserId: (...args: unknown[]) => getKycByUserId(...args),
    setFaceVerified: (...args: unknown[]) => setFaceVerified(...args),
  },
}))

vi.mock('../../src/lib/rekognition.client', () => ({
  deleteFaceFromCollection: vi.fn().mockResolvedValue({}),
  describeFaceCollection: vi.fn().mockResolvedValue({ FaceCount: 1 }),
  listFacesInCollection: vi.fn().mockResolvedValue({ Faces: [] }),
  externalImageIdToUserId: (id: string) => id,
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

vi.mock('../../src/config/env', () => ({
  env: { REKOGNITION_COLLECTION_ID: 'test-collection' },
}))

// The admin service also manages registration sessions (stuck-session clearing, manual
// index). Mock the repository and the DB module so importing it needs no DATABASE_URL.
vi.mock('../../src/repositories/faceRegistration.repository', () => ({
  faceRegistrationRepository: {
    clearStuckSessionsForUser: vi.fn().mockResolvedValue([]),
    listStuckSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    findOpenSessionsForUser: vi.fn().mockResolvedValue([]),
    findLatestForUser: vi.fn().mockResolvedValue(null),
    findByIdForUser: vi.fn().mockResolvedValue(null),
    markSessionIndexed: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    appendAudit: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('../../src/config/database', () => ({ prisma: {}, prismaRead: {} }))

// Remaining collaborators of the admin service — none are exercised by the revoke path's
// assertions, but importing the real modules would open Redis / need the full env.
vi.mock('../../src/repositories/user.repository', () => ({ userRepository: {} }))
vi.mock('../../src/config/redis', () => ({
  redisClient: { del: vi.fn().mockResolvedValue(1), get: vi.fn().mockResolvedValue(null) },
  RedisKeys: new Proxy({}, { get: () => (...a: unknown[]) => `k:${a.join(':')}` }),
}))
vi.mock('../../src/queues/face-registration.queue', () => ({
  enqueueFaceRegistrationVerification: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/services/storage.service', () => ({ storageService: {} }))
const afterFaceProfileRevoked = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/face-profile-invalidate', () => ({
  afterFaceProfileRevoked: (...a: unknown[]) => afterFaceProfileRevoked(...a),
}))
vi.mock('../../src/services/faceRegistration.service', () => ({ faceRegistrationService: {} }))
vi.mock('../../src/services/me.service', () => ({
  meService: { invalidateUserCaches: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../src/utils/ws-publisher', () => ({
  publishServerFrameToUser: vi.fn().mockResolvedValue(undefined),
}))

const { faceVerificationAdminService } = await import(
  '../../src/services/face-verification-admin.service'
)

const adminId = 'admin-1'
const userId = 'user-indexed'
const duplicateUserId = 'user-dup'

describe('faceVerificationAdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getKycByUserId.mockResolvedValue(null)
    revokeProfile.mockResolvedValue({})
    createRevocationRecord.mockResolvedValue({})
  })

  describe('revokeUserFaceProfile', () => {
    it('revokes primary and related DUPLICATE_FACE users', async () => {
      getProfileByUserId.mockImplementation(async (uid: string) => {
        if (uid === userId) {
          return {
            id: 'prof-1',
            userId,
            status: 'INDEXED',
            rekognitionFaceId: 'face-abc',
          }
        }
        if (uid === duplicateUserId) {
          return {
            id: 'prof-2',
            userId: duplicateUserId,
            status: 'DUPLICATE_FACE',
            rekognitionFaceId: null,
          }
        }
        return null
      })
      findRelatedProfiles.mockResolvedValue([{ userId: duplicateUserId, status: 'DUPLICATE_FACE' }])

      const result = await faceVerificationAdminService.revokeUserFaceProfile(
        userId,
        adminId,
        'support',
      )

      expect(result.success).toBe(true)
      expect(result.previousStatus).toBe('INDEXED')
      expect(result.relatedRevoked).toHaveLength(1)
      expect(revokeProfile).toHaveBeenCalledTimes(2)
      expect(createRevocationRecord).toHaveBeenCalledTimes(2)
      expect(createRevocationRecord).toHaveBeenCalledWith(
        expect.objectContaining({ revokedByAdminId: adminId }),
      )
      // /me must reflect the revocation immediately for both users
      expect(afterFaceProfileRevoked).toHaveBeenCalledWith(userId)
      expect(afterFaceProfileRevoked).toHaveBeenCalledWith(duplicateUserId)
    })

    it('throws when primary profile missing', async () => {
      getProfileByUserId.mockResolvedValue(null)

      await expect(
        faceVerificationAdminService.revokeUserFaceProfile(userId, adminId),
      ).rejects.toMatchObject({ code: 'FACE_PROFILE_NOT_FOUND', statusCode: 404 })
    })
  })
})

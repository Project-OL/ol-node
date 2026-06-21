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
    })

    it('throws when primary profile missing', async () => {
      getProfileByUserId.mockResolvedValue(null)

      await expect(
        faceVerificationAdminService.revokeUserFaceProfile(userId, adminId),
      ).rejects.toMatchObject({ code: 'FACE_PROFILE_NOT_FOUND', statusCode: 404 })
    })
  })
})

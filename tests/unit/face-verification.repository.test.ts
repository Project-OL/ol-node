import { describe, it, expect, vi, beforeEach } from 'vitest'

const agencyKycFindUnique = vi.fn()
const faceProfileFindUnique = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {},
  prismaRead: {
    agencyApplicationKyc: { findUnique: (...a: unknown[]) => agencyKycFindUnique(...a) },
    userFaceProfile: { findUnique: (...a: unknown[]) => faceProfileFindUnique(...a) },
  },
}))

import { faceVerificationRepository } from '../../src/repositories/faceVerification.repository'

describe('faceVerificationRepository.isVerifiedForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agencyKycFindUnique.mockResolvedValue(null)
    faceProfileFindUnique.mockResolvedValue(null)
  })

  it('returns true when face profile is INDEXED', async () => {
    faceProfileFindUnique.mockResolvedValue({ status: 'INDEXED' })
    await expect(faceVerificationRepository.isVerifiedForUser('user-1')).resolves.toBe(true)
  })

  it('returns true when agency KYC face_verified is set', async () => {
    agencyKycFindUnique.mockResolvedValue({ faceVerified: true })
    await expect(faceVerificationRepository.isVerifiedForUser('user-1')).resolves.toBe(true)
  })

  it('returns false when neither gate is satisfied', async () => {
    faceProfileFindUnique.mockResolvedValue({ status: 'PENDING_INDEX' })
    agencyKycFindUnique.mockResolvedValue({ faceVerified: false })
    await expect(faceVerificationRepository.isVerifiedForUser('user-1')).resolves.toBe(false)
  })
})

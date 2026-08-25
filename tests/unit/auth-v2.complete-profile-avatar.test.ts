import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const findById = vi.fn()
const updateProfile = vi.fn()

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...a: unknown[]) => findById(...a),
    updateProfile: (...a: unknown[]) => updateProfile(...a),
  },
}))

vi.mock('../../src/services/restrictedIdentityWords.service', () => ({
  restrictedIdentityWordsService: {
    assertNamePartsNotRestricted: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../src/utils/user-identity-unique', () => ({
  assertDisplayNameAvailable: vi.fn().mockResolvedValue(undefined),
  allocateUniqueUsername: vi.fn(),
}))

const assertAvatarUrlNotNude = vi.fn()
vi.mock('../../src/services/avatar-moderation.service', () => ({
  avatarModerationService: {
    assertAvatarUrlNotNude: (...a: unknown[]) => assertAvatarUrlNotNude(...a),
  },
}))

vi.mock('../../src/services/device.service', () => ({
  deviceService: {
    linkAccountToDevice: vi.fn().mockResolvedValue(undefined),
  },
}))

const createSession = vi.fn()
vi.mock('../../src/services/session.service', () => ({
  sessionService: {
    createSession: (...a: unknown[]) => createSession(...a),
  },
}))

vi.mock('../../src/utils/agency-country', () => ({
  normalizeCountry: (c: string) => c,
}))

vi.mock('../../src/config/database', () => ({ prisma: {} }))
vi.mock('../../src/config/redis', () => ({
  redisClient: {},
  RedisKeys: {},
}))

import { authV2Service } from '../../src/services/auth-v2.service'

const userId = 'user-uuid-1'
const pendingUser = {
  id: userId,
  status: 'pending',
  publicId: BigInt(1001),
  passwordSet: true,
  firstName: null,
  lastName: null,
  avatarUrl: null,
  isSupport: false,
}

describe('authV2Service.completeProfile avatar moderation', () => {
  beforeEach(() => {
    findById.mockReset()
    updateProfile.mockReset()
    assertAvatarUrlNotNude.mockReset()
    createSession.mockReset()
    createSession.mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
    })
    updateProfile.mockResolvedValue(undefined)
  })

  it('skips moderation and completes when avatarUrl is omitted', async () => {
    findById
      .mockResolvedValueOnce(pendingUser)
      .mockResolvedValueOnce({ ...pendingUser, status: 'active', firstName: 'Ada', avatarUrl: null })
    const out = await authV2Service.completeProfile(userId, {
      firstName: 'Ada',
      country: 'India',
      gender: 'female',
    })
    expect(assertAvatarUrlNotNude).not.toHaveBeenCalled()
    expect(updateProfile).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ avatarUrl: null, status: 'active' }),
    )
    expect(out.status).toBe('active')
  })

  it('skips moderation when avatarUrl is empty string', async () => {
    findById
      .mockResolvedValueOnce(pendingUser)
      .mockResolvedValueOnce({ ...pendingUser, status: 'active', firstName: 'Ada' })
    await authV2Service.completeProfile(userId, {
      firstName: 'Ada',
      country: 'India',
      gender: 'female',
      avatarUrl: '',
    })
    expect(assertAvatarUrlNotNude).not.toHaveBeenCalled()
  })

  it('scans owned avatar URL before activating profile', async () => {
    const avatarUrl = `https://cdn.example.com/avatars/${userId}/x.jpg`
    assertAvatarUrlNotNude.mockResolvedValueOnce(undefined)
    findById
      .mockResolvedValueOnce(pendingUser)
      .mockResolvedValueOnce({
        ...pendingUser,
        status: 'active',
        firstName: 'Ada',
        avatarUrl,
      })
    await authV2Service.completeProfile(userId, {
      firstName: 'Ada',
      country: 'India',
      gender: 'female',
      avatarUrl,
    })
    expect(assertAvatarUrlNotNude).toHaveBeenCalledWith(userId, avatarUrl)
    expect(updateProfile).toHaveBeenCalled()
  })

  it('allows external avatar URLs without scanning (no mobile change)', async () => {
    findById
      .mockResolvedValueOnce(pendingUser)
      .mockResolvedValueOnce({
        ...pendingUser,
        status: 'active',
        firstName: 'Ada',
        avatarUrl: 'https://lh3.googleusercontent.com/photo.jpg',
      })
    await authV2Service.completeProfile(userId, {
      firstName: 'Ada',
      country: 'India',
      gender: 'female',
      avatarUrl: 'https://lh3.googleusercontent.com/photo.jpg',
    })
    expect(assertAvatarUrlNotNude).toHaveBeenCalledWith(
      userId,
      'https://lh3.googleusercontent.com/photo.jpg',
    )
    expect(updateProfile).toHaveBeenCalled()
  })

  it('does not activate profile when nudity is detected on owned S3 avatar', async () => {
    assertAvatarUrlNotNude.mockRejectedValueOnce(
      new AppError(400, 'This photo cannot be used as a profile picture.', 'AVATAR_NUDITY_DETECTED'),
    )
    findById.mockResolvedValueOnce(pendingUser)
    await expect(
      authV2Service.completeProfile(userId, {
        firstName: 'Ada',
        country: 'India',
        gender: 'female',
        avatarUrl: `https://cdn.example.com/avatars/${userId}/bad.jpg`,
      }),
    ).rejects.toMatchObject({ code: 'AVATAR_NUDITY_DETECTED', statusCode: 400 })
    expect(updateProfile).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })
})

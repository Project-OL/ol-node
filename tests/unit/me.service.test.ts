import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const debitForDisplayNameChange = vi.fn()

vi.mock('../../src/services/coin-wallet.service', () => ({
  USERNAME_CHANGE_COIN_COST: 10_000n,
  coinWalletService: {
    debitForDisplayNameChange: (...a: unknown[]) => debitForDisplayNameChange(...a),
  },
}))

const getCoinBalance = vi.fn()
const getPointBalance = vi.fn()

vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    getCoinBalance: (...a: unknown[]) => getCoinBalance(...a),
    getPointBalance: (...a: unknown[]) => getPointBalance(...a),
  },
}))

const walletUserLevelGetByUser = vi.fn()

vi.mock('../../src/repositories/wallet-user-level.repository', () => ({
  walletUserLevelRepository: {
    getByUser: (...a: unknown[]) => walletUserLevelGetByUser(...a),
  },
}))

const vipFindMostRecent = vi.fn()

vi.mock('../../src/repositories/vip-assignment.repository', () => ({
  vipAssignmentRepository: {
    findMostRecent: (...a: unknown[]) => vipFindMostRecent(...a),
  },
}))

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDel = vi.fn()
const cacheExists = vi.fn()
const cacheTtl = vi.fn()

vi.mock('../../src/services/cacheRedis.service', () => ({
  cacheRedisService: {
    get: (...a: unknown[]) => cacheGet(...a),
    set: (...a: unknown[]) => cacheSet(...a),
    del: (...a: unknown[]) => cacheDel(...a),
    exists: (...a: unknown[]) => cacheExists(...a),
    ttl: (...a: unknown[]) => cacheTtl(...a),
  },
}))

const findForMe = vi.fn()
const updateProfile = vi.fn()
const getTokenVersion = vi.fn()

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findForMe: (...a: unknown[]) => findForMe(...a),
    updateProfile: (...a: unknown[]) => updateProfile(...a),
    getTokenVersion: (...a: unknown[]) => getTokenVersion(...a),
  },
}))

const putObjectBuffer = vi.fn()
const getCdnOrS3PublicUrl = vi.fn((key: string) => `https://cdn.example/${key}`)
const deleteObject = vi.fn()

vi.mock('../../src/services/storage.service', () => ({
  storageService: {
    putObjectBuffer: (...a: unknown[]) => putObjectBuffer(...a),
    getCdnOrS3PublicUrl: (...a: unknown[]) => getCdnOrS3PublicUrl(...a),
    deleteObject: (...a: unknown[]) => deleteObject(...a),
  },
}))

const getCompletionSummaryForUser = vi.fn()

vi.mock('../../src/services/gift-gallery.service', () => ({
  giftGalleryService: {
    getCompletionSummaryForUser: (...a: unknown[]) => getCompletionSummaryForUser(...a),
  },
}))

const isSuperHost = vi.fn()
vi.mock('../../src/services/super-host.service', () => ({
  superHostService: {
    isSuperHost: (...a: unknown[]) => isSuperHost(...a),
  },
}))

const getActiveGuardianSummary = vi.fn()
vi.mock('../../src/services/guardian.service', () => ({
  guardianService: {
    getActiveGuardianSummary: (...a: unknown[]) => getActiveGuardianSummary(...a),
  },
}))

const getActiveItemsForUser = vi.fn()
vi.mock('../../src/services/store.service', () => ({
  storeService: {
    getActiveItemsForUser: (...a: unknown[]) => getActiveItemsForUser(...a),
  },
}))

const getCurrentTierForUserRich = vi.fn()
vi.mock('../../src/services/rich-tier.service', () => ({
  richTierService: {
    getCurrentTierForUser: (...a: unknown[]) => getCurrentTierForUserRich(...a),
  },
}))

const buildMeVipMembershipBlock = vi.fn()
vi.mock('../../src/services/vip-membership.service', () => ({
  vipMembershipService: {
    buildMeVipMembershipBlock: (...a: unknown[]) =>
      buildMeVipMembershipBlock(...a),
  },
}))

vi.mock('../../src/services/agency.service', () => ({
  agencyService: {
    buildMeAgencyBlock: vi.fn().mockResolvedValue({
      role: 'NONE' as const,
    }),
  },
}))

const buildMeLivePhotoBlock = vi.fn()
vi.mock('../../src/services/livePhoto.service', () => ({
  livePhotoService: {
    buildMeLivePhotoBlock: (...a: unknown[]) => buildMeLivePhotoBlock(...a),
  },
}))

const isFaceVerifiedForUser = vi.fn()
vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: {
    isVerifiedForUser: (...a: unknown[]) => isFaceVerifiedForUser(...a),
  },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    get: vi.fn().mockResolvedValue(null),
  },
  RedisKeys: {
    userMe: (id: string) => `user:me:${id}`,
    userProfile: (id: string) => `user:profile:${id}`,
    userUsernameLock: (id: string) => `user:username_lock:${id}`,
    userActiveVipId: (id: string) => `user:active-vip:${id}`,
  },
}))

import { meService } from '../../src/services/me.service'
import { verifyAccess } from '../../src/utils/jwt'

function baseRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    username: 'jdoe',
    publicId: BigInt(99),
    defaultPublicId: BigInt(99),
    currentVipPublicId: null as bigint | null,
    firstName: 'Jane',
    lastName: 'Doe',
    gender: 'female',
    dateOfBirth: null as Date | null,
    avatarUrl: null as string | null,
    country: null as string | null,
    bio: null as string | null,
    usernameUpdatedAt: null as Date | null,
    passwordSet: true,
    adminTags: [] as string[],
    authIdentifiers: [
      { provider: 'email', identifier: 'j@example.com', isPrimary: true },
    ],
    ...over,
  }
}

describe('meService', () => {
  beforeEach(() => {
    cacheGet.mockReset()
    cacheSet.mockReset()
    cacheDel.mockReset()
    cacheExists.mockReset()
    cacheTtl.mockReset()
    findForMe.mockReset()
    updateProfile.mockReset()
    getTokenVersion.mockReset()
    getTokenVersion.mockResolvedValue(0)
    putObjectBuffer.mockReset()
    deleteObject.mockReset()
    debitForDisplayNameChange.mockReset()
    getCoinBalance.mockReset()
    getPointBalance.mockReset()
    walletUserLevelGetByUser.mockReset()
    vipFindMostRecent.mockReset()
    getCompletionSummaryForUser.mockReset()
    getCompletionSummaryForUser.mockResolvedValue({
      isFullGallery: false,
      receivedItems: 0,
      totalItems: 0,
      monthEndAt: '2026-04-30T23:59:59.999Z',
      secondsRemaining: 100,
    })
    isSuperHost.mockResolvedValue(false)
    getActiveGuardianSummary.mockResolvedValue(null)
    getActiveItemsForUser.mockReset()
    getCurrentTierForUserRich.mockReset()
    getActiveItemsForUser.mockResolvedValue({
      RIDE: null,
      AVATAR_FRAME: null,
      CHAT_BUBBLE: null,
      PROFILE_CARD: null,
      rareId: null,
    })
    getCurrentTierForUserRich.mockResolvedValue({
      tier: 0,
      displayName: null,
      evaluatedFromYear: 0,
      evaluatedFromMonth: 0,
      currentMonthRechargeCoins: '0',
      currentMonthCarryoverCoins: '0',
      currentMonthProgressCoins: '0',
      nextTierThreshold: '3000000',
      nextTierLackingCoins: '3000000',
      badgeVisible: false,
    })
    buildMeVipMembershipBlock.mockReset()
    buildMeVipMembershipBlock.mockResolvedValue({
      isActive: false,
      daysRemaining: 0,
      dailyClaimAvailable: false,
      vipExclusiveProfileCard: false,
      vipDistinguishedLogo: false,
      vipExclusiveMessageBackground: false,
      vipSpecialEntryEffect: false,
      vipPreventBeingKicked: false,
      vipLiveTranslationEnabled: false,
    })
    buildMeLivePhotoBlock.mockResolvedValue({
      verified: false,
      imageUrl: null,
      verifiedAt: null,
    })
    isFaceVerifiedForUser.mockResolvedValue(false)
    getCoinBalance.mockResolvedValue(20_000n)
    getPointBalance.mockResolvedValue(0n)
    walletUserLevelGetByUser.mockResolvedValue(null)
    vipFindMostRecent.mockResolvedValue(null)
  })

  const galleryStub = {
    isFullGallery: false,
    receivedItems: 0,
    totalItems: 0,
    monthEndAt: '2026-04-30T23:59:59.999Z',
    secondsRemaining: 100,
  }

  const walletSuffix = {
    galleryCompletion: galleryStub,
    coinsBalance: '20000',
    pointsBalance: '0',
    livestreamLevel: 1,
    wealthLevel: 1,
    isVipActive: false,
    lastVipStartedAt: null,
    lastVipExpiresAt: null,
    isSuperHost: false,
    activeGuardian: null,
    activeStoreItems: {
      RIDE: null,
      AVATAR_FRAME: null,
      CHAT_BUBBLE: null,
      PROFILE_CARD: null,
      rareId: null,
    },
    richTier: {
      tier: 0,
      displayName: null,
      evaluatedFromYear: 0,
      evaluatedFromMonth: 0,
      currentMonthRechargeCoins: '0',
      currentMonthCarryoverCoins: '0',
      currentMonthProgressCoins: '0',
      nextTierThreshold: '3000000',
      nextTierLackingCoins: '3000000',
      badgeVisible: false,
    },
    vipMembership: {
      isActive: false,
      daysRemaining: 0,
      dailyClaimAvailable: false,
      vipExclusiveProfileCard: false,
      vipDistinguishedLogo: false,
      vipExclusiveMessageBackground: false,
      vipSpecialEntryEffect: false,
      vipPreventBeingKicked: false,
      vipLiveTranslationEnabled: false,
    },
    agency: {
      role: 'NONE' as const,
    },
    livePhoto: {
      verified: false,
      imageUrl: null,
      verifiedAt: null,
    },
    faceVerified: false,
  }

  it('getMe returns cached payload on Redis HIT', async () => {
    const cached = {
      userId: 'user-1',
      publicId: '99',
      displayPublicId: '99',
      name: 'Jane Doe',
      email: 'j@example.com',
      avatarUrl: null,
      country: null,
      bio: null,
      dateOfBirth: null,
      gender: 'female' as const,
      canChangeUsername: true,
      usernameNextChangeAt: null,
      adminTags: [],
    }
    cacheGet.mockResolvedValueOnce(cached)
    const out = await meService.getMe('user-1')
    expect(out.cache).toBe('HIT')
    expect(out.data).toEqual({ ...cached, ...walletSuffix, canChangeUsername: true, usernameNextChangeAt: null })
    expect(findForMe).not.toHaveBeenCalled()
  })

  it('getMe loads DB and sets cache on MISS', async () => {
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow())
    const out = await meService.getMe('user-1')
    expect(out.cache).toBe('MISS')
    expect(out.data.userId).toBe('user-1')
    expect(out.data.publicId).toBe('99')
    expect(out.data.displayPublicId).toBe('99')
    expect(out.data.dateOfBirth).toBeNull()
    expect(out.data.adminTags).toEqual([])
    expect(out.data.coinsBalance).toBe('20000')
    expect(out.data.canChangeUsername).toBe(true)
    expect(typeof out.data.isVipActive).toBe('boolean')
    expect(out.data.isVipActive).toBe(false)
    expect(out.data.faceVerified).toBe(false)
    expect(cacheSet).toHaveBeenCalled()
  })

  it('getMe returns faceVerified true when indexed face profile exists', async () => {
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow())
    isFaceVerifiedForUser.mockResolvedValueOnce(true)
    const out = await meService.getMe('user-1')
    expect(out.data.faceVerified).toBe(true)
  })

  it('getMe ignores legacy Redis payload without dateOfBirth key (refetch + bust cache)', async () => {
    const legacy = {
      userId: 'user-1',
      publicId: '99',
      name: 'Jane Doe',
      email: 'j@example.com',
      avatarUrl: null,
      country: null,
      bio: null,
      gender: 'female' as const,
      canChangeUsername: true,
      usernameNextChangeAt: null,
    }
    cacheGet.mockResolvedValueOnce(legacy)
    findForMe.mockResolvedValueOnce(
      baseRow({ dateOfBirth: new Date(Date.UTC(1999, 2, 15)) }),
    )
    const out = await meService.getMe('user-1')
    expect(out.cache).toBe('MISS')
    expect(out.data.dateOfBirth).toBe('1999-03-15')
    expect(out.data.canChangeUsername).toBe(true)
    expect(cacheDel).toHaveBeenCalled()
    expect(cacheSet).toHaveBeenCalled()
  })

  it('patchMe name update debits coins and updates name via wallet transaction', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    debitForDisplayNameChange.mockResolvedValue(undefined)
    findForMe.mockResolvedValueOnce(
      baseRow({
        firstName: 'New',
        lastName: 'Name',
        usernameUpdatedAt: new Date(),
      }),
    )
    const out = await meService.patchMe(
      'user-1',
      { name: 'New Name' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(out.user.name).toBe('New Name')
    expect(debitForDisplayNameChange).toHaveBeenCalledWith('user-1', 'New', 'Name')
    expect(updateProfile).not.toHaveBeenCalled()
    const payload = verifyAccess(out.accessToken)
    expect(payload.name).toBe('New Name')
  })

  it('patchMe accepts unicode display name with emoji and symbols', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    debitForDisplayNameChange.mockResolvedValue(undefined)
    findForMe.mockResolvedValueOnce(
      baseRow({
        firstName: '🎮★राज',
        lastName: null,
      }),
    )
    const out = await meService.patchMe('user-1', { name: '🎮★राज' }, null, {})
    expect(out.user.name).toBe('🎮★राज')
    expect(debitForDisplayNameChange).toHaveBeenCalledWith('user-1', '🎮★राज', null)
  })

  it('patchMe name rejects when wallet debit fails (insufficient coins)', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    debitForDisplayNameChange.mockRejectedValueOnce(
      new AppError(402, 'Not enough coins to change display name', 'INSUFFICIENT_COINS', {
        required: '10000',
        balance: '0',
      }),
    )
    await expect(meService.patchMe('user-1', { name: 'Other Name' }, null, {})).rejects.toMatchObject({
      code: 'INSUFFICIENT_COINS',
      statusCode: 402,
    })
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('patchMe skips debit when display name unchanged', async () => {
    findForMe.mockResolvedValueOnce(baseRow({ firstName: 'Jane', lastName: 'Doe' }))
    findForMe.mockResolvedValueOnce(baseRow({ firstName: 'Jane', lastName: 'Doe' }))
    updateProfile.mockResolvedValue(undefined as never)
    await meService.patchMe(
      'user-1',
      { name: 'Jane Doe' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(debitForDisplayNameChange).not.toHaveBeenCalled()
  })

  it('patchMe rejects invalid avatar magic bytes', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    await expect(
      meService.patchMe('user-1', {}, Buffer.from([0, 1, 2, 3]), {}),
    ).rejects.toMatchObject({
      code: 'INVALID_FILE_TYPE',
    })
    expect(putObjectBuffer).not.toHaveBeenCalled()
  })

  it('patchMe invalidates and repopulates cache after update', async () => {
    findForMe.mockResolvedValueOnce(baseRow({ bio: 'old' }))
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow({ bio: 'x'.repeat(3) }))
    await meService.patchMe(
      'user-1',
      { bio: 'hey' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(cacheDel).toHaveBeenCalled()
    expect(cacheSet).toHaveBeenCalled()
  })

  it('patchMe updates date of birth when valid YYYY-MM-DD', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow())
    await meService.patchMe(
      'user-1',
      { dob: '1999-03-15' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        dateOfBirth: new Date(Date.UTC(1999, 2, 15)),
      }),
    )
  })

  it('patchMe clears date of birth when dob is empty', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow())
    await meService.patchMe(
      'user-1',
      { dob: '   ' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ dateOfBirth: null }),
    )
  })

  it('patchMe rejects invalid calendar dob', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    await expect(meService.patchMe('user-1', { dob: '2024-02-30' }, null, {})).rejects.toMatchObject(
      { statusCode: 400, code: 'INVALID_REQUEST' },
    )
    expect(updateProfile).not.toHaveBeenCalled()
  })

  it('patchMe rolls back S3 when DB update fails', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    putObjectBuffer.mockResolvedValue(undefined)
    deleteObject.mockResolvedValue(undefined)
    updateProfile.mockRejectedValueOnce(new Error('db fail'))
    const jpeg = Buffer.alloc(32, 0)
    jpeg[0] = 0xff
    jpeg[1] = 0xd8
    jpeg[2] = 0xff
    await expect(meService.patchMe('user-1', {}, jpeg, {})).rejects.toThrow('db fail')
    expect(deleteObject).toHaveBeenCalled()
  })
})

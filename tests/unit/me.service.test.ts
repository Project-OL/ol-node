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
const walletUserLevelGetByUserForTypes = vi.fn()

vi.mock('../../src/repositories/wallet-user-level.repository', () => ({
  walletUserLevelRepository: {
    getByUser: (...a: unknown[]) => walletUserLevelGetByUser(...a),
    getByUserForTypes: (...a: unknown[]) => walletUserLevelGetByUserForTypes(...a),
  },
}))

const vipFindMostRecent = vi.fn()

vi.mock('../../src/repositories/vip-assignment.repository', () => ({
  vipAssignmentRepository: {
    findMostRecent: (...a: unknown[]) => vipFindMostRecent(...a),
  },
}))

const cacheGet = vi.fn()
const cacheGetAssembled = vi.fn()
const cacheSet = vi.fn()
const cacheDel = vi.fn()
const cacheExists = vi.fn()
const cacheTtl = vi.fn()

vi.mock('../../src/services/cacheRedis.service', () => ({
  cacheRedisService: {
    get: (...a: unknown[]) => {
      const key = a[0] as string
      if (typeof key === 'string' && key.includes(':assembled:')) {
        return cacheGetAssembled(...a)
      }
      return cacheGet(...a)
    },
    set: (...a: unknown[]) => cacheSet(...a),
    del: (...a: unknown[]) => cacheDel(...a),
    exists: (...a: unknown[]) => cacheExists(...a),
    ttl: (...a: unknown[]) => cacheTtl(...a),
  },
}))

const findForMe = vi.fn()
const updateProfile = vi.fn()
const getTokenVersion = vi.fn()
const findOtherByUsernameInsensitive = vi.fn()
const findOtherByDisplayNameInsensitive = vi.fn()

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findForMe: (...a: unknown[]) => findForMe(...a),
    updateProfile: (...a: unknown[]) => updateProfile(...a),
    getTokenVersion: (...a: unknown[]) => getTokenVersion(...a),
    findOtherByUsernameInsensitive: (...a: unknown[]) => findOtherByUsernameInsensitive(...a),
    findOtherByDisplayNameInsensitive: (...a: unknown[]) => findOtherByDisplayNameInsensitive(...a),
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

const assertAvatarBytesNotNude = vi.fn()

vi.mock('../../src/services/avatar-moderation.service', () => ({
  avatarModerationService: {
    assertAvatarBytesNotNude: (...a: unknown[]) => assertAvatarBytesNotNude(...a),
    assertAvatarUrlNotNude: vi.fn(),
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

const buildMeAgencyBlock = vi.fn()
const onOwnerNameChanged = vi.fn()
vi.mock('../../src/services/agency.service', () => ({
  agencyService: {
    buildMeAgencyBlock: (...a: unknown[]) => buildMeAgencyBlock(...a),
    onOwnerNameChanged: (...a: unknown[]) => onOwnerNameChanged(...a),
  },
}))

const buildMeLivePhotoBlock = vi.fn()
vi.mock('../../src/services/livePhoto.service', () => ({
  livePhotoService: {
    buildMeLivePhotoBlock: (...a: unknown[]) => buildMeLivePhotoBlock(...a),
  },
}))

const isFaceVerifiedForUser = vi.fn()
const getMeFaceState = vi.fn()
vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: {
    isVerifiedForUser: (...a: unknown[]) => isFaceVerifiedForUser(...a),
    getMeFaceState: (...a: unknown[]) => getMeFaceState(...a),
  },
}))

vi.mock('../../src/services/restrictedIdentityWords.service', () => ({
  restrictedIdentityWordsService: {
    assertNamePartsNotRestricted: vi.fn().mockResolvedValue(undefined),
  },
}))

const getAcceptVideoCalls = vi.fn()
vi.mock('../../src/services/video-call.service', () => ({
  videoCallSettingsService: {
    getAcceptVideoCalls: (...a: unknown[]) => getAcceptVideoCalls(...a),
  },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    get: vi.fn().mockResolvedValue(null),
  },
  getRedisForRead: () => ({
    get: vi.fn().mockResolvedValue(null),
  }),
  RedisKeys: {
    userMe: (id: string) => `user:me:${id}`,
    userMeAssembled: (id: string) => `user:me:assembled:${id}`,
    userProfile: (id: string) => `user:profile:${id}`,
    userUsernameLock: (id: string) => `user:username_lock:${id}`,
    userActiveVipId: (id: string) => `user:active-vip:${id}`,
    userSearchCard: (id: string) => `user:search:card:${id}`,
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
    cacheGetAssembled.mockReset()
    cacheGetAssembled.mockResolvedValue(null)
    cacheSet.mockReset()
    cacheSet.mockResolvedValue(undefined)
    cacheDel.mockReset()
    cacheExists.mockReset()
    cacheTtl.mockReset()
    findForMe.mockReset()
    updateProfile.mockReset()
    getTokenVersion.mockReset()
    getTokenVersion.mockResolvedValue(0)
    findOtherByUsernameInsensitive.mockReset()
    findOtherByDisplayNameInsensitive.mockReset()
    findOtherByUsernameInsensitive.mockResolvedValue(null)
    findOtherByDisplayNameInsensitive.mockResolvedValue(null)
    putObjectBuffer.mockReset()
    deleteObject.mockReset()
    assertAvatarBytesNotNude.mockReset()
    assertAvatarBytesNotNude.mockResolvedValue(undefined)
    debitForDisplayNameChange.mockReset()
    getCoinBalance.mockReset()
    getPointBalance.mockReset()
    walletUserLevelGetByUser.mockReset()
    walletUserLevelGetByUserForTypes.mockReset()
    walletUserLevelGetByUserForTypes.mockResolvedValue([])
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
      level: 0,
      tier: 0,
      displayName: null,
      evaluatedFromYear: 0,
      evaluatedFromMonth: 0,
      amount: '0',
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
    getMeFaceState.mockReset()
    getMeFaceState.mockResolvedValue({
      faceVerified: false,
      faceStatus: 'NONE',
      faceCanReRegister: false,
    })
    getAcceptVideoCalls.mockReset()
    getAcceptVideoCalls.mockResolvedValue(true)
    buildMeAgencyBlock.mockReset()
    buildMeAgencyBlock.mockResolvedValue({ role: 'NONE' as const })
    onOwnerNameChanged.mockReset()
    onOwnerNameChanged.mockResolvedValue(undefined)
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
      level: 0,
      tier: 0,
      displayName: null,
      evaluatedFromYear: 0,
      evaluatedFromMonth: 0,
      amount: '0',
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
    faceStatus: 'NONE',
    faceCanReRegister: false,
    acceptVideoCalls: true,
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
      usernameUpdatedAt: null,
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

  it('getMe merges derived adminTags for agency, gallery, VIP, and rich tier', async () => {
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow({ adminTags: ['Risk review'] }))
    buildMeAgencyBlock.mockResolvedValueOnce({ role: 'AGENT' as const })
    getCompletionSummaryForUser.mockResolvedValueOnce({
      isFullGallery: true,
      receivedItems: 12,
      totalItems: 12,
      monthEndAt: '2026-04-30T23:59:59.999Z',
      secondsRemaining: 100,
    })
    buildMeVipMembershipBlock.mockResolvedValueOnce({
      isActive: true,
      tier: 'DIAMOND',
      daysRemaining: 10,
      dailyClaimAvailable: true,
      vipExclusiveProfileCard: true,
      vipDistinguishedLogo: true,
      vipExclusiveMessageBackground: true,
      vipSpecialEntryEffect: true,
      vipPreventBeingKicked: true,
      vipLiveTranslationEnabled: true,
    })
    getCurrentTierForUserRich.mockResolvedValueOnce({
      level: 1,
      tier: 1,
      displayName: 'RICH I',
      evaluatedFromYear: 2026,
      evaluatedFromMonth: 8,
      amount: '3000000',
      currentMonthRechargeCoins: '3000000',
      currentMonthCarryoverCoins: '0',
      currentMonthProgressCoins: '3000000',
      nextTierThreshold: '5000000',
      nextTierLackingCoins: '2000000',
      badgeVisible: false,
    })
    const out = await meService.getMe('user-1')
    expect(out.data.adminTags).toEqual([
      'coinseller',
      'gift collection',
      'VIP Diamond',
      'RICH I',
      'Risk review',
    ])
  })

  it('getMe uses SVIP derived tag when paid SVIP is active', async () => {
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow())
    buildMeVipMembershipBlock.mockResolvedValueOnce({
      isActive: true,
      tier: 'SVIP',
      daysRemaining: 5,
      dailyClaimAvailable: false,
      vipExclusiveProfileCard: true,
      vipDistinguishedLogo: true,
      vipExclusiveMessageBackground: true,
      vipSpecialEntryEffect: true,
      vipPreventBeingKicked: true,
      vipLiveTranslationEnabled: true,
    })
    const out = await meService.getMe('user-1')
    expect(out.data.adminTags).toEqual(['SVIP'])
  })

  it('getMe returns faceVerified true when indexed face profile exists', async () => {
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow())
    getMeFaceState.mockResolvedValueOnce({
      faceVerified: true,
      faceStatus: 'INDEXED',
      faceCanReRegister: false,
    })
    const out = await meService.getMe('user-1')
    expect(out.data.faceVerified).toBe(true)
  })

  it('getMe shows free username change unavailable after change this month', async () => {
    // Relative to "now" so the test does not rot when the calendar month rolls over.
    const now = new Date()
    const thisMonthChange = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    cacheGet.mockResolvedValueOnce(null)
    findForMe.mockResolvedValueOnce(baseRow({ usernameUpdatedAt: thisMonthChange }))
    const out = await meService.getMe('user-1')
    expect(out.data.canChangeUsername).toBe(false)
    expect(out.data.usernameNextChangeAt).toBe(nextMonthStart.toISOString())
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

  it('patchMe name update is free when monthly allowance unused', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    updateProfile.mockResolvedValue(undefined as never)
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
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        firstName: 'New',
        lastName: 'Name',
        usernameUpdatedAt: expect.any(Date),
      }),
    )
    expect(debitForDisplayNameChange).not.toHaveBeenCalled()
    const payload = verifyAccess(out.accessToken)
    expect(payload.name).toBe('New Name')
  })

  it('patchMe name update debits coins when free change already used this month', async () => {
    const now = new Date()
    findForMe.mockResolvedValueOnce(
      baseRow({ usernameUpdatedAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) }),
    )
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
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(
      baseRow({
        firstName: '🎮★राज',
        lastName: null,
      }),
    )
    const out = await meService.patchMe('user-1', { name: '🎮★राज' }, null, {})
    expect(out.user.name).toBe('🎮★राज')
    expect(updateProfile).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ firstName: '🎮★राज', lastName: null }),
    )
    expect(debitForDisplayNameChange).not.toHaveBeenCalled()
  })

  it('patchMe name rejects when display name is already taken', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    findOtherByDisplayNameInsensitive.mockResolvedValueOnce({ id: 'other-user' })
    await expect(meService.patchMe('user-1', { name: 'New Name' }, null, {})).rejects.toMatchObject({
      code: 'USERNAME_TAKEN',
      statusCode: 409,
    })
    expect(updateProfile).not.toHaveBeenCalled()
    expect(debitForDisplayNameChange).not.toHaveBeenCalled()
  })

  it('patchMe name rejects when wallet debit fails (insufficient coins)', async () => {
    const now = new Date()
    findForMe.mockResolvedValueOnce(
      baseRow({ usernameUpdatedAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) }),
    )
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
    expect(assertAvatarBytesNotNude).not.toHaveBeenCalled()
  })

  it('patchMe rejects nude avatar before S3 upload', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    assertAvatarBytesNotNude.mockRejectedValueOnce(
      new AppError(
        400,
        'This photo cannot be used as a profile picture. Please choose a different image.',
        'AVATAR_NUDITY_DETECTED',
      ),
    )
    const jpeg = Buffer.alloc(32, 0)
    jpeg[0] = 0xff
    jpeg[1] = 0xd8
    jpeg[2] = 0xff
    await expect(meService.patchMe('user-1', {}, jpeg, {})).rejects.toMatchObject({
      code: 'AVATAR_NUDITY_DETECTED',
      statusCode: 400,
    })
    expect(putObjectBuffer).not.toHaveBeenCalled()
  })

  it('patchMe without avatar does not call nudity scan', async () => {
    findForMe.mockResolvedValueOnce(baseRow({ bio: 'old' }))
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow({ bio: 'hey' }))
    await meService.patchMe(
      'user-1',
      { bio: 'hey' },
      null,
      { tokenVersion: 0, sessionId: '550e8400-e29b-41d4-a716-446655440000', sessionTokenVersion: 0 },
    )
    expect(assertAvatarBytesNotNude).not.toHaveBeenCalled()
  })

  it('patchMe uploads avatar after clean nudity scan', async () => {
    findForMe.mockResolvedValueOnce(baseRow())
    putObjectBuffer.mockResolvedValue(undefined)
    updateProfile.mockResolvedValue(undefined as never)
    findForMe.mockResolvedValueOnce(baseRow({ avatarUrl: 'https://cdn.example/avatars/user-1/v1.jpg' }))
    const jpeg = Buffer.alloc(32, 0)
    jpeg[0] = 0xff
    jpeg[1] = 0xd8
    jpeg[2] = 0xff
    await meService.patchMe('user-1', {}, jpeg, {
      tokenVersion: 0,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      sessionTokenVersion: 0,
    })
    expect(assertAvatarBytesNotNude).toHaveBeenCalled()
    expect(putObjectBuffer).toHaveBeenCalled()
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

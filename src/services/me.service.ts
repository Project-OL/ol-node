import crypto from 'crypto'
import sanitizeHtml from 'sanitize-html'
import { z } from 'zod'
import { LevelType } from '@prisma/client'
import { userRepository } from '../repositories/user.repository'
import { walletUserLevelRepository } from '../repositories/wallet-user-level.repository'
import { vipAssignmentRepository } from '../repositories/vip-assignment.repository'
import { walletService } from './wallet.service'
import { coinWalletService } from './coin-wallet.service'
import { cacheRedisService } from './cacheRedis.service'
import { getRedisForRead, RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { signAccess } from '../utils/jwt'
import { AppError } from '../middlewares/errorHandler'
import { storageService } from './storage.service'
import {
  normalizeGenderStored,
  splitDisplayName,
} from '../utils/profileDisplay'
import { formatUserName } from '../utils/user-display'
import { detectImageMimeFromBuffer, extensionForImageMime } from '../utils/imageMagic'
import {
  freeUsernameChangeEligibility,
  isFreeUsernameChangeAvailable,
} from '../utils/monthThrottle'
import type {
  GalleryCompletionDto,
  MeProfileCache,
  MeResponseDto,
  PatchMeResponseDto,
  RichTierMeDto,
} from '../models/me.types'
import { giftGalleryService } from './gift-gallery.service'
import { meEndpointMetrics } from './me.metrics'
import { superHostService } from './super-host.service'
import { guardianService } from './guardian.service'
import { storeService } from './store.service'
import { richTierService } from './rich-tier.service'
import { vipMembershipService } from './vip-membership.service'
import { agencyService } from './agency.service'
import { livePhotoService } from './livePhoto.service'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { videoCallSettingsService } from './video-call.service'

const displayNameSchema = z
  .string()
  .min(2)
  .max(50)
  .refine((s) => !/[\p{Cc}]/u.test(s), 'Name cannot contain control characters')

const dobSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, mo, d] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y, mo - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  }, 'Invalid date of birth')

function sanitizePlain(input: string, maxLen: number): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, maxLen)
}

function primaryEmailFromIdentifiers(
  rows: Array<{ provider: string; identifier: string; isPrimary: boolean }>,
): string {
  const emails = rows.filter((r) => r.provider === 'email')
  if (emails.length === 0) return ''
  const primary = emails.find((r) => r.isPrimary) ?? emails[0]
  return primary?.identifier ?? ''
}

/** PostgreSQL `DATE` / Prisma `@db.Date` — use UTC calendar parts (avoids `toISOString` off-by-one in some TZs). */
function formatDateOfBirthUtc(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function toProfileCache(
  row: NonNullable<Awaited<ReturnType<typeof userRepository.findForMe>>>,
): MeProfileCache {
  const name = formatUserName(row)
  const displayPublicId = (row.currentVipPublicId ?? row.defaultPublicId ?? row.publicId).toString()
  const usernameUpdatedAt = row.usernameUpdatedAt?.toISOString() ?? null
  const usernameEligibility = freeUsernameChangeEligibility(row.usernameUpdatedAt)
  return {
    userId: row.id,
    publicId: row.publicId.toString(),
    displayPublicId,
    name,
    email: primaryEmailFromIdentifiers(row.authIdentifiers),
    avatarUrl: row.avatarUrl,
    country: row.country ?? null,
    bio: row.bio,
    dateOfBirth: row.dateOfBirth != null ? formatDateOfBirthUtc(row.dateOfBirth) : null,
    gender: normalizeGenderStored(row.gender),
    usernameUpdatedAt,
    canChangeUsername: usernameEligibility.canChangeUsername,
    usernameNextChangeAt: usernameEligibility.usernameNextChangeAt,
    adminTags: row.adminTags ?? [],
  }
}

function buildMeResponse(
  profile: MeProfileCache,
  walletData: Awaited<ReturnType<typeof fetchWalletData>>,
  galleryCompletion: GalleryCompletionDto,
  extras: {
    isSuperHost: boolean
    activeGuardian: Awaited<ReturnType<typeof guardianService.getActiveGuardianSummary>>
    activeStoreItems: Awaited<ReturnType<typeof storeService.getActiveItemsForUser>>
    richTier: RichTierMeDto
    vipMembership: Awaited<ReturnType<typeof vipMembershipService.buildMeVipMembershipBlock>>
    agency: Awaited<ReturnType<typeof agencyService.buildMeAgencyBlock>>
    livePhoto: Awaited<ReturnType<typeof livePhotoService.buildMeLivePhotoBlock>>
    faceVerified: boolean
    acceptVideoCalls: boolean
  },
): MeResponseDto {
  const usernameEligibility = freeUsernameChangeEligibility(profile.usernameUpdatedAt)
  return {
    ...profile,
    ...walletData,
    galleryCompletion,
    isSuperHost: extras.isSuperHost,
    activeGuardian: extras.activeGuardian,
    activeStoreItems: extras.activeStoreItems,
    richTier: extras.richTier,
    agency: extras.agency,
    livePhoto: extras.livePhoto,
    faceVerified: extras.faceVerified,
    vipMembership: extras.vipMembership,
    acceptVideoCalls: extras.acceptVideoCalls,
    canChangeUsername: usernameEligibility.canChangeUsername,
    usernameNextChangeAt: usernameEligibility.usernameNextChangeAt,
  }
}

async function fetchWalletData(userId: string): Promise<{
  coinsBalance: string
  pointsBalance: string
  livestreamLevel: number
  wealthLevel: number
  isVipActive: boolean
  lastVipStartedAt: string | null
  lastVipExpiresAt: string | null
}> {
  const [coins, points, levelRows, lastVip] = await Promise.all([
    walletService.getCoinBalance(userId),
    walletService.getPointBalance(userId),
    walletUserLevelRepository.getByUserForTypes(userId, [LevelType.LIVESTREAM, LevelType.WEALTH]),
    vipAssignmentRepository.findMostRecent(userId),
  ])
  const livestreamRow = levelRows.find((r) => r.levelType === LevelType.LIVESTREAM)
  const wealthRow = levelRows.find((r) => r.levelType === LevelType.WEALTH)
  const now = new Date()
  // Legacy pool VIP auto-grants are disabled; this stays true only for existing un-expired user_vip_assignments (incl. store rare-ID leases).
  const isVipActive =
    lastVip != null && lastVip.isActive && lastVip.revokedAt == null && lastVip.expiresAt > now
  return {
    coinsBalance: String(coins),
    pointsBalance: String(points),
    livestreamLevel: livestreamRow?.currentLevel ?? 1,
    wealthLevel: wealthRow?.currentLevel ?? 1,
    isVipActive,
    lastVipStartedAt: lastVip?.startsAt.toISOString() ?? null,
    lastVipExpiresAt: lastVip?.expiresAt.toISOString() ?? null,
  }
}

export const meService = {
  async invalidateUserCaches(userId: string): Promise<void> {
    await cacheRedisService.del(
      RedisKeys.userMe(userId),
      RedisKeys.userProfile(userId),
      RedisKeys.userUsernameLock(userId),
    )
  },

  async getMe(userId: string): Promise<{ data: MeResponseDto; cache: 'HIT' | 'MISS' }> {
    const key = RedisKeys.userMe(userId)
    const cached = await cacheRedisService.get<MeProfileCache>(key)
    // Entries cached before `dateOfBirth` or `adminTags` were added omit keys; do not treat as authoritative.
    const cacheHasRequiredShape =
      cached != null &&
      typeof cached === 'object' &&
      'dateOfBirth' in cached &&
      'adminTags' in cached &&
      'usernameUpdatedAt' in cached

    let profile: MeProfileCache
    let cacheResult: 'HIT' | 'MISS'

    if (cached && cacheHasRequiredShape) {
      meEndpointMetrics.cacheHits += 1
      profile = {
        ...cached,
        dateOfBirth: cached.dateOfBirth ?? null,
        adminTags: cached.adminTags ?? [],
        usernameUpdatedAt: cached.usernameUpdatedAt ?? null,
        // Backward compatibility for cached payloads written before displayPublicId existed.
        displayPublicId: (cached as MeProfileCache).displayPublicId ?? cached.publicId,
      }
      cacheResult = 'HIT'
    } else {
      if (cached && !cacheHasRequiredShape) {
        try {
          await cacheRedisService.del(key)
        } catch {
          /* ignore bust failure */
        }
      }
      meEndpointMetrics.cacheMisses += 1
      const row = await userRepository.findForMe(userId)
      if (!row) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      profile = toProfileCache(row)
      await Promise.all([
        cacheRedisService.set(key, profile, env.REDIS_TTL_ME),
        cacheRedisService.set(RedisKeys.userProfile(userId), profile, env.REDIS_TTL_PROFILE),
      ])
      cacheResult = 'MISS'
    }

    // Wallet/level/VIP data is always fetched fresh (each has its own short-lived Redis cache).
    // All enrichments run concurrently; only richTier waits on walletData (needs isVipActive).
    const walletDataPromise = fetchWalletData(userId)
    const [
      walletData,
      galleryCompletion,
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      richTier,
      vipMembership,
      agency,
      livePhoto,
      faceVerified,
      acceptVideoCalls,
      activeVipRaw,
    ] = await Promise.all([
      walletDataPromise,
      giftGalleryService.getCompletionSummaryForUser(userId),
      superHostService.isSuperHost(userId),
      guardianService.getActiveGuardianSummary(userId),
      storeService.getActiveItemsForUser(userId),
      walletDataPromise.then((wd) =>
        richTierService.getCurrentTierForUser(userId, { isVip: wd.isVipActive }),
      ),
      vipMembershipService.buildMeVipMembershipBlock(userId),
      agencyService.buildMeAgencyBlock(userId),
      livePhotoService.buildMeLivePhotoBlock(userId),
      faceVerificationRepository.isVerifiedForUser(userId),
      videoCallSettingsService.getAcceptVideoCalls(userId),
      getRedisForRead()
        .get(RedisKeys.userActiveVipId(userId))
        .catch(() => null),
    ])
    const data = buildMeResponse(profile, walletData, galleryCompletion, {
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      richTier,
      vipMembership,
      agency,
      livePhoto,
      faceVerified,
      acceptVideoCalls,
    })
    if (activeVipRaw) {
      // Prefer live equipped rare-ID marker over cached profile displayPublicId.
      data.displayPublicId = activeVipRaw
    }
    return { data, cache: cacheResult }
  },

  async patchMe(
    userId: string,
    fields: { name?: string; dob?: string; bio?: string },
    avatarBuffer: Buffer | null,
    jwtCtx: {
      deviceId?: string
      sessionId?: string
      tokenVersion?: number
      sessionTokenVersion?: number
    },
  ): Promise<PatchMeResponseDto> {
    const row = await userRepository.findForMe(userId)
    if (!row) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const updatePayload: Parameters<typeof userRepository.updateProfile>[1] = {}
    let touchedName = false
    let noopDuplicateDisplayName = false
    let touchedDob = false
    let touchedBio = false
    let touchedAvatar = false

    if (fields.name !== undefined) {
      const trimmed = sanitizePlain(fields.name, 80)
      const parsed = displayNameSchema.safeParse(trimmed)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid name',
          'INVALID_REQUEST',
        )
      }

      const { firstName, lastName } = splitDisplayName(parsed.data)
      const prevFirst = row.firstName?.trim() ?? ''
      const prevLast = row.lastName?.trim() ?? ''
      const nextLast = lastName?.trim() ?? ''
      const sameAsCurrent = prevFirst === firstName.trim() && prevLast === nextLast
      if (sameAsCurrent) {
        noopDuplicateDisplayName = true
      } else if (isFreeUsernameChangeAvailable(row.usernameUpdatedAt)) {
        updatePayload.firstName = firstName
        updatePayload.lastName = lastName
        updatePayload.usernameUpdatedAt = new Date()
        touchedName = true
        meEndpointMetrics.bumpProfileField('name')
      } else {
        await coinWalletService.debitForDisplayNameChange(userId, firstName, lastName)
        touchedName = true
        meEndpointMetrics.bumpProfileField('name')
      }
    }

    if (fields.dob !== undefined) {
      const trimmed = fields.dob.trim()
      if (trimmed === '') {
        updatePayload.dateOfBirth = null
      } else {
        const parsed = dobSchema.safeParse(trimmed)
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Invalid date of birth',
            'INVALID_REQUEST',
          )
        }
        const [y, mo, d] = parsed.data.split('-').map(Number)
        updatePayload.dateOfBirth = new Date(Date.UTC(y, mo - 1, d))
      }
      touchedDob = true
      meEndpointMetrics.bumpProfileField('dob')
    }

    if (fields.bio !== undefined) {
      const bio = sanitizePlain(fields.bio, 160)
      if (bio.length > 160) {
        throw new AppError(400, 'Bio too long', 'INVALID_REQUEST')
      }
      updatePayload.bio = bio || null
      touchedBio = true
      meEndpointMetrics.bumpProfileField('bio')
    }

    let uploadedKey: string | null = null
    if (avatarBuffer != null && avatarBuffer.length > 0) {
      if (avatarBuffer.length > env.MAX_AVATAR_SIZE_BYTES) {
        throw new AppError(413, 'Avatar exceeds maximum size', 'FILE_TOO_LARGE', {
          maxBytes: env.MAX_AVATAR_SIZE_BYTES,
        })
      }
      const mime = detectImageMimeFromBuffer(avatarBuffer)
      if (!mime) {
        throw new AppError(400, 'Avatar must be JPEG, PNG, or WEBP', 'INVALID_FILE_TYPE')
      }
      const ext = extensionForImageMime(mime)
      const key = `avatars/${userId}/v${Date.now()}.${ext}`
      try {
        await storageService.putObjectBuffer({
          key,
          body: avatarBuffer,
          contentType: mime,
        })
      } catch (e) {
        if (e instanceof AppError) throw e
        throw new AppError(502, 'File storage temporarily unavailable', 'S3_UPLOAD_FAILED')
      }
      uploadedKey = key
      updatePayload.avatarUrl = storageService.getCdnOrS3PublicUrl(key)
      touchedAvatar = true
      meEndpointMetrics.bumpProfileField('avatar')
    }

    if (
      Object.keys(updatePayload).length === 0 &&
      !touchedName &&
      !noopDuplicateDisplayName &&
      !touchedDob &&
      !touchedBio &&
      !touchedAvatar
    ) {
      throw new AppError(400, 'No valid fields to update', 'INVALID_REQUEST')
    }

    try {
      if (Object.keys(updatePayload).length > 0) {
        await userRepository.updateProfile(userId, updatePayload)
      }
    } catch (err) {
      if (uploadedKey) {
        await storageService.deleteObject(uploadedKey).catch(() => undefined)
      }
      throw err
    }

    await cacheRedisService.del(RedisKeys.userMe(userId), RedisKeys.userProfile(userId))

    const fresh = await userRepository.findForMe(userId)
    if (!fresh) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }
    const profile = toProfileCache(fresh)
    await Promise.all([
      cacheRedisService.set(RedisKeys.userMe(userId), profile, env.REDIS_TTL_ME),
      cacheRedisService.set(RedisKeys.userProfile(userId), profile, env.REDIS_TTL_PROFILE),
    ])

    const walletDataPromise = fetchWalletData(userId)
    const [
      walletData,
      galleryCompletion,
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      richTier,
      vipMembership,
      agency,
      livePhoto,
      faceVerified,
      acceptVideoCalls,
    ] = await Promise.all([
      walletDataPromise,
      giftGalleryService.getCompletionSummaryForUser(userId),
      superHostService.isSuperHost(userId),
      guardianService.getActiveGuardianSummary(userId),
      storeService.getActiveItemsForUser(userId),
      walletDataPromise.then((wd) =>
        richTierService.getCurrentTierForUser(userId, { isVip: wd.isVipActive }),
      ),
      vipMembershipService.buildMeVipMembershipBlock(userId),
      agencyService.buildMeAgencyBlock(userId),
      livePhotoService.buildMeLivePhotoBlock(userId),
      faceVerificationRepository.isVerifiedForUser(userId),
      videoCallSettingsService.getAcceptVideoCalls(userId),
    ])
    const data = buildMeResponse(profile, walletData, galleryCompletion, {
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      richTier,
      vipMembership,
      agency,
      livePhoto,
      faceVerified,
      acceptVideoCalls,
    })

    const userTv = jwtCtx.tokenVersion ?? (await userRepository.getTokenVersion(userId)) ?? 0
    const accessPayload: Parameters<typeof signAccess>[0] = {
      sub: userId,
      userId,
      publicId: Number(fresh.publicId),
      passwordSet: fresh.passwordSet,
      name: formatUserName(fresh),
      avatarUrl: fresh.avatarUrl,
      jti: crypto.randomUUID(),
      deviceId: jwtCtx.deviceId,
      tokenVersion: userTv,
      isSupport: fresh.isSupport ?? false,
    }
    if (jwtCtx.sessionId != null) {
      accessPayload.sessionId = jwtCtx.sessionId
      accessPayload.sessionTokenVersion = jwtCtx.sessionTokenVersion ?? 0
    }
    const accessToken = signAccess(accessPayload, env.JWT_ACCESS_EXPIRES_IN)

    return { user: data, accessToken }
  },
}

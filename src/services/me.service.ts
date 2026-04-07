import crypto from 'crypto'
import sanitizeHtml from 'sanitize-html'
import { z } from 'zod'
import { LevelType } from '@prisma/client'
import { userRepository } from '../repositories/user.repository'
import { walletUserLevelRepository } from '../repositories/wallet-user-level.repository'
import { vipAssignmentRepository } from '../repositories/vip-assignment.repository'
import { walletService } from './wallet.service'
import {
  coinWalletService,
  USERNAME_CHANGE_COIN_COST,
} from './coin-wallet.service'
import { cacheRedisService } from './cacheRedis.service'
import { RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { signAccess } from '../utils/jwt'
import { AppError } from '../middlewares/errorHandler'
import { storageService } from './storage.service'
import { displayNameFromUser, normalizeGenderStored, splitDisplayName } from '../utils/profileDisplay'
import { detectImageMimeFromBuffer, extensionForImageMime } from '../utils/imageMagic'
import type { MeProfileCache, MeResponseDto, PatchMeResponseDto } from '../models/me.types'
import { meEndpointMetrics } from './me.metrics'

const displayNameSchema = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[\p{L}\p{N} ]+$/u, 'Name may only contain letters, numbers, and spaces')

const dobSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const [y, mo, d] = s.split('-').map(Number)
    const dt = new Date(Date.UTC(y, mo - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
  }, 'Invalid date of birth')

function sanitizePlain(input: string, maxLen: number): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .trim()
    .slice(0, maxLen)
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
  const name = displayNameFromUser(row)
  return {
    userId: row.id,
    publicId: row.publicId.toString(),
    name,
    email: primaryEmailFromIdentifiers(row.authIdentifiers),
    avatarUrl: row.avatarUrl,
    bio: row.bio,
    dateOfBirth: row.dateOfBirth != null ? formatDateOfBirthUtc(row.dateOfBirth) : null,
    gender: normalizeGenderStored(row.gender),
    // Authoritative `canChangeUsername` is set in `buildMeResponse` from live coin balance.
    canChangeUsername: true,
    usernameNextChangeAt: null,
  }
}

function buildMeResponse(
  profile: MeProfileCache,
  walletData: Awaited<ReturnType<typeof fetchWalletData>>,
): MeResponseDto {
  return {
    ...profile,
    ...walletData,
    canChangeUsername: BigInt(walletData.coinsBalance) >= USERNAME_CHANGE_COIN_COST,
    usernameNextChangeAt: null,
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
  const [coins, points, livestreamRow, wealthRow, lastVip] = await Promise.all([
    walletService.getCoinBalance(userId),
    walletService.getPointBalance(userId),
    walletUserLevelRepository.getByUser(userId, LevelType.LIVESTREAM),
    walletUserLevelRepository.getByUser(userId, LevelType.WEALTH),
    vipAssignmentRepository.findMostRecent(userId),
  ])
  const now = new Date()
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
    // Entries cached before `dateOfBirth` was added omit the key; do not treat as authoritative null.
    const cacheHasDobShape = cached != null && typeof cached === 'object' && 'dateOfBirth' in cached

    let profile: MeProfileCache
    let cacheResult: 'HIT' | 'MISS'

    if (cached && cacheHasDobShape) {
      meEndpointMetrics.cacheHits += 1
      profile = { ...cached, dateOfBirth: cached.dateOfBirth ?? null }
      cacheResult = 'HIT'
    } else {
      if (cached && !cacheHasDobShape) {
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
      await cacheRedisService.set(key, profile, env.REDIS_TTL_ME)
      await cacheRedisService.set(RedisKeys.userProfile(userId), profile, env.REDIS_TTL_PROFILE)
      cacheResult = 'MISS'
    }

    // Wallet/level/VIP data is always fetched fresh (each has its own short-lived Redis cache).
    const walletData = await fetchWalletData(userId)
    const data = buildMeResponse(profile, walletData)
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
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid name', 'INVALID_REQUEST')
      }

      const { firstName, lastName } = splitDisplayName(parsed.data)
      const prevFirst = row.firstName?.trim() ?? ''
      const prevLast = row.lastName?.trim() ?? ''
      const nextLast = lastName?.trim() ?? ''
      const sameAsCurrent =
        prevFirst === firstName.trim() && prevLast === nextLast
      if (sameAsCurrent) {
        noopDuplicateDisplayName = true
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
    await cacheRedisService.set(RedisKeys.userMe(userId), profile, env.REDIS_TTL_ME)
    await cacheRedisService.set(RedisKeys.userProfile(userId), profile, env.REDIS_TTL_PROFILE)

    const walletData = await fetchWalletData(userId)
    const data = buildMeResponse(profile, walletData)

    const displayName = displayNameFromUser(fresh)
    const userTv =
      jwtCtx.tokenVersion ?? (await userRepository.getTokenVersion(userId)) ?? 0
    const accessPayload: Parameters<typeof signAccess>[0] = {
      sub: userId,
      userId,
      publicId: Number(fresh.publicId),
      passwordSet: fresh.passwordSet,
      name: displayName,
      avatarUrl: fresh.avatarUrl,
      jti: crypto.randomUUID(),
      deviceId: jwtCtx.deviceId,
      tokenVersion: userTv,
    }
    if (jwtCtx.sessionId != null) {
      accessPayload.sessionId = jwtCtx.sessionId
      accessPayload.sessionTokenVersion = jwtCtx.sessionTokenVersion ?? 0
    }
    const accessToken = signAccess(accessPayload, env.JWT_ACCESS_EXPIRES_IN)

    return { user: data, accessToken }
  },
}

/**
 * Production auth orchestration: check-availability, signup, login, refresh, logout,
 * password reset, settings, password set/change, email/phone bind & modify.
 *
 * Login (email/phone): use POST /check-availability then POST /login/password — no OTP on login.
 * OTP login routes remain for backward compatibility but are not part of the primary mobile flow.
 */

import crypto from 'crypto'
import { prisma } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { signAccess, signRefresh, verifyAccessForLogout } from '../utils/jwt'
import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import { authPasswordRepository } from '../repositories/auth-password.repository'
import { userRepository } from '../repositories/user.repository'
import { sessionService } from './session.service'
import { publicIdService } from './public-id.service'
import { userPublicIdService } from './user-public-id.service'
import { passwordService } from './password.service'
import { normalizeCountry } from '../utils/agency-country'
import { otpAuthService } from './otp-auth.service'
import { auditService } from './audit.service'
import { platformConversationsService } from './platformConversations.service'
import { cacheService } from './cache.service'
import { providerService } from './provider.service'
import {
  oauthService,
  verifyGoogleToken,
  verifyFacebookToken,
  verifyAppleToken,
} from './oauth.service'
import { AppError } from '../middlewares/errorHandler'
import { emailSchema, phoneSchema } from '../models/schemas'
import type { AuthProvider, CheckAvailabilityResult, JwtAccessPayload } from '../models/types'
import { deviceService } from './device.service'
import { formatUserName } from '../utils/user-display'
import { ensureUserMayAuthenticate } from '../utils/user-account-status'

const SIGNUP_VERIFIED_TTL = 300

function normalizeHeaders(
  h?: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> | undefined {
  if (!h) return undefined
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(h)) {
    out[k] = Array.isArray(v) ? v[0] : v
  }
  return out
}

function getIp(request?: {
  ip?: string
  headers?: Record<string, string | string[] | undefined>
}): string {
  const h = request?.headers
  const forwarded = h?.['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (first) return first.trim().split(',')[0]?.trim() ?? '0.0.0.0'
  return request?.ip ?? '0.0.0.0'
}

function getUserAgent(request?: {
  headers?: Record<string, string | string[] | undefined>
}): string | undefined {
  const ua = request?.headers?.['user-agent']
  return Array.isArray(ua) ? ua[0] : ua
}

function validateIdentifier(provider: AuthProvider, identifier: string): void {
  providerService.validateProvider(provider, identifier)
}

/**
 * Auth v2 service: signup (OTP + password), login (password/OAuth; OTP optional legacy), refresh, logout,
 * password reset/set/change, settings (identifiers + sessions), email/phone bind & modify.
 */
export const authV2Service = {
  /**
   * Check if identifier is registered. When `exists` is true, includes `passwordSet`, all `authMethods`,
   * and `identifiers` (provider + raw identifier per linked row) for login/OTP/password-reset UX.
   */
  async checkAvailability(
    provider: AuthProvider,
    identifier: string,
  ): Promise<CheckAvailabilityResult> {
    validateIdentifier(provider, identifier)
    const auth = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (!auth) {
      return { exists: false as const, authMethods: [] as AuthProvider[] }
    }
    const all = await authIdentifierRepository.findByUserId(auth.userId)
    return {
      exists: true as const,
      authMethods: all.map((a) => a.provider as AuthProvider),
      identifiers: all.map((a) => ({
        provider: a.provider as AuthProvider,
        identifier: a.identifier,
      })),
      canSignup: false,
      passwordSet: auth.user.passwordSet,
    }
  },

  async signupSendOtp(provider: AuthProvider, identifier: string) {
    validateIdentifier(provider, identifier)
    const existing = await authIdentifierRepository.findByProviderAndIdentifier(
      provider,
      identifier,
    )
    if (existing) throw new AppError(400, 'Identifier already registered', 'IDENTIFIER_TAKEN')
    await otpAuthService.createAndStore({ targetIdentifier: identifier, purpose: 'signup' })
    return { message: 'OTP sent successfully', expiresIn: 300 }
  },

  async signupVerifyOtp(provider: AuthProvider, identifier: string, otp: string) {
    validateIdentifier(provider, identifier)
    const valid = await otpAuthService.verify({
      targetIdentifier: identifier,
      purpose: 'signup',
      otp,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    const key = RedisKeys.signupVerified(provider, identifier)
    await redisClient.set(key, '1', 'EX', SIGNUP_VERIFIED_TTL)
    return { verified: true, nextStep: 'create_password' as const }
  },

  /**
   * Complete signup: create user + authIdentifier + authPassword in a single transaction.
   * Requires prior OTP verification (signupVerifyOtp). Invalidates signup verified key.
   */
  async signupCreatePassword(
    provider: AuthProvider,
    identifier: string,
    password: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    validateIdentifier(provider, identifier)
    const strength = passwordService.validateStrength(password)
    if (!strength.ok) throw new AppError(400, strength.error, 'WEAK_PASSWORD')
    const existingAuth = await authIdentifierRepository.findByProviderAndIdentifier(
      provider,
      identifier,
    )
    if (existingAuth) throw new AppError(409, 'User already exists', 'USER_EXISTS')
    const key = RedisKeys.signupVerified(provider, identifier)
    const verified = await redisClient.get(key)
    if (!verified) throw new AppError(400, 'Please verify OTP first', 'OTP_NOT_VERIFIED')
    await redisClient.del(key)
    const { publicId } = await publicIdService.getNextPublicId('')
    const passwordHash = await passwordService.hash(password)
    const username =
      provider === 'email' ? identifier.split('@')[0]! : `user_${identifier.slice(-6)}`
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          username,
          publicId,
          defaultPublicId: publicId,
          status: 'new',
          passwordSet: true,
        },
      })
      await tx.authIdentifier.create({
        data: {
          userId: u.id,
          provider,
          identifier,
          isVerified: true,
          verifiedAt: new Date(),
          isPrimary: true,
        },
      })
      await tx.authPassword.create({
        data: {
          userId: u.id,
          passwordHash,
          previousPasswordHashes: [],
        },
      })
      return u
    })
    void platformConversationsService.provisionForNewUser(user.id).catch((err) => {
      console.error(`[platform-inbox] provision failed for ${user.id}`, err)
    })
    void userPublicIdService.setOriginalPublicId(user.id, publicId).catch((err) => {
      console.error(`[public-id] Failed to store originalPublicId for ${user.id}`, err)
    })
    await auditService.log({
      userId: user.id,
      actionType: 'signup',
      actionStatus: 'success',
      request: request ? { ip: request.ip, headers: normalizeHeaders(request.headers) } : undefined,
    })
    const tempAccess = signAccess(
      {
        sub: user.id,
        userId: user.id,
        publicId: Number(publicId),
        passwordSet: true,
        name: formatUserName({}),
        avatarUrl: null,
        jti: crypto.randomUUID(),
        tokenVersion: 0,
        isSupport: false,
      },
      '10m',
    )
    const tempRefresh = signRefresh({ userId: user.id, sessionId: user.id, jti: user.id })
    return {
      userId: user.id,
      publicId: Number(publicId),
      nextStep: 'complete_profile' as const,
      message: 'User created. Please complete your profile.',
      accessToken: tempAccess,
      refreshToken: tempRefresh,
    }
  },

  async completeProfile(
    userId: string,
    data: {
      firstName: string
      lastName?: string
      dateOfBirth?: string
      country: string
      gender: string
      avatarUrl?: string
      deviceName?: string
      deviceId?: string
    },
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    if (user.status === 'active')
      throw new AppError(409, 'Profile already completed', 'PROFILE_ALREADY_COMPLETE')
    const dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : undefined
    const lastName = data.lastName && data.lastName.trim() !== '' ? data.lastName : null
    const avatarUrl = data.avatarUrl && data.avatarUrl.trim() !== '' ? data.avatarUrl.trim() : null
    await userRepository.updateProfile(userId, {
      firstName: data.firstName,
      lastName,
      dateOfBirth: dateOfBirth ?? null,
      country: normalizeCountry(data.country),
      gender: data.gender,
      avatarUrl,
      status: 'active',
      profileCompletedAt: new Date(),
    })
    const updated = await userRepository.findById(userId)!
    const publicId = Number(updated!.publicId)
    const passwordSet = updated!.passwordSet
    const deviceName = data.deviceName?.trim() || 'Web'
    const deviceId = data.deviceId?.trim() || `web-${userId.slice(0, 8)}`

    await deviceService.linkAccountToDevice(deviceId, userId)

    const tokens = await sessionService.createSession({
      userId,
      publicId,
      passwordSet,
      deviceName,
      deviceId,
      ipAddress: getIp(request),
      userAgent: getUserAgent(request),
      loginType: 'password',
      displayName: formatUserName(updated!),
      avatarUrl: updated!.avatarUrl,
      isSupport: updated!.isSupport ?? false,
    })
    return {
      userId,
      publicId,
      status: 'active' as const,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      message: 'Profile completed successfully',
    }
  },

  /** @deprecated Prefer POST /login/password. Kept for legacy clients. */
  async loginSendOtp(provider: AuthProvider, identifier: string) {
    validateIdentifier(provider, identifier)
    const auth = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (!auth) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    await otpAuthService.createAndStore({
      targetIdentifier: identifier,
      purpose: 'login',
      userId: auth.userId,
    })
    return { message: 'OTP sent successfully', expiresIn: 300 }
  },

  /** @deprecated Prefer POST /login/password. Kept for legacy clients. */
  async loginVerifyOtp(
    provider: AuthProvider,
    identifier: string,
    otp: string,
    deviceName: string,
    deviceId: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    validateIdentifier(provider, identifier)
    const auth = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (!auth) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const valid = await otpAuthService.verify({
      targetIdentifier: identifier,
      purpose: 'login',
      otp,
      userId: auth.userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    const user = auth.user
    await ensureUserMayAuthenticate(user)
    const publicId = Number(user.publicId)

    await deviceService.linkAccountToDevice(deviceId, user.id)

    const tokens = await sessionService.createSession({
      userId: user.id,
      publicId,
      passwordSet: user.passwordSet,
      deviceName,
      deviceId,
      ipAddress: getIp(request),
      userAgent: getUserAgent(request),
      loginType: 'otp',
      displayName: formatUserName(user),
      avatarUrl: user.avatarUrl,
      isSupport: user.isSupport ?? false,
    })
    await auditService.log({
      userId: user.id,
      actionType: 'login',
      actionStatus: 'success',
      actionDetails: { method: 'otp', provider },
      request: request
        ? { ip: getIp(request), headers: normalizeHeaders(request.headers) }
        : undefined,
      deviceId,
    })
    return {
      userId: user.id,
      publicId,
      status: user.status as 'new' | 'active' | 'suspended' | 'deleted',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      passwordSet: user.passwordSet,
      sessionId: tokens.sessionId,
    }
  },

  /**
   * Password login for email, phone, or publicId. Resolves user by provider + identifier, verifies password,
   * links device, issues session. No OTP.
   */
  async loginPassword(
    provider: AuthProvider | 'publicId',
    identifier: string,
    password: string,
    deviceName: string,
    deviceId: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    // Single round-trip resolves credential row + full user + password hash (was 3 separate
    // queries: identifier lookup, authPassword lookup, profile lookup).
    type LoginUserRow = NonNullable<
      Awaited<ReturnType<typeof authIdentifierRepository.findForLoginWithPassword>>
    >['user']
    let user: LoginUserRow | null = null
    if (provider === 'publicId') {
      const num = Number(identifier)
      if (!Number.isInteger(num) || num < 0)
        throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
      user = await userRepository.findByPublicId(num)
    } else {
      const auth = await authIdentifierRepository.findForLoginWithPassword(provider, identifier)
      if (!auth) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      user = auth.user
    }
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    await ensureUserMayAuthenticate(user)
    // publicId path resolves the user on the read replica; re-read the hash from the primary
    // so password changes are honored immediately. Provider paths already read the primary.
    const pw =
      provider === 'publicId'
        ? await prisma.authPassword.findUnique({ where: { userId: user.id } })
        : user.authPassword
    if (!pw) throw new AppError(401, 'Password not set for this account', 'PASSWORD_NOT_SET')
    const match = await passwordService.compare(password, pw.passwordHash)
    if (!match) throw new AppError(401, 'Invalid password', 'INVALID_CREDENTIALS')
    const publicId = Number(user.publicId)

    await deviceService.linkAccountToDevice(deviceId, user.id)

    const tokens = await sessionService.createSession({
      userId: user.id,
      publicId,
      passwordSet: user.passwordSet,
      deviceName,
      deviceId,
      ipAddress: getIp(request),
      userAgent: getUserAgent(request),
      loginType: 'password',
      displayName: formatUserName(user),
      avatarUrl: user.avatarUrl,
      isSupport: user.isSupport ?? false,
    })
    await auditService.log({
      userId: user.id,
      actionType: 'login',
      actionStatus: 'success',
      actionDetails: { method: 'password', provider },
      request: request
        ? { ip: getIp(request), headers: normalizeHeaders(request.headers) }
        : undefined,
      deviceId,
    })
    return {
      userId: user.id,
      publicId,
      status: user.status as 'new' | 'active' | 'suspended' | 'deleted',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      passwordSet: user.passwordSet,
      sessionId: tokens.sessionId,
    }
  },

  async refresh(
    refreshToken: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const ip = getIp(request)
    const result = await sessionService.rotateRefresh(refreshToken, ip)
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      sessionId: result.sessionId,
    }
  },

  /**
   * Logout: always revokes the session embedded in the access JWT (refresh becomes invalid).
   */
  async logout(
    userId: string,
    accessPayload: JwtAccessPayload,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const sessionId = accessPayload.sessionId
    if (!sessionId) {
      throw new AppError(400, 'Session id missing from token', 'SESSION_ID_REQUIRED')
    }
    return this.revokeAccessTokenSession(userId, sessionId, request)
  },

  /**
   * Logout using access JWT from request body (no Authorization header).
   * Accepts expired tokens when signature is still valid.
   */
  async logoutByAccessToken(
    accessToken: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    let payload: JwtAccessPayload
    try {
      payload = verifyAccessForLogout(accessToken)
    } catch {
      throw new AppError(401, 'Invalid token', 'INVALID_TOKEN')
    }
    const userId = payload.userId ?? payload.sub
    if (!userId) {
      throw new AppError(401, 'Invalid token', 'INVALID_TOKEN')
    }
    const sessionId = payload.sessionId
    if (!sessionId) {
      throw new AppError(400, 'Session id missing from token', 'SESSION_ID_REQUIRED')
    }
    return this.revokeAccessTokenSession(userId, sessionId, request)
  },

  /**
   * Soft logout: invalidate the given access JWT only. Session + refresh stay valid.
   * Client should call POST /auth/refresh to obtain a new access token.
   */
  async invalidateAccessByToken(
    accessToken: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    let payload: JwtAccessPayload
    try {
      payload = verifyAccessForLogout(accessToken)
    } catch {
      throw new AppError(401, 'Invalid token', 'INVALID_TOKEN')
    }
    const userId = payload.userId ?? payload.sub
    if (!userId) {
      throw new AppError(401, 'Invalid token', 'INVALID_TOKEN')
    }
    const sessionId = payload.sessionId
    if (!sessionId) {
      throw new AppError(400, 'Session id missing from token', 'SESSION_ID_REQUIRED')
    }

    const { sessionTokenVersion } = await sessionService.invalidateAccessToken(sessionId, userId)
    await auditService.log({
      userId,
      actionType: 'ACCESS_TOKEN_INVALIDATED',
      actionStatus: 'success',
      actionDetails: { sessionId, sessionTokenVersion },
      request: request
        ? { ip: getIp(request), headers: normalizeHeaders(request.headers) }
        : undefined,
    })
    return {
      message: 'Access token invalidated; refresh to continue',
      sessionTokenVersion,
    }
  },

  async revokeAccessTokenSession(
    userId: string,
    sessionId: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    try {
      await sessionService.revokeSession(sessionId, userId)
    } catch (e) {
      if (e instanceof AppError && e.code === 'SESSION_NOT_FOUND') {
        return { message: 'Logged out successfully' as const, alreadyRevoked: true as const }
      }
      throw e
    }
    await auditService.log({
      userId,
      actionType: 'LOGOUT_SESSION_REVOKED',
      actionStatus: 'success',
      actionDetails: { sessionId },
      request: request
        ? { ip: getIp(request), headers: normalizeHeaders(request.headers) }
        : undefined,
    })
    return { message: 'Logged out successfully' as const }
  },

  // ----- Phase 3: Password reset -----
  async passwordResetSendOtp(identifier: string) {
    const auth = await authIdentifierRepository.findByIdentifier(identifier)
    if (!auth) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const hasPassword = await passwordService.hasPassword(auth.userId)
    if (!hasPassword) throw new AppError(400, "User doesn't have password set", 'NO_PASSWORD')
    const ids = await authIdentifierRepository.findByUserId(auth.userId)
    const methods = ids
      .filter((a) => a.provider === 'email' || a.provider === 'phone')
      .map((a) => a.provider as AuthProvider)
    return {
      userId: auth.userId,
      availableMethods: methods,
      message: 'Select a method to receive password reset OTP',
    }
  },

  async passwordResetSendOtpToProvider(identifier: string, provider: AuthProvider) {
    validateIdentifier(provider, identifier)
    const auth = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (!auth) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    await otpAuthService.createAndStore({
      targetIdentifier: identifier,
      purpose: 'reset_password',
      userId: auth.userId,
    })
    return { message: 'OTP sent successfully', expiresIn: 300 }
  },

  async passwordResetVerifyOtp(identifier: string, provider: AuthProvider, otp: string) {
    validateIdentifier(provider, identifier)
    const auth = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (!auth) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const valid = await otpAuthService.verify({
      targetIdentifier: identifier,
      purpose: 'reset_password',
      otp,
      userId: auth.userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    const resetToken = crypto.randomUUID()
    await redisClient.set(RedisKeys.passwordResetToken(resetToken), auth.userId, 'EX', 300)
    return { verified: true, resetToken, expiresIn: 300 }
  },

  /**
   * Confirm password reset: update password, then revoke-all sessions (same path as password change).
   * Subsequent requests with old JWTs get SESSION_INVALID (logout), not TOKEN_VERSION_MISMATCH.
   */
  async passwordResetConfirm(resetToken: string, newPassword: string) {
    const userId = await redisClient.get(RedisKeys.passwordResetToken(resetToken))
    if (!userId) throw new AppError(400, 'Reset token invalid or expired', 'RESET_TOKEN_INVALID')
    const strength = passwordService.validateStrength(newPassword)
    if (!strength.ok) throw new AppError(400, strength.error, 'WEAK_PASSWORD')
    const existing = await authPasswordRepository.findByUserId(userId)
    if (existing) {
      const same = await passwordService.compare(newPassword, existing.passwordHash)
      if (same) throw new AppError(409, 'New password same as old password', 'SAME_PASSWORD')
    }
    const passwordHash = await passwordService.hash(newPassword)
    await prisma.$transaction(async (tx) => {
      await tx.authPassword.upsert({
        where: { userId },
        create: { userId, passwordHash, previousPasswordHashes: [] },
        update: { passwordHash, lastChangedAt: new Date() },
      })
    })
    // Shared logout-all: revoke sessions + bump tokenVersion + clear Redis session/device caches.
    await sessionService.revokeAllSessions(userId)
    await redisClient.del(RedisKeys.passwordResetToken(resetToken))
    await auditService.log({
      userId,
      actionType: 'password_reset',
      actionStatus: 'success',
      actionDetails: { allSessionsInvalidated: true },
    })
    return { message: 'Password reset successful', allSessionsInvalidated: true }
  },

  // ----- Phase 4: Settings, password set/change, devices -----
  /**
   * Get user settings: auth identifiers (read-through Redis cache) and active sessions.
   * Cache is invalidated on any identifier write (bind, modify, OAuth bind/unbind).
   */
  async getSettings(userId: string, currentSessionId?: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const identifiersRaw = await cacheService.getUserAuthIdentifiers(userId)
    type CachedId = {
      provider: string
      identifier: string
      isVerified: boolean
      verifiedAt: string | null
      isPrimary: boolean
    }
    let authIdentifiers: CachedId[]
    if (identifiersRaw) {
      try {
        authIdentifiers = JSON.parse(identifiersRaw) as CachedId[]
      } catch {
        const fromDb = await authIdentifierRepository.findByUserId(userId)
        authIdentifiers = fromDb.map((a) => ({
          provider: a.provider,
          identifier: a.identifier,
          isVerified: a.isVerified,
          verifiedAt: a.verifiedAt?.toISOString() ?? null,
          isPrimary: a.isPrimary,
        }))
        await cacheService.setUserAuthIdentifiers(userId, authIdentifiers)
      }
    } else {
      const fromDb = await authIdentifierRepository.findByUserId(userId)
      authIdentifiers = fromDb.map((a) => ({
        provider: a.provider,
        identifier: a.identifier,
        isVerified: a.isVerified,
        verifiedAt: a.verifiedAt?.toISOString() ?? null,
        isPrimary: a.isPrimary,
      }))
      await cacheService.setUserAuthIdentifiers(userId, authIdentifiers)
    }
    const sessions = await sessionService.listSessions(userId, currentSessionId)
    return {
      userId: user.id,
      publicId: Number(user.publicId),
      passwordSet: user.passwordSet,
      authIdentifiers: authIdentifiers.map((a) => ({
        provider: a.provider as AuthProvider,
        identifier: a.identifier,
        isVerified: a.isVerified,
        verifiedAt: a.verifiedAt,
        isPrimary: a.isPrimary,
      })),
      activeSessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        deviceName: s.deviceName,
        deviceId: s.deviceId,
        isCurrentDevice: s.isCurrentDevice,
        lastActiveAt: s.lastActiveAt,
        ipAddress: s.ipAddress,
        loginType: s.loginType,
      })),
    }
  },

  async getDevices(userId: string, currentSessionId?: string) {
    const list = await sessionService.listSessions(userId, currentSessionId)
    return { devices: list }
  },

  async passwordSet(userId: string, password: string) {
    const hasPassword = await passwordService.hasPassword(userId)
    if (hasPassword)
      throw new AppError(400, 'User already has password set', 'PASSWORD_ALREADY_SET')
    const ids = await authIdentifierRepository.findByUserId(userId)
    const hasEmailOrPhone = ids.some((a) => a.provider === 'email' || a.provider === 'phone')
    if (!hasEmailOrPhone)
      throw new AppError(400, "User doesn't have email or phone bound", 'NO_EMAIL_OR_PHONE')
    const strength = passwordService.validateStrength(password)
    if (!strength.ok) throw new AppError(400, strength.error, 'WEAK_PASSWORD')
    await passwordService.createPassword(userId, password)
    await userRepository.updatePasswordSet(userId, true)
    await auditService.log({
      userId,
      actionType: 'password_change',
      actionStatus: 'success',
      actionDetails: { type: 'set' },
    })
    return { message: 'Password set successfully', passwordSet: true }
  },

  async passwordChange(
    userId: string,
    currentPassword: string,
    newPassword: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const strength = passwordService.validateStrength(newPassword)
    if (!strength.ok) throw new AppError(400, strength.error, 'WEAK_PASSWORD')
    const updated = await passwordService.verifyAndUpdate(userId, currentPassword, newPassword)
    if (!updated) throw new AppError(401, 'Current password incorrect', 'INVALID_CURRENT_PASSWORD')
    await sessionService.revokeAllSessions(userId)
    await auditService.log({
      userId,
      actionType: 'password_change',
      actionStatus: 'success',
      request: request
        ? { ip: getIp(request), headers: normalizeHeaders(request.headers) }
        : undefined,
    })
    return { message: 'Password changed successfully', allSessionsInvalidated: true }
  },

  // ----- Email bind & modify -----
  async emailBindSendOtp(userId: string, newEmail: string) {
    const r = emailSchema.safeParse(newEmail)
    if (!r.success) throw new AppError(400, 'Invalid email format', 'INVALID_EMAIL')
    const existing = await authIdentifierRepository.findByProviderAndIdentifier('email', newEmail)
    if (existing) {
      if (existing.userId === userId)
        throw new AppError(400, 'Email already bound to current user', 'EMAIL_ALREADY_BOUND')
      throw new AppError(400, 'Email already in use by another user', 'EMAIL_TAKEN')
    }
    await otpAuthService.createAndStore({
      targetIdentifier: newEmail,
      purpose: 'bind_email',
      userId,
    })
    return { message: 'OTP sent to new email', expiresIn: 300 }
  },

  async emailBindVerifyOtp(userId: string, newEmail: string, otp: string) {
    const valid = await otpAuthService.verify({
      targetIdentifier: newEmail,
      purpose: 'bind_email',
      otp,
      userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    await providerService.bindProvider(userId, 'email', newEmail, {
      isVerified: true,
      isPrimary: false,
    })
    await auditService.log({
      userId,
      actionType: 'provider_bind',
      actionStatus: 'success',
      actionDetails: { provider: 'email', identifier: newEmail },
    })
    return { message: 'Email binding verified', email: newEmail, isVerified: true }
  },

  async emailModifyVerifyOld(userId: string, currentEmail: string) {
    const auth = await authIdentifierRepository.findByProviderAndIdentifier('email', currentEmail)
    if (!auth || auth.userId !== userId)
      throw new AppError(400, "Email doesn't match current bound email", 'EMAIL_MISMATCH')
    await otpAuthService.createAndStore({
      targetIdentifier: currentEmail,
      purpose: 'modify_email',
      userId,
    })
    await redisClient.set(
      RedisKeys.emailModifyInProgress(userId),
      JSON.stringify({ currentEmail }),
      'EX',
      300,
    )
    return { message: 'OTP sent to current email', expiresIn: 300 }
  },

  async emailModifyVerifyOldOtp(userId: string, currentEmail: string, otp: string) {
    const auth = await authIdentifierRepository.findByProviderAndIdentifier('email', currentEmail)
    if (!auth || auth.userId !== userId)
      throw new AppError(400, "Email doesn't match current bound email", 'EMAIL_MISMATCH')
    const valid = await otpAuthService.verify({
      targetIdentifier: currentEmail,
      purpose: 'modify_email',
      otp,
      userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    await redisClient.set(
      RedisKeys.emailModifyInProgress(userId),
      JSON.stringify({ currentEmail, verifiedOldAt: Date.now() }),
      'EX',
      300,
    )
    return { message: 'Current email verified' }
  },

  async emailModifyVerifyNew(userId: string, newEmail: string, otp?: string) {
    const raw = await redisClient.get(RedisKeys.emailModifyInProgress(userId))
    if (!raw) throw new AppError(400, 'Please verify current email first', 'OLD_EMAIL_NOT_VERIFIED')
    const data = JSON.parse(raw) as { currentEmail: string; verifiedOldAt?: number }
    if (!data.verifiedOldAt)
      throw new AppError(400, 'Please verify current email first', 'OLD_EMAIL_NOT_VERIFIED')
    const existingNew = await authIdentifierRepository.findByProviderAndIdentifier(
      'email',
      newEmail,
    )
    if (existingNew && existingNew.userId !== userId)
      throw new AppError(400, 'New email already in use', 'EMAIL_TAKEN')
    if (!otp) {
      await otpAuthService.createAndStore({
        targetIdentifier: newEmail,
        purpose: 'modify_email',
        userId,
      })
      await redisClient.set(
        RedisKeys.emailModifyInProgress(userId),
        JSON.stringify({ ...data, newEmail }),
        'EX',
        300,
      )
      return { message: 'OTP sent to new email', expiresIn: 300 }
    }
    const valid = await otpAuthService.verify({
      targetIdentifier: newEmail,
      purpose: 'modify_email',
      otp,
      userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    const current = await authIdentifierRepository
      .findByUserId(userId)
      .then((r) => r.find((a) => a.provider === 'email'))
    if (current)
      await prisma.authIdentifier.update({
        where: { id: current.id },
        data: {
          identifier: newEmail,
          isVerified: true,
          verifiedAt: new Date(),
          version: { increment: 1 },
        },
      })
    await redisClient.del(RedisKeys.emailModifyInProgress(userId))
    await cacheService.invalidateUserAuthIdentifiers(userId)
    await auditService.log({
      userId,
      actionType: 'provider_bind',
      actionStatus: 'success',
      actionDetails: { provider: 'email', action: 'modify', identifier: newEmail },
    })
    return { message: 'Email modified successfully', email: newEmail }
  },

  // ----- Phone bind & modify -----
  async phoneBindSendOtp(userId: string, newPhone: string) {
    const r = phoneSchema.safeParse(newPhone)
    if (!r.success) throw new AppError(400, 'Invalid phone format (E.164)', 'INVALID_PHONE')
    const existing = await authIdentifierRepository.findByProviderAndIdentifier('phone', newPhone)
    if (existing) {
      if (existing.userId === userId)
        throw new AppError(400, 'Phone already bound to current user', 'PHONE_ALREADY_BOUND')
      throw new AppError(400, 'Phone already in use', 'PHONE_TAKEN')
    }
    await otpAuthService.createAndStore({
      targetIdentifier: newPhone,
      purpose: 'bind_phone',
      userId,
    })
    return { message: 'OTP sent to new phone', expiresIn: 300 }
  },

  async phoneBindVerifyOtp(userId: string, newPhone: string, otp: string) {
    const valid = await otpAuthService.verify({
      targetIdentifier: newPhone,
      purpose: 'bind_phone',
      otp,
      userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    await providerService.bindProvider(userId, 'phone', newPhone, {
      isVerified: true,
      isPrimary: false,
    })
    await auditService.log({
      userId,
      actionType: 'provider_bind',
      actionStatus: 'success',
      actionDetails: { provider: 'phone', identifier: newPhone },
    })
    return { message: 'Phone binding verified', phone: newPhone, isVerified: true }
  },

  async phoneModifyVerifyOld(userId: string, currentPhone: string) {
    const auth = await authIdentifierRepository.findByProviderAndIdentifier('phone', currentPhone)
    if (!auth || auth.userId !== userId)
      throw new AppError(400, "Phone doesn't match current bound phone", 'PHONE_MISMATCH')
    await otpAuthService.createAndStore({
      targetIdentifier: currentPhone,
      purpose: 'modify_phone',
      userId,
    })
    await redisClient.set(
      RedisKeys.phoneModifyInProgress(userId),
      JSON.stringify({ currentPhone }),
      'EX',
      300,
    )
    return { message: 'OTP sent to current phone', expiresIn: 300 }
  },

  async phoneModifyVerifyOldOtp(userId: string, currentPhone: string, otp: string) {
    const auth = await authIdentifierRepository.findByProviderAndIdentifier('phone', currentPhone)
    if (!auth || auth.userId !== userId)
      throw new AppError(400, "Phone doesn't match current bound phone", 'PHONE_MISMATCH')
    const valid = await otpAuthService.verify({
      targetIdentifier: currentPhone,
      purpose: 'modify_phone',
      otp,
      userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    await redisClient.set(
      RedisKeys.phoneModifyInProgress(userId),
      JSON.stringify({ currentPhone, verifiedOldAt: Date.now() }),
      'EX',
      300,
    )
    return { message: 'Current phone verified' }
  },

  async phoneModifyVerifyNew(userId: string, newPhone: string, otp?: string) {
    const raw = await redisClient.get(RedisKeys.phoneModifyInProgress(userId))
    if (!raw) throw new AppError(400, 'Please verify current phone first', 'OLD_PHONE_NOT_VERIFIED')
    const data = JSON.parse(raw) as { currentPhone: string; verifiedOldAt?: number }
    if (!data.verifiedOldAt)
      throw new AppError(400, 'Please verify current phone first', 'OLD_PHONE_NOT_VERIFIED')
    const existingNew = await authIdentifierRepository.findByProviderAndIdentifier(
      'phone',
      newPhone,
    )
    if (existingNew && existingNew.userId !== userId)
      throw new AppError(400, 'New phone already in use', 'PHONE_TAKEN')
    if (!otp) {
      await otpAuthService.createAndStore({
        targetIdentifier: newPhone,
        purpose: 'modify_phone',
        userId,
      })
      await redisClient.set(
        RedisKeys.phoneModifyInProgress(userId),
        JSON.stringify({ ...data, newPhone }),
        'EX',
        300,
      )
      return { message: 'OTP sent to new phone', expiresIn: 300 }
    }
    const valid = await otpAuthService.verify({
      targetIdentifier: newPhone,
      purpose: 'modify_phone',
      otp,
      userId,
    })
    if (!valid) throw new AppError(400, 'OTP invalid or expired', 'OTP_INVALID')
    const current = await authIdentifierRepository
      .findByUserId(userId)
      .then((r) => r.find((a) => a.provider === 'phone'))
    if (current)
      await prisma.authIdentifier.update({
        where: { id: current.id },
        data: {
          identifier: newPhone,
          isVerified: true,
          verifiedAt: new Date(),
          version: { increment: 1 },
        },
      })
    await redisClient.del(RedisKeys.phoneModifyInProgress(userId))
    await cacheService.invalidateUserAuthIdentifiers(userId)
    await auditService.log({
      userId,
      actionType: 'provider_bind',
      actionStatus: 'success',
      actionDetails: { provider: 'phone', action: 'modify', identifier: newPhone },
    })
    return { message: 'Phone modified successfully', phone: newPhone }
  },

  // ----- OAuth login (Phase 2) -----
  async oauthGoogle(
    idToken: string,
    deviceName: string,
    deviceId: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const userInfo = await verifyGoogleToken(idToken)
    return oauthService.loginOrSignup(
      'google',
      userInfo,
      deviceName,
      deviceId,
      getIp(request),
      getUserAgent(request),
    )
  },

  async oauthFacebook(
    accessToken: string,
    deviceName: string,
    deviceId: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const userInfo = await verifyFacebookToken(accessToken)
    return oauthService.loginOrSignup(
      'facebook',
      userInfo,
      deviceName,
      deviceId,
      getIp(request),
      getUserAgent(request),
    )
  },

  async oauthApple(
    identityToken: string,
    deviceName: string,
    deviceId: string,
    request?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  ) {
    const userInfo = await verifyAppleToken(identityToken)
    return oauthService.loginOrSignup(
      'apple',
      userInfo,
      deviceName,
      deviceId,
      getIp(request),
      getUserAgent(request),
    )
  },

  /**
   * After `authenticate` middleware succeeds: confirm the user still exists and may use the API
   * (not banned / suspended / deleted / deactivating). Returns a compact verified identity DTO.
   */
  async verifyAuthenticatedUser(userId: string, payload: JwtAccessPayload) {
    const user = await userRepository.findAuthGateById(userId)
    if (!user) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    await ensureUserMayAuthenticate(user)

    return {
      valid: true as const,
      userId: user.id,
      publicId: Number(user.publicId),
      name: formatUserName(user),
      avatarUrl: user.avatarUrl,
      passwordSet: user.passwordSet,
      status: user.status,
      isSupport: user.isSupport,
      sessionId: payload.sessionId ?? null,
      deviceId: payload.deviceId ?? null,
      tokenVersion: payload.tokenVersion ?? 0,
      sessionTokenVersion: payload.sessionTokenVersion ?? null,
      expiresAt:
        typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null,
    }
  },

  // ----- OAuth bind / unbind (Phase 5) -----
  async googleBind(userId: string, idToken: string) {
    const userInfo = await verifyGoogleToken(idToken)
    return oauthService.bindProvider(userId, 'google', userInfo)
  },

  async googleUnbind(userId: string) {
    return oauthService.unbindProvider(userId, 'google')
  },

  async facebookBind(userId: string, accessToken: string) {
    const userInfo = await verifyFacebookToken(accessToken)
    return oauthService.bindProvider(userId, 'facebook', userInfo)
  },

  async facebookUnbind(userId: string) {
    return oauthService.unbindProvider(userId, 'facebook')
  },

  async appleBind(userId: string, identityToken: string) {
    const userInfo = await verifyAppleToken(identityToken)
    return oauthService.bindProvider(userId, 'apple', userInfo)
  },

  async appleUnbind(userId: string) {
    return oauthService.unbindProvider(userId, 'apple')
  },
}

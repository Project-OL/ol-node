import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authV2Service } from '../../services/auth-v2.service'
import { sessionService } from '../../services/session.service'
import { auditService } from '../../services/audit.service'
import {
  checkAvailabilityBodySchema,
  signupSendOtpBodySchema,
  signupVerifyOtpBodySchema,
  signupCreatePasswordBodySchema,
  completeProfileBodySchema,
  loginSendOtpBodySchema,
  loginVerifyOtpBodySchema,
  loginPasswordBodySchema,
  refreshBodySchema,
  sessionRevokeBodySchema,
  passwordResetSendOtpBodySchema,
  passwordResetSendOtpToProviderBodySchema,
  passwordResetVerifyOtpBodySchema,
  passwordResetConfirmBodySchema,
  passwordSetBodySchema,
  passwordChangeBodySchema,
  emailBindSendOtpBodySchema,
  emailBindVerifyOtpBodySchema,
  emailModifyVerifyOldBodySchema,
  emailModifyVerifyOldOtpBodySchema,
  emailModifyVerifyNewBodySchema,
  phoneBindSendOtpBodySchema,
  phoneBindVerifyOtpBodySchema,
  phoneModifyVerifyOldBodySchema,
  phoneModifyVerifyOldOtpBodySchema,
  phoneModifyVerifyNewBodySchema,
  oauthGoogleBodySchema,
  oauthFacebookBodySchema,
  oauthAppleBodySchema,
} from '../../models/schemas'
import { authenticate } from '../../middlewares/auth.middleware'
import { authRateLimits } from '../../middlewares/rateLimitAuth'

export default async function authRoutes(app: FastifyInstance) {
  // ----- Phase 1: Production auth -----
  /**
   * Login (email/phone): POST /check-availability → if exists && passwordSet, POST /login/password
   * with the same deviceId/deviceName the app uses after signup (see complete-profile). No OTP on login.
   * Device id: stable UUID v4 per app install, stored in Keychain (iOS) / EncryptedSharedPreferences or Keystore (Android).
   */
  app.post(
    '/check-availability',
    async (request, reply) => {
      const parsed = checkAvailabilityBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const { provider, identifier } = parsed.data
      const result = await authV2Service.checkAvailability(provider, identifier)
      return reply.send(result)
    },
  )

  app.post(
    '/signup/send-otp',
    { preHandler: [authRateLimits.signupSendOtp] },
    async (request, reply) => {
      const parsed = signupSendOtpBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const result = await authV2Service.signupSendOtp(parsed.data.provider, parsed.data.identifier)
      return reply.send(result)
    },
  )

  app.post(
    '/signup/verify-otp',
    { preHandler: [authRateLimits.signupVerifyOtp] },
    async (request, reply) => {
      const parsed = signupVerifyOtpBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const result = await authV2Service.signupVerifyOtp(
        parsed.data.provider,
        parsed.data.identifier,
        parsed.data.otp,
      )
      return reply.send(result)
    },
  )

  app.post(
    '/signup/create-password',
    async (request, reply) => {
      const parsed = signupCreatePasswordBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const result = await authV2Service.signupCreatePassword(
        parsed.data.provider,
        parsed.data.identifier,
        parsed.data.password,
        request,
      )
      return reply.status(201).send(result)
    },
  )

  app.post(
    '/signup/complete-profile',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = completeProfileBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const userId = (request as { userId?: string }).userId
      if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
      const result = await authV2Service.completeProfile(userId, parsed.data, request)
      return reply.send(result)
    },
  )

  /** @deprecated Use /login/password instead (no OTP on login). */
  app.post(
    '/login/send-otp',
    { preHandler: [authRateLimits.loginSendOtp] },
    async (request, reply) => {
      const parsed = loginSendOtpBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const result = await authV2Service.loginSendOtp(parsed.data.provider, parsed.data.identifier)
      return reply.send(result)
    },
  )

  /** @deprecated Use /login/password instead (no OTP on login). */
  app.post(
    '/login/verify-otp',
    { preHandler: [authRateLimits.loginVerifyOtp] },
    async (request, reply) => {
      const parsed = loginVerifyOtpBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const result = await authV2Service.loginVerifyOtp(
        parsed.data.provider,
        parsed.data.identifier,
        parsed.data.otp,
        parsed.data.deviceName,
        parsed.data.deviceId,
        request,
      )
      return reply.send(result)
    },
  )

  app.post(
    '/login/password',
    { preHandler: [authRateLimits.loginPassword] },
    async (request, reply) => {
      const parsed = loginPasswordBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        })
      }
      const result = await authV2Service.loginPassword(
        parsed.data.provider,
        parsed.data.identifier,
        parsed.data.password,
        parsed.data.deviceName,
        parsed.data.deviceId,
        request,
      )
      return reply.send(result)
    },
  )

  app.post(
    '/refresh',
    async (request, reply) => {
      const parsed = refreshBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
        })
      }
      const result = await authV2Service.refresh(parsed.data.refreshToken, request)
      return reply.send(result)
    },
  )

  app.post(
    '/logout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request as { userId?: string }).userId
      if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
      const parsed = sessionRevokeBodySchema.safeParse(request.body ?? {})
      const sessionId = parsed.success ? parsed.data?.sessionId : undefined
      const payload = request.user as { jti?: string; exp?: number }
      const result = await authV2Service.logout(userId, sessionId, request, payload?.jti, payload?.exp)
      return reply.send(result)
    },
  )

  app.post(
    '/session/revoke',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request as { userId?: string }).userId
      if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
      const parsed = sessionRevokeBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: parsed.error.errors[0]?.message ?? 'Validation failed',
        })
      }
      if (parsed.data.revokeAllSessions) {
        await sessionService.revokeAllSessions(userId)
        const payload = request.user as { jti?: string; exp?: number }
        if (payload?.jti != null && payload?.exp != null) {
          await authV2Service.blacklistAccessToken(payload.jti, payload.exp)
        }
      } else if (parsed.data.sessionId) {
        await sessionService.revokeSession(parsed.data.sessionId, userId)
      } else {
        return reply.status(400).send({ code: 'INVALID_REQUEST', message: 'sessionId or revokeAllSessions required' })
      }
      const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip
      await auditService.log({
        userId,
        actionType: 'logout',
        actionStatus: 'success',
        actionDetails: parsed.data.revokeAllSessions ? { revokeAll: true } : { sessionId: parsed.data.sessionId },
        ipAddress: ip,
        userAgent: (request.headers['user-agent'] as string) ?? undefined,
      })
      return reply.send({ message: 'Session revoked successfully' })
    },
  )

  // ----- Phase 3: Password reset -----
  app.post('/password/reset/send-otp', { preHandler: [authRateLimits.passwordResetSendOtp] }, async (request, reply) => {
    const parsed = passwordResetSendOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.passwordResetSendOtp(parsed.data.identifier)
    return reply.send(result)
  })
  app.post('/password/reset/send-otp-to-provider', async (request, reply) => {
    const parsed = passwordResetSendOtpToProviderBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.passwordResetSendOtpToProvider(parsed.data.identifier, parsed.data.provider)
    return reply.send(result)
  })
  app.post('/password/reset/verify-otp', async (request, reply) => {
    const parsed = passwordResetVerifyOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.passwordResetVerifyOtp(parsed.data.identifier, parsed.data.provider, parsed.data.otp)
    return reply.send(result)
  })
  app.post('/password/reset/confirm', { preHandler: [authRateLimits.passwordResetConfirm] }, async (request, reply) => {
    const parsed = passwordResetConfirmBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.passwordResetConfirm(parsed.data.resetToken, parsed.data.newPassword)
    return reply.send(result)
  })

  // ----- Phase 4: Settings, password set/change, devices, email/phone bind & modify -----
  app.get('/settings', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const result = await authV2Service.getSettings(userId)
    return reply.send(result)
  })
  app.get('/devices', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const result = await authV2Service.getDevices(userId)
    return reply.send(result)
  })
  app.post('/password/set', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = passwordSetBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.passwordSet(userId, parsed.data.password)
    return reply.send(result)
  })
  app.post('/password/change', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = passwordChangeBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.passwordChange(userId, parsed.data.currentPassword, parsed.data.newPassword, request)
    return reply.send(result)
  })

  app.post('/email/bind/send-otp', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = emailBindSendOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.emailBindSendOtp(userId, parsed.data.newEmail)
    return reply.send(result)
  })
  app.post('/email/bind/verify-otp', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = emailBindVerifyOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message, details: parsed.error.flatten().fieldErrors })
    const result = await authV2Service.emailBindVerifyOtp(userId, parsed.data.newEmail, parsed.data.otp)
    return reply.send(result)
  })
  app.post('/email/modify/verify-old', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = emailModifyVerifyOldBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.emailModifyVerifyOld(userId, parsed.data.currentEmail)
    return reply.send(result)
  })
  app.post('/email/modify/verify-old-otp', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = emailModifyVerifyOldOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.emailModifyVerifyOldOtp(userId, parsed.data.currentEmail, parsed.data.otp)
    return reply.send(result)
  })
  app.post('/email/modify/verify-new', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = emailModifyVerifyNewBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.emailModifyVerifyNew(userId, parsed.data.newEmail, parsed.data.otp)
    return reply.send(result)
  })

  app.post('/phone/bind/send-otp', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = phoneBindSendOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.phoneBindSendOtp(userId, parsed.data.newPhone)
    return reply.send(result)
  })
  app.post('/phone/bind/verify-otp', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = phoneBindVerifyOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.phoneBindVerifyOtp(userId, parsed.data.newPhone, parsed.data.otp)
    return reply.send(result)
  })
  app.post('/phone/modify/verify-old', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = phoneModifyVerifyOldBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.phoneModifyVerifyOld(userId, parsed.data.currentPhone)
    return reply.send(result)
  })
  app.post('/phone/modify/verify-old-otp', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = phoneModifyVerifyOldOtpBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.phoneModifyVerifyOldOtp(userId, parsed.data.currentPhone, parsed.data.otp)
    return reply.send(result)
  })
  app.post('/phone/modify/verify-new', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = phoneModifyVerifyNewBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.phoneModifyVerifyNew(userId, parsed.data.newPhone, parsed.data.otp)
    return reply.send(result)
  })

  // ----- Phase 2 & 5: OAuth login + bind/unbind -----
  app.post('/oauth/google', async (request, reply) => {
    const parsed = oauthGoogleBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.oauthGoogle(parsed.data.idToken, parsed.data.deviceName, parsed.data.deviceId, request)
    return reply.send(result)
  })
  app.post('/oauth/facebook', async (request, reply) => {
    const parsed = oauthFacebookBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.oauthFacebook(parsed.data.accessToken, parsed.data.deviceName, parsed.data.deviceId, request)
    return reply.send(result)
  })
  app.post('/oauth/apple', async (request, reply) => {
    const parsed = oauthAppleBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: parsed.error.errors[0]?.message })
    const result = await authV2Service.oauthApple(parsed.data.identityToken, parsed.data.deviceName, parsed.data.deviceId, request)
    return reply.send(result)
  })
  app.post('/google/bind', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = z.object({ idToken: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: 'idToken required' })
    const result = await authV2Service.googleBind(userId, parsed.data.idToken)
    return reply.send(result)
  })
  app.post('/google/unbind', { preHandler: [authenticate, authRateLimits.providerUnbind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const result = await authV2Service.googleUnbind(userId)
    return reply.send(result)
  })
  app.post('/facebook/bind', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = z.object({ accessToken: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: 'accessToken required' })
    const result = await authV2Service.facebookBind(userId, parsed.data.accessToken)
    return reply.send(result)
  })
  app.post('/facebook/unbind', { preHandler: [authenticate, authRateLimits.providerUnbind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const result = await authV2Service.facebookUnbind(userId)
    return reply.send(result)
  })
  app.post('/apple/bind', { preHandler: [authenticate, authRateLimits.providerBind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const parsed = z.object({ identityToken: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REQUEST', message: 'identityToken required' })
    const result = await authV2Service.appleBind(userId, parsed.data.identityToken)
    return reply.send(result)
  })
  app.post('/apple/unbind', { preHandler: [authenticate, authRateLimits.providerUnbind] }, async (request, reply) => {
    const userId = (request as { userId?: string }).userId
    if (!userId) return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    const result = await authV2Service.appleUnbind(userId)
    return reply.send(result)
  })
}

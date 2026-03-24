import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { securityPasswordRateLimits } from '../../middlewares/rateLimitAuth'
import { securityPasswordService } from '../../services/security-password.service'
import { AppError } from '../../middlewares/errorHandler'
import {
  sendOtpSchema,
  verifyOtpSchema,
  setPasswordSchema,
  changeStartSchema,
  changeSendOtpSchema,
  changeConfirmSchema,
  resetPasswordSchema,
} from '../../models/security-password.schemas'

export default async function securityPasswordRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.get(
    '/identifiers',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.getIdentifiers],
      schema: { tags: ['Security'], description: 'List verified auth identifiers for OTP selection' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const identifiers = await securityPasswordService.getIdentifiers(userId)
      return reply.status(200).send({
        identifiers: identifiers.map((id) => ({
          id: id.id,
          provider: id.provider,
          identifier: id.identifier,
          isVerified: id.isVerified,
          maskedIdentifier: id.maskedIdentifier,
        })),
        count: identifiers.length,
      })
    },
  )

  app.post(
    '/password/send-otp',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.sendOtp],
      schema: { tags: ['Security'], description: 'Send OTP to selected identifier for set/reset' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = sendOtpSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const result = await securityPasswordService.sendOtpForPassword(userId, body.data.identifierId)
      return reply.status(200).send(result)
    },
  )

  app.post(
    '/password/verify-otp',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.verifyOtp],
      schema: { tags: ['Security'], description: 'Verify OTP and get reset token for set password' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = verifyOtpSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const result = await securityPasswordService.verifyOtpForPassword(
        userId,
        body.data.identifierId,
        body.data.otp,
      )
      return reply.status(200).send(result)
    },
  )

  app.post(
    '/password/set',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.set],
      schema: { tags: ['Security'], description: 'Set security password using reset token' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = setPasswordSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const { setAt } = await securityPasswordService.setPassword(
        userId,
        body.data.resetToken,
        body.data.newPassword,
      )
      return reply.status(201).send({
        success: true,
        message: 'Security password set successfully',
        setAt: setAt.toISOString(),
      })
    },
  )

  app.post(
    '/password/change/start',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.changeStart],
      schema: { tags: ['Security'], description: 'Verify current password and start change flow' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = changeStartSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const result = await securityPasswordService.startChangePassword(userId, body.data.currentPassword)
      return reply.status(200).send({
        changeToken: result.changeToken,
        identifiers: result.identifiers.map((id) => ({
          id: id.id,
          provider: id.provider,
          maskedIdentifier: id.maskedIdentifier,
        })),
        expiresIn: result.expiresIn,
      })
    },
  )

  app.post(
    '/password/change/send-otp',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.changeSendOtp],
      schema: { tags: ['Security'], description: 'Send OTP to identifier during password change' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = changeSendOtpSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const result = await securityPasswordService.sendOtpForChange(
        userId,
        body.data.changeToken,
        body.data.identifierId,
      )
      return reply.status(200).send(result)
    },
  )

  app.post(
    '/password/change/confirm',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.changeConfirm],
      schema: { tags: ['Security'], description: 'Verify OTP and set new security password' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = changeConfirmSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const { changedAt } = await securityPasswordService.confirmChangePassword(
        userId,
        body.data.changeToken,
        body.data.otp,
        body.data.newPassword,
      )
      return reply.status(200).send({
        success: true,
        message: 'Security password changed successfully',
        changedAt: changedAt.toISOString(),
      })
    },
  )

  app.post(
    '/password/reset',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.reset],
      schema: { tags: ['Security'], description: 'Reset forgotten security password via OTP' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = resetPasswordSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(400, body.error.errors[0]?.message ?? 'Validation failed', 'INVALID_REQUEST', {
          fieldErrors: body.error.flatten().fieldErrors,
        })
      }
      const result = await securityPasswordService.resetPassword(
        userId,
        body.data.identifierId,
        body.data.otp,
        body.data.newPassword,
      )
      return reply.status(200).send(result)
    },
  )
}

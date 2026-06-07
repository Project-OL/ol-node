import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { securityPasswordRateLimits } from '../../middlewares/rateLimitAuth'
import { securityPasswordService } from '../../services/security-password.service'
import { AppError } from '../../middlewares/errorHandler'
import {
  sendOtpSchema,
  verifyOtpSchema,
  setPinSchema,
  changePinSchema,
  resetPasswordSchema,
} from '../../models/security-password.schemas'

export default async function securityPasswordRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.get(
    '/identifiers',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.getIdentifiers],
      schema: {
        tags: ['Security'],
        description: 'List verified auth identifiers for OTP selection',
      },
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

  app.get(
    '/password/status',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.pinStatus],
      schema: {
        tags: ['Security'],
        description: 'Whether the logged-in user has set a security PIN (password hash present)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const isSet = await securityPasswordService.isSecurityPinSet(userId)
      return reply.status(200).send({ isSet })
    },
  )

  app.post(
    '/password/send-otp',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.sendOtp],
      schema: {
        tags: ['Security'],
        description: 'Send OTP to selected identifier before setting security PIN',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = sendOtpSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          {
            fieldErrors: body.error.flatten().fieldErrors,
          },
        )
      }
      const result = await securityPasswordService.sendOtpForPassword(
        userId,
        body.data.identifierId,
      )
      return reply.status(200).send(result)
    },
  )

  app.post(
    '/password/verify-otp',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.verifyOtp],
      schema: {
        tags: ['Security'],
        description: 'Verify OTP and get reset token for set security PIN',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = verifyOtpSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          {
            fieldErrors: body.error.flatten().fieldErrors,
          },
        )
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
      schema: {
        tags: ['Security'],
        description:
          'Set security PIN using reset token from verify-otp (no password-strength rules on PIN)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = setPinSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          {
            fieldErrors: body.error.flatten().fieldErrors,
          },
        )
      }
      const { setAt } = await securityPasswordService.setPin(
        userId,
        body.data.resetToken,
        body.data.newPin,
      )
      return reply.status(201).send({
        success: true,
        message: 'Security PIN set successfully',
        setAt: setAt.toISOString(),
      })
    },
  )

  app.post(
    '/password/change',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.change],
      schema: {
        tags: ['Security'],
        description: 'Change security PIN using current PIN (single step, no OTP)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = changePinSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          {
            fieldErrors: body.error.flatten().fieldErrors,
          },
        )
      }
      const { changedAt } = await securityPasswordService.changePin(
        userId,
        body.data.currentPin,
        body.data.newPin,
      )
      return reply.status(200).send({
        success: true,
        message: 'Security PIN changed successfully',
        changedAt: changedAt.toISOString(),
      })
    },
  )

  app.post(
    '/password/reset',
    {
      preHandler: [...preAuth, securityPasswordRateLimits.reset],
      schema: { tags: ['Security'], description: 'Reset forgotten security PIN via OTP' },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = resetPasswordSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
          {
            fieldErrors: body.error.flatten().fieldErrors,
          },
        )
      }
      const result = await securityPasswordService.resetPassword(
        userId,
        body.data.identifierId,
        body.data.otp,
        body.data.newPin,
      )
      return reply.status(200).send(result)
    },
  )
}

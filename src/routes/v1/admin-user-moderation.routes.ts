import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminDeviceBanBodySchema,
  adminFaceRevokeBodySchema,
  adminPasswordResetBodySchema,
} from '../../models/admin-user-moderation.schemas'
import { adminUserModerationService } from '../../services/adminUserModeration.service'

const preAuth = [authenticateAdmin]

export default async function adminUserModerationRoutes(app: FastifyInstance) {
  app.post<{ Params: { userId: string } }>(
    '/users/:userId/password/reset',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Reset user login password and revoke all sessions. Returns generated password when `newPassword` omitted.',
      },
    },
    async (request, reply) => {
      const parsed = adminPasswordResetBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminUserModerationService.resetPassword({
          targetUserId: request.params.userId,
          adminUserId: request.adminUser!.id,
          newPassword: parsed.data.newPassword,
        }),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/face-verification',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Face verification'],
        description: 'Face verification status for a user (profile + KYC + isFaceVerified).',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminUserModerationService.getFaceVerificationStatus(request.params.userId),
      )
    },
  )

  app.delete<{ Params: { userId: string } }>(
    '/users/:userId/face-verification',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Face verification'],
        description: 'Revoke face profile and remove from Rekognition collection.',
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const parsed = adminFaceRevokeBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminUserModerationService.revokeFaceVerification({
          targetUserId: request.params.userId,
          adminUserId: request.adminUser!.id,
          reason: parsed.data.reason,
          revokeRelated: parsed.data.revokeRelated,
        }),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/profile/remove-avatar',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users'] } },
    async (request, reply) => {
      return reply.send(
        await adminUserModerationService.removeAvatar(request.params.userId, request.adminUser!.id),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/profile/remove-bio',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users'] } },
    async (request, reply) => {
      return reply.send(
        await adminUserModerationService.removeBio(request.params.userId, request.adminUser!.id),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/profile/reset-identity',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description: 'Clear first/last name and set username to `user_{publicId}`.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminUserModerationService.resetDisplayIdentity(
          request.params.userId,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/agency/remove',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Agency'] } },
    async (request, reply) => {
      return reply.send(
        await adminUserModerationService.removeFromAgency(
          request.params.userId,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/devices',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Devices'] } },
    async (request, reply) => {
      return reply.send(await adminUserModerationService.listUserDevices(request.params.userId))
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/devices/ban',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Devices'],
        description: 'Ban one device (`deviceId`) or all devices linked to the user.',
      },
    },
    async (request, reply) => {
      const parsed = adminDeviceBanBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminUserModerationService.banUserDevices({
          userId: request.params.userId,
          adminUserId: request.adminUser!.id,
          deviceId: parsed.data.deviceId,
          reason: parsed.data.reason,
        }),
      )
    },
  )

  app.delete<{ Params: { deviceId: string } }>(
    '/devices/:deviceId/ban',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Devices'] } },
    async (request, reply) => {
      return reply.send(
        await adminUserModerationService.unbanDevice(
          request.params.deviceId,
          request.adminUser!.id,
        ),
      )
    },
  )
}

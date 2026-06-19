import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticate, authenticateOptional } from '../../middlewares/auth.middleware'
import { deviceRateLimits } from '../../middlewares/rateLimitAuth'
import {
  getDevicesSchema,
  revokeDeviceParamsSchema,
  logoutAllSchema,
  flushDeviceSessionsSchema,
  renameDeviceSchema,
  renameDeviceParamsSchema,
} from '../../models/device.schemas'
import { deviceService } from '../../services/device.service'
import { AppError } from '../../middlewares/errorHandler'
import { unlinkDeviceAccountParamsSchema } from '../../models/schemas'

/** Path uses `registryId`; query `deviceId` is a deprecated alias (same UUID). */
function resolveRegistryIdFromRequest(request: FastifyRequest): string {
  const p = request.params as { registryId?: string }
  const q = request.query as { deviceId?: string; registryId?: string }
  return (p.registryId ?? q.registryId ?? q.deviceId ?? '').trim()
}

export default async function deviceRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  app.get(
    '/',
    {
      preHandler: [...preAuth, deviceRateLimits.list],
      schema: {
        tags: ['Devices'],
        description: 'List all active devices for the current user',
        querystring: {
          type: 'object',
          properties: {
            sortBy: { type: 'string', enum: ['lastActive', 'loginTime', 'name'] },
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const currentDeviceId = request.deviceId
      const parsed = getDevicesSchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      const query = parsed.data

      const devices = await deviceService.getDevices(userId, currentDeviceId)

      const sorted = [...devices]
      if (query.sortBy === 'loginTime') {
        sorted.sort((a, b) => b.loginAt.getTime() - a.loginAt.getTime())
      } else if (query.sortBy === 'name') {
        sorted.sort((a, b) => a.deviceName.localeCompare(b.deviceName))
      }

      const page = query.page ?? 1
      const limit = query.limit ?? 20
      const start = (page - 1) * limit
      const paged = sorted.slice(start, start + limit)

      return reply.status(200).send({
        data: {
          devices: paged.map((d) => ({
            ...d,
            lastActiveAt: d.lastActiveAt.toISOString(),
            loginAt: d.loginAt.toISOString(),
          })),
          totalDevices: devices.length,
          currentDeviceId: currentDeviceId ?? null,
        },
      })
    },
  )

  app.post(
    '/logout-all',
    {
      preHandler: [...preAuth, deviceRateLimits.logoutAll],
      schema: {
        tags: ['Devices'],
        description: 'Logout from all other devices (requires security password)',
        body: {
          type: 'object',
          required: ['securityPassword'],
          properties: { securityPassword: { type: 'string' } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const currentDeviceId = request.deviceId
      const body = logoutAllSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
        )
      }

      const result = await deviceService.logoutAllOtherDevices(
        userId,
        body.data.securityPassword,
        currentDeviceId ?? '',
      )
      return reply.status(200).send({
        data: {
          ...result,
          message: 'Logged out from all other devices',
        },
      })
    },
  )

  app.post(
    '/flush-sessions',
    {
      preHandler: [authenticateOptional, deviceRateLimits.flushSessions],
      schema: {
        tags: ['Devices'],
        description:
          'Revoke all active sessions and linked accounts on a physical device. JWT optional (factory reset); when present, deviceId must match JWT and deviceName must match caller session.',
        body: {
          type: 'object',
          required: ['deviceId'],
          properties: {
            deviceId: { type: 'string', minLength: 1, maxLength: 255 },
            deviceName: { type: 'string', minLength: 1, maxLength: 255 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = flushDeviceSessionsSchema.safeParse(request.body)
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
        )
      }

      const authContext =
        request.userId && request.deviceId
          ? { requestingUserId: request.userId, jwtDeviceId: request.deviceId }
          : undefined

      const result = await deviceService.flushDeviceSessions(
        body.data.deviceId,
        body.data.deviceName,
        authContext,
      )
      return reply.status(200).send({
        data: {
          ...result,
          message: 'All sessions and linked accounts removed from this device',
        },
      })
    },
  )

  app.get(
    '/linked-accounts',
    {
      preHandler: [...preAuth, deviceRateLimits.list],
      schema: {
        tags: ['Devices'],
        description:
          'List accounts with an active session on the current device (from JWT deviceId)',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const deviceId = request.deviceId
      if (!deviceId) {
        throw new AppError(400, 'Missing device identifier', 'DEVICE_ID_REQUIRED')
      }
      const accounts = await deviceService.getLinkedAccounts(deviceId)
      return reply.status(200).send({ accounts })
    },
  )

  app.delete<{ Params: { targetUserId: string } }>(
    '/linked-accounts/:targetUserId',
    {
      preHandler: [...preAuth, deviceRateLimits.revoke],
      schema: {
        tags: ['Devices'],
        description: 'Unlink an account from the current device',
        params: {
          type: 'object',
          required: ['targetUserId'],
          properties: { targetUserId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { targetUserId: string } }>, reply: FastifyReply) => {
      const deviceId = request.deviceId
      const requestingUserId = request.userId
      if (!deviceId || !requestingUserId) {
        throw new AppError(400, 'Missing device or user context', 'INVALID_REQUEST')
      }

      const params = unlinkDeviceAccountParamsSchema.safeParse(request.params)
      if (!params.success) {
        throw new AppError(
          400,
          params.error.errors[0]?.message ?? 'Invalid target user id',
          'INVALID_REQUEST',
        )
      }

      await deviceService.unlinkAccountFromDevice(
        deviceId,
        params.data.targetUserId,
        requestingUserId,
        {
          request: {
            ip: request.ip,
            headers: request.headers as Record<string, string | undefined>,
          },
        },
      )

      return reply.status(204).send()
    },
  )

  app.put<{ Params: { registryId: string }; Body: { deviceName: string } }>(
    '/:registryId/name',
    {
      preHandler: [...preAuth, deviceRateLimits.rename],
      schema: {
        tags: ['Devices'],
        description: 'Rename a device (registry row id in path; optional query deviceId as alias)',
        params: {
          type: 'object',
          required: ['registryId'],
          properties: { registryId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['deviceName'],
          properties: { deviceName: { type: 'string', minLength: 1, maxLength: 50 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { registryId: string }; Body: { deviceName: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const mergedParams = {
        registryId: resolveRegistryIdFromRequest(request) || request.params.registryId,
      }
      const params = renameDeviceParamsSchema.safeParse(mergedParams)
      const body = renameDeviceSchema.safeParse(request.body)
      if (!params.success) {
        throw new AppError(
          400,
          params.error.errors[0]?.message ?? 'Invalid registry id',
          'INVALID_REQUEST',
        )
      }
      if (!body.success) {
        throw new AppError(
          400,
          body.error.errors[0]?.message ?? 'Validation failed',
          'INVALID_REQUEST',
        )
      }

      const result = await deviceService.renameDevice(
        userId,
        params.data.registryId,
        body.data.deviceName,
      )
      return reply.status(200).send({
        data: {
          ...result,
          updatedAt: result.updatedAt.toISOString(),
        },
      })
    },
  )

  app.delete<{ Params: { registryId: string } }>(
    '/:registryId',
    {
      preHandler: [...preAuth, deviceRateLimits.revoke],
      schema: {
        tags: ['Devices'],
        description:
          'Revoke sessions for a device registry row (`device_registry.id`). Optional query `deviceId` = same UUID (deprecated name).',
        params: {
          type: 'object',
          required: ['registryId'],
          properties: { registryId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { registryId: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      const currentDeviceId = request.deviceId
      const mergedParams = {
        registryId: resolveRegistryIdFromRequest(request) || request.params.registryId,
      }
      const params = revokeDeviceParamsSchema.safeParse(mergedParams)
      if (!params.success) {
        throw new AppError(
          400,
          params.error.errors[0]?.message ?? 'Invalid registry id',
          'INVALID_REQUEST',
        )
      }

      const result = await deviceService.revokeDevice(
        userId,
        params.data.registryId,
        currentDeviceId ?? '',
      )
      return reply.status(200).send({
        data: {
          ...result,
          message: 'Device revoked successfully',
        },
      })
    },
  )
}

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { deviceRateLimits } from '../../middlewares/rateLimitAuth'
import {
  getDevicesSchema,
  revokeDeviceParamsSchema,
  logoutAllSchema,
  renameDeviceSchema,
  renameDeviceParamsSchema,
} from '../../models/device.schemas'
import { deviceService } from '../../services/device.service'
import { AppError } from '../../middlewares/errorHandler'
import { unlinkDeviceAccountParamsSchema } from '../../models/schemas'

export default async function deviceRoutes(app: FastifyInstance) {
  const preAuth = [authenticate]

  // GET /api/v1/devices
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
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
      }
      const query = parsed.data

      const devices = await deviceService.getDevices(userId, currentDeviceId)

      let sorted = [...devices]
      if (query.sortBy === 'loginTime') {
        sorted.sort((a, b) => b.loginAt.getTime() - a.loginAt.getTime())
      } else if (query.sortBy === 'name') {
        sorted.sort((a, b) => a.deviceName.localeCompare(b.deviceName))
      }
      // default lastActive: already from DB order

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

  // DELETE /api/v1/devices/:deviceId (deviceId = registry id UUID)
  app.delete<{ Params: { deviceId: string } }>(
    '/:deviceId',
    {
      preHandler: [...preAuth, deviceRateLimits.revoke],
      schema: {
        tags: ['Devices'],
        description: 'Revoke a specific device (logout from that device)',
        params: {
          type: 'object',
          required: ['deviceId'],
          properties: { deviceId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { deviceId: string } }>, reply: FastifyReply) => {
      const userId = request.userId!
      const currentDeviceId = request.deviceId
      const params = revokeDeviceParamsSchema.safeParse(request.params)
      if (!params.success) {
        throw new AppError(400, params.error.errors[0]?.message ?? 'Invalid device id', 'INVALID_REQUEST')
      }

      const result = await deviceService.revokeDevice(
        userId,
        params.data.deviceId,
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

  // POST /api/v1/devices/logout-all (must be before /:deviceId/name to avoid "logout-all" as param)
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

  // PUT /api/v1/devices/:deviceId/name
  app.put<{ Params: { deviceId: string }; Body: { deviceName: string } }>(
    '/:deviceId/name',
    {
      preHandler: [...preAuth, deviceRateLimits.rename],
      schema: {
        tags: ['Devices'],
        description: 'Rename a device',
        params: {
          type: 'object',
          required: ['deviceId'],
          properties: { deviceId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['deviceName'],
          properties: { deviceName: { type: 'string', minLength: 1, maxLength: 50 } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { deviceId: string }; Body: { deviceName: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!
      const params = renameDeviceParamsSchema.safeParse(request.params)
      const body = renameDeviceSchema.safeParse(request.body)
      if (!params.success) {
        throw new AppError(400, params.error.errors[0]?.message ?? 'Invalid device id', 'INVALID_REQUEST')
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
        params.data.deviceId,
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

  app.get(
    '/linked-accounts',
    {
      preHandler: [...preAuth, deviceRateLimits.list],
      schema: {
        tags: ['Devices'],
        description: 'List accounts linked to the current device',
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
    async (
      request: FastifyRequest<{ Params: { targetUserId: string } }>,
      reply: FastifyReply,
    ) => {
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
}

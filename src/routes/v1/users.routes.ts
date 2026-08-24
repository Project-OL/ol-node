import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { authenticate } from '../../middlewares/auth.middleware'
import { searchQuerySchema } from '../../models/schemas'
import { userSearchService } from '../../services/userSearch.service'
import { meService } from '../../services/me.service'
import { followService } from '../../services/follow.service'
import { userRepository } from '../../repositories/user.repository'
import { visitorRepository } from '../../repositories/visitor.repository'
import { AppError } from '../../middlewares/errorHandler'
import { env } from '../../config/env'
import { subscriptionService } from '../../services/subscription.service'
import { setPresenceBodySchema, bulkPresenceBodySchema } from '../../models/presence.schemas'
import { presenceService } from '../../services/presence.service'
import { updateAcceptVideoCallsSchema } from '../../models/call.schemas'
import { videoCallSettingsService } from '../../services/video-call.service'
import { SetFcmTokenSchema } from '../../models/push-notification.schemas'
import { userRestrictionService } from '../../services/userRestriction.service'
import { userLocationService } from '../../services/userLocation.service'
import {
  locationHistoryQuerySchema,
  reportLocationBodySchema,
} from '../../models/user-location.schemas'

const PATCH_ME_ALLOWED_FIELDS = new Set(['name', 'dob', 'bio'])

export default async function usersRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: { fileSize: env.MAX_AVATAR_SIZE_BYTES },
  })

  app.get(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description: 'Current user profile (Redis-backed cache)',
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const started = Date.now()
      const { data, cache } = await meService.getMe(userId)
      reply.header('X-Cache', cache)
      request.log.info({
        userId,
        endpoint: 'GET /users/me',
        cacheResult: cache,
        latencyMs: Date.now() - started,
      })
      return reply.status(200).send(data)
    },
  )

  app.get(
    '/me/restrictions',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Active timed moderation restrictions for the caller (messaging ban — global or targeted, live chat/audio mute, live-start ban).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await userRestrictionService.listActiveForUser(request.userId!))
    },
  )

  app.put(
    '/me/location',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users', 'Location'],
        description:
          'Report / refresh GPS location when available (e.g. GPS switched on). Updates current location and appends a history sample.',
        body: {
          type: 'object',
          required: ['latitude', 'longitude'],
          properties: {
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            accuracyM: { type: 'number' },
            source: { type: 'string' },
            recordedAt: { type: 'string' },
          },
        },
      },
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = reportLocationBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await userLocationService.reportLocation(request.userId!, parsed.data))
    },
  )

  app.get(
    '/me/location',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users', 'Location'],
        description: 'Current (latest) GPS location for the caller.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await userLocationService.getCurrent(request.userId!))
    },
  )

  app.get(
    '/me/locations',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users', 'Location'],
        description: 'GPS location history samples for the caller (newest first).',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = locationHistoryQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await userLocationService.listHistory(request.userId!, {
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        }),
      )
    },
  )

  app.put(
    '/me/presence',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Set online presence from HTTP (mobile foreground). `online: true` refreshes Redis online key (~60s TTL) and last-active; `online: false` clears online immediately.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = setPresenceBodySchema.parse(request.body ?? {})
      if (body.online) {
        await presenceService.setUserOnline(userId)
      } else {
        await presenceService.setUserOffline(userId)
      }
      return reply.send({ ok: true, online: body.online })
    },
  )

  app.put(
    '/me/video-calls',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Global video-call availability toggle. `acceptVideoCalls: false` means the user does not want to receive video calls right now. Also returned on GET /users/me and GET /call/settings.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const body = updateAcceptVideoCallsSchema.parse(request.body ?? {})
      const updated = await videoCallSettingsService.setAcceptVideoCalls(
        userId,
        body.acceptVideoCalls,
      )
      return reply.send({ acceptVideoCalls: updated.acceptVideoCalls })
    },
  )

  app.post(
    '/presence/bulk',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Batch presence lookup for up to 100 user UUIDs. Returns isOnline and last-online (seconds/minutes/hours label) when offline.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const viewerId = request.userId!
      const body = bulkPresenceBodySchema.parse(request.body ?? {})
      const map = await presenceService.getPublicPresenceForUsers(viewerId, body.userIds)
      const items = body.userIds.map((id) => map.get(id)!)
      return reply.send({ items })
    },
  )

  app.patch(
    '/me',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Update profile (multipart): optional fields name, dob (YYYY-MM-DD or empty to clear), bio; optional file avatar (JPEG/PNG/WEBP, max 5MB). Returns fresh profile + new access token.',
        consumes: ['multipart/form-data'],
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!
      const fields: Record<string, string> = {}
      let avatarBuf: Buffer | null = null
      const started = Date.now()
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'avatar') {
              part.file.resume()
              throw new AppError(400, 'Unexpected file field', 'INVALID_REQUEST')
            }
            const chunks: Buffer[] = []
            for await (const ch of part.file) {
              chunks.push(ch as Buffer)
            }
            avatarBuf = Buffer.concat(chunks)
          } else {
            if (!PATCH_ME_ALLOWED_FIELDS.has(part.fieldname)) {
              throw new AppError(400, `Unexpected field: ${part.fieldname}`, 'INVALID_REQUEST')
            }
            fields[part.fieldname] = String(part.value ?? '')
          }
        }
      } catch (e: unknown) {
        const err = e as { code?: string }
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new AppError(413, 'Avatar exceeds maximum size', 'FILE_TOO_LARGE', {
            maxBytes: env.MAX_AVATAR_SIZE_BYTES,
          })
        }
        throw e
      }

      const jwtPayload = request.user as {
        deviceId?: string
        sessionId?: string
        tokenVersion?: number
        sessionTokenVersion?: number
      }
      const result = await meService.patchMe(
        userId,
        {
          name: fields.name !== undefined && fields.name !== '' ? fields.name : undefined,
          dob: fields.dob !== undefined ? fields.dob : undefined,
          bio: fields.bio !== undefined ? fields.bio : undefined,
        },
        avatarBuf,
        {
          deviceId: jwtPayload.deviceId,
          sessionId: jwtPayload.sessionId,
          tokenVersion: jwtPayload.tokenVersion,
          sessionTokenVersion: jwtPayload.sessionTokenVersion,
        },
      )
      request.log.info({
        userId,
        endpoint: 'PATCH /users/me',
        latencyMs: Date.now() - started,
        statusCode: 200,
      })
      return reply.status(200).send(result)
    },
  )

  app.put<{ Body: unknown }>(
    '/me/fcm-token',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          "Register/update the caller's FCM push token (per-user, single token — a new device login overwrites it)",
      },
    },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const userId = request.userId!
      const parsed = SetFcmTokenSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid request body',
          'INVALID_REQUEST',
        )
      }
      await userRepository.updateFcmToken(userId, parsed.data.token)
      return reply.send({ success: true })
    },
  )

  app.get<{ Params: { publicId: string } }>(
    '/resolve/:publicId',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Resolve user identity by any visible numeric public id (base, default, or VIP overlay). Returns compact identity fields.',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const resolved = await userSearchService.resolvePublicIdentity(
        request.params.publicId,
        request.userId!,
      )
      if (!resolved) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      return reply.status(200).send(resolved)
    },
  )

  app.get<{ Params: { publicId: string } }>(
    '/:publicId/presence',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description: 'Online status and last-seen for a user by public id.',
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const identity = await userSearchService.resolvePublicIdentity(request.params.publicId)
      if (!identity) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      const presence = await presenceService.getPublicPresenceForUser(
        request.userId!,
        identity.userId,
      )
      return reply.send(presence)
    },
  )

  app.get<{ Params: { publicId: string } }>(
    '/:publicId/subscription-stats',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Paid subscriber count for a creator (by publicId). Cached ~5m in Redis for display.',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const numericId = Number(request.params.publicId)
      if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
      }
      const subscriberCount =
        await subscriptionService.getActiveSubscriberCountByPublicId(numericId)
      return reply.status(200).send({
        publicId: String(numericId),
        subscriberCount,
      })
    },
  )

  app.get<{ Params: { publicId: string } }>(
    '/:publicId/social',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Get social counts (followers, following, friends, visitors) for a user by publicId.',
        params: {
          type: 'object',
          required: ['publicId'],
          properties: { publicId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const numericId = Number(request.params.publicId)
      if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
      }
      const targetUser = await userRepository.findByPublicId(numericId)
      if (!targetUser) {
        throw new AppError(404, 'User not found', 'NOT_FOUND')
      }

      const [counts, visitors] = await Promise.all([
        followService.getCounts(targetUser.id),
        visitorRepository.countVisitors(targetUser.id),
      ])

      return reply.status(200).send({
        publicId: String(targetUser.publicId),
        followers: counts.followers,
        following: counts.following,
        friends: counts.friends,
        visitors,
      })
    },
  )

  app.get(
    '/search',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description:
          'Search user by publicId. User card includes profile bio, levels, follow state, blockedByMe, userBlockedMe, and composed adminTags.',
        querystring: {
          type: 'object',
          required: ['publicId'],
          properties: {
            publicId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requesterId = request.userId!
      const parsed = searchQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid search query',
          'INVALID_REQUEST',
        )
      }
      const user = await userSearchService.searchByPublicId(parsed.data.publicId, requesterId)
      if (!user) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      return reply.status(200).send({ user })
    },
  )
}

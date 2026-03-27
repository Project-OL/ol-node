import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { authenticate } from '../../middlewares/auth.middleware'
import { searchQuerySchema } from '../../models/schemas'
import { userSearchService } from '../../services/userSearch.service'
import { meService } from '../../services/me.service'
import { AppError } from '../../middlewares/errorHandler'
import { env } from '../../config/env'

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
              throw new AppError(
                400,
                `Unexpected field: ${part.fieldname}`,
                'INVALID_REQUEST',
              )
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

      const jwtPayload = request.user as { deviceId?: string }
      const result = await meService.patchMe(
        userId,
        {
          name: fields.name !== undefined && fields.name !== '' ? fields.name : undefined,
          dob: fields.dob !== undefined ? fields.dob : undefined,
          bio: fields.bio !== undefined ? fields.bio : undefined,
        },
        avatarBuf,
        { deviceId: jwtPayload.deviceId },
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

  app.get(
    '/search',
    {
      preHandler: [authenticate],
      schema: {
        tags: ['Users'],
        description: 'Search user by publicId',
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
      const user = await userSearchService.searchByPublicId(
        parsed.data.publicId,
        requesterId,
      )
      if (!user) {
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      return reply.status(200).send({ user })
    },
  )
}


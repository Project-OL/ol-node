import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { StoreItemCategory } from '@prisma/client'
import { AppError } from '../../middlewares/errorHandler'
import { authenticate } from '../../middlewares/auth.middleware'
import {
  storePurchaseRateLimit,
  storeRareIdPurchaseRateLimit,
} from '../../middlewares/rateLimitAuth'
import { storeService } from '../../services/store.service'
import { userRepository } from '../../repositories/user.repository'

const CategorySchema = z.nativeEnum(StoreItemCategory)

export default async function storeRoutes(app: FastifyInstance) {
  app.get('/catalog', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await storeService.getCatalog())
  })

  app.get<{ Params: { category: string } }>(
    '/catalog/:category',
    async (request: FastifyRequest<{ Params: { category: string } }>, reply: FastifyReply) => {
      const parsed = CategorySchema.safeParse(request.params.category)
      if (!parsed.success) throw new AppError(400, 'Invalid category', 'INVALID_CATEGORY')
      return reply.send(await storeService.getCatalog(parsed.data))
    },
  )

  app.get<{ Params: { itemId: string } }>(
    '/items/:itemId',
    async (request: FastifyRequest<{ Params: { itemId: string } }>, reply: FastifyReply) => {
      return reply.send(await storeService.getItemDetail(request.params.itemId))
    },
  )

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/rare-ids',
    async (
      request: FastifyRequest<{ Querystring: { cursor?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const limit = request.query.limit ? Number(request.query.limit) : 20
      return reply.send(await storeService.getRareIds(request.query.cursor, limit))
    },
  )

  app.post(
    '/purchase',
    { preHandler: [authenticate, storePurchaseRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodySchema = z
        .object({
          storeItemId: z.string().uuid(),
          /** Preferred recipient selector for gifting. */
          recipientUserId: z.string().uuid().optional(),
          /** Backward-compatible recipient selector by public ID. */
          recipientPublicId: z.number().int().positive().optional(),
          idempotencyKey: z.string().min(8).max(200),
        })
        .refine(
          (v) => !(v.recipientUserId !== undefined && v.recipientPublicId !== undefined),
          'Provide either recipientUserId or recipientPublicId, not both',
        )
      const parsed = bodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
      }
      const buyerId = request.userId
      if (!buyerId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')

      let recipientId = buyerId
      if (parsed.data.recipientUserId !== undefined) {
        const recipient = await userRepository.findById(parsed.data.recipientUserId)
        if (!recipient) throw new AppError(404, 'Recipient not found', 'RECIPIENT_NOT_FOUND')
        recipientId = recipient.id
      } else if (parsed.data.recipientPublicId !== undefined) {
        const recipient = await userRepository.findByPublicId(parsed.data.recipientPublicId)
        if (!recipient) throw new AppError(404, 'Recipient not found', 'RECIPIENT_NOT_FOUND')
        recipientId = recipient.id
      }

      const result = await storeService.purchaseItem({
        buyerId,
        storeItemId: parsed.data.storeItemId,
        recipientId,
        idempotencyKey: parsed.data.idempotencyKey,
      })
      return reply.status(201).send(result)
    },
  )

  app.post(
    '/rare-ids/purchase',
    { preHandler: [authenticate, storeRareIdPurchaseRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const bodySchema = z.object({
        publicId: z.string().regex(/^\d+$/, 'publicId must be numeric'),
        recipientPublicId: z.number().int().positive().optional(),
        idempotencyKey: z.string().min(8).max(200),
      })
      const parsed = bodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
      }
      const buyerId = request.userId
      if (!buyerId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')

      let recipientId = buyerId
      if (parsed.data.recipientPublicId !== undefined) {
        const recipient = await userRepository.findByPublicId(parsed.data.recipientPublicId)
        if (!recipient) throw new AppError(404, 'Recipient not found', 'RECIPIENT_NOT_FOUND')
        recipientId = recipient.id
      }

      const result = await storeService.purchaseRareId({
        buyerId,
        publicId: BigInt(parsed.data.publicId),
        recipientId,
        idempotencyKey: parsed.data.idempotencyKey,
      })
      return reply.status(201).send(result)
    },
  )

  app.post<{ Params: { userStoreItemId: string } }>(
    '/activate/:userStoreItemId',
    { preHandler: [authenticate] },
    async (
      request: FastifyRequest<{ Params: { userStoreItemId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      await storeService.activateOwnedItem(userId, request.params.userStoreItemId)
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { userStoreItemId: string } }>(
    '/deactivate/:userStoreItemId',
    { preHandler: [authenticate] },
    async (
      request: FastifyRequest<{ Params: { userStoreItemId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      await storeService.deactivateOwnedItem(userId, request.params.userStoreItemId)
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { assignmentId: string } }>(
    '/rare-ids/activate/:assignmentId',
    { preHandler: [authenticate] },
    async (
      request: FastifyRequest<{ Params: { assignmentId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      await storeService.activateOwnedRarePublicId(userId, request.params.assignmentId)
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { assignmentId: string } }>(
    '/rare-ids/deactivate/:assignmentId',
    { preHandler: [authenticate] },
    async (
      request: FastifyRequest<{ Params: { assignmentId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      await storeService.deactivateOwnedRarePublicId(userId, request.params.assignmentId)
      return reply.status(204).send()
    },
  )

  app.get<{ Querystring: { category?: string; isActive?: string; cursor?: string; limit?: string } }>(
    '/my-items',
    { preHandler: [authenticate] },
    async (
      request: FastifyRequest<{
        Querystring: { category?: string; isActive?: string; cursor?: string; limit?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      let category: StoreItemCategory | undefined
      if (request.query.category) {
        const parsedCategory = CategorySchema.safeParse(request.query.category)
        if (!parsedCategory.success) {
          throw new AppError(400, 'Invalid category', 'INVALID_CATEGORY')
        }
        category = parsedCategory.data
      }
      const isActive =
        request.query.isActive === undefined ? undefined : request.query.isActive === 'true'
      const limit = request.query.limit ? Number(request.query.limit) : undefined
      return reply.send(
        await storeService.listOwnedItems(userId, {
          category,
          isActive,
          cursor: request.query.cursor,
          limit,
        }),
      )
    },
  )

  app.get<{ Params: { publicId: string } }>(
    '/users/:publicId/active',
    async (request: FastifyRequest<{ Params: { publicId: string } }>, reply: FastifyReply) => {
      const numericId = Number(request.params.publicId)
      if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
      }
      const user = await userRepository.findByPublicId(numericId)
      if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      return reply.send(await storeService.getActiveItemsForUser(user.id))
    },
  )

  app.get<{
    Params: { publicId: string }
    Querystring: { category?: string; isActive?: string; cursor?: string; limit?: string }
  }>(
    '/users/:publicId/items',
    { preHandler: [authenticate] },
    async (
      request: FastifyRequest<{
        Params: { publicId: string }
        Querystring: { category?: string; isActive?: string; cursor?: string; limit?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const numericId = Number(request.params.publicId)
      if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
      }
      const user = await userRepository.findByPublicId(numericId)
      if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

      let category: StoreItemCategory | undefined
      if (request.query.category) {
        const parsedCategory = CategorySchema.safeParse(request.query.category)
        if (!parsedCategory.success) {
          throw new AppError(400, 'Invalid category', 'INVALID_CATEGORY')
        }
        category = parsedCategory.data
      }
      const isActive =
        request.query.isActive === undefined ? undefined : request.query.isActive === 'true'
      const limit = request.query.limit ? Number(request.query.limit) : undefined
      return reply.send(
        await storeService.listOwnedItems(user.id, {
          category,
          isActive,
          cursor: request.query.cursor,
          limit,
        }),
      )
    },
  )
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { giftSendRateLimit } from '../../middlewares/rateLimitAuth'
import {
  CreateGiftBodySchema,
  PatchGiftBodySchema,
  GiftListQuerySchema,
  SendGiftBodySchema,
} from '../../models/gift.schemas'
import { giftService } from '../../services/gift.service'
import { giftTransactionService } from '../../services/gift-transaction.service'

export default async function giftRoutes(app: FastifyInstance) {
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = GiftListQuerySchema.parse(request.query)
    const result = await giftService.listPublic(q)
    return reply.send(result)
  })

  app.post(
    '/',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateGiftBodySchema.parse(request.body)
      const g = await giftService.create(body)
      return reply.status(201).send({ gift: g })
    },
  )

  app.patch(
    '/:giftId',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const giftId = (request.params as { giftId: string }).giftId
      const body = PatchGiftBodySchema.parse(request.body)
      const g = await giftService.patch(giftId, body)
      return reply.send({ gift: g })
    },
  )

  app.delete(
    '/:giftId',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const giftId = (request.params as { giftId: string }).giftId
      const g = await giftService.softDelete(giftId)
      return reply.send({ gift: g })
    },
  )

  app.post(
    '/send',
    { preHandler: [authenticate, giftSendRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = SendGiftBodySchema.parse(request.body)
      const result = await giftTransactionService.sendGift({
        senderUserId: request.userId!,
        receiverUserId: body.receiverUserId,
        giftId: body.giftId,
        context: body.context,
      })
      return reply.status(201).send(result)
    },
  )
}

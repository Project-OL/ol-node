import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { parseRequest } from '../../utils/zod-request'
import {
  CreateCustomGiftRequestBodySchema,
  MyCustomGiftRequestsQuerySchema,
} from '../../models/custom-gift.schemas'
import { customGiftService } from '../../services/customGift.service'

export default async function customGiftRoutes(app: FastifyInstance) {
  /** What a custom gift request costs (coins) and whether the feature is on. */
  app.get(
    '/config',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const config = await customGiftService.getConfig()
      return reply.send(config)
    },
  )

  /**
   * Raise a custom gift request: debits the configured coin cost immediately;
   * a CS agent then contacts the given WhatsApp number. 409 while a PENDING
   * request already exists.
   */
  app.post(
    '/requests',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseRequest(CreateCustomGiftRequestBodySchema, request.body ?? {})
      const data = await customGiftService.createRequest(request.userId!, body)
      return reply.status(201).send({ request: data })
    },
  )

  /** The caller's requests, newest first, with status / failure reason / linked gift. */
  app.get(
    '/requests',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(MyCustomGiftRequestsQuerySchema, request.query ?? {})
      const data = await customGiftService.listMyRequests(request.userId!, query)
      return reply.send(data)
    },
  )
}

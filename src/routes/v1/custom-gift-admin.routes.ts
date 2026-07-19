import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import {
  AdminCustomGiftRequestListQuerySchema,
  CompleteCustomGiftRequestBodySchema,
  FailCustomGiftRequestBodySchema,
  UpdateCustomGiftConfigBodySchema,
} from '../../models/custom-gift.schemas'
import { customGiftAdminService } from '../../services/customGiftAdmin.service'

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

export default async function customGiftAdminRoutes(app: FastifyInstance) {
  app.get(
    '/custom-gifts/config',
    { preHandler: preAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const config = await customGiftAdminService.getConfig()
      return reply.send(config)
    },
  )

  app.put(
    '/custom-gifts/config',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseRequest(UpdateCustomGiftConfigBodySchema, request.body ?? {})
      const config = await customGiftAdminService.updateConfig(body, request.adminUser!.id)
      return reply.send(config)
    },
  )

  app.get(
    '/custom-gifts/requests',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(AdminCustomGiftRequestListQuerySchema, request.query ?? {})
      const data = await customGiftAdminService.listRequests(query)
      return reply.send(data)
    },
  )

  app.get(
    '/custom-gifts/requests/:requestId',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string }
      const data = await customGiftAdminService.getRequest(requestId)
      return reply.send({ request: data })
    },
  )

  app.post(
    '/custom-gifts/requests/:requestId/complete',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string }
      const body = parseRequest(CompleteCustomGiftRequestBodySchema, request.body ?? {})
      const data = await customGiftAdminService.completeRequest(
        requestId,
        body,
        request.adminUser!.id,
      )
      return reply.send({ request: data })
    },
  )

  app.post(
    '/custom-gifts/requests/:requestId/fail',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string }
      const body = parseRequest(FailCustomGiftRequestBodySchema, request.body ?? {})
      const data = await customGiftAdminService.failRequest(requestId, body, request.adminUser!.id)
      return reply.send({ request: data })
    },
  )
}

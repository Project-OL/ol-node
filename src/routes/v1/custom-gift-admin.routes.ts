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

const customGiftPackageSchema = {
  type: 'object',
  required: ['durationMonths', 'validityDays', 'coinCost', 'label'],
  properties: {
    durationMonths: { type: 'integer', enum: [1, 3] },
    validityDays: { type: 'integer' },
    coinCost: { type: 'string', description: 'Decimal string (BigInt-safe)' },
    label: { type: 'string' },
  },
} as const

const customGiftConfigResponseSchema = {
  type: 'object',
  required: [
    'coinCost',
    'coinCost1Month',
    'coinCost3Months',
    'enabled',
    'description',
    'packages',
    'updatedAt',
    'updatedByAdminId',
  ],
  properties: {
    coinCost: {
      type: 'string',
      description: 'Legacy alias — same as 1-month package coinCost',
    },
    coinCost1Month: { type: 'string' },
    coinCost3Months: { type: 'string' },
    enabled: { type: 'boolean' },
    description: { type: ['string', 'null'] },
    packages: {
      type: 'array',
      description: 'All duration package types shown to users (derived from stored prices)',
      items: customGiftPackageSchema,
    },
    updatedAt: { type: 'string', format: 'date-time' },
    updatedByAdminId: { type: ['string', 'null'] },
  },
} as const

export default async function customGiftAdminRoutes(app: FastifyInstance) {
  app.get(
    '/custom-gifts/config',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Custom Gifts'],
        description:
          'List the full custom-gift feature config: enable flag, description, 1-month / 3-month prices, and derived `packages[]` for every duration type.',
        response: { 200: customGiftConfigResponseSchema },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const config = await customGiftAdminService.getConfig()
      return reply.send(config)
    },
  )

  app.put(
    '/custom-gifts/config',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Custom Gifts'],
        description:
          'Partial update of custom-gift feature config. Send any subset of pricing / enabled / description (validated in-handler). Response is the full config including all package types.',
        response: { 200: customGiftConfigResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseRequest(UpdateCustomGiftConfigBodySchema, request.body ?? {})
      const config = await customGiftAdminService.updateConfig(body, request.adminUser!.id)
      return reply.send(config)
    },
  )

  app.get(
    '/custom-gifts/requests',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Custom Gifts'],
        description:
          'Paginated custom-gift request inbox with user summary and global `countsByStatus` for tab badges.',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
            userId: { type: 'string', format: 'uuid' },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(AdminCustomGiftRequestListQuerySchema, request.query ?? {})
      const data = await customGiftAdminService.listRequests(query)
      return reply.send(data)
    },
  )

  app.get(
    '/custom-gifts/requests/:requestId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Custom Gifts'],
        description: 'Single custom-gift request detail (same shape as list rows).',
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string }
      const data = await customGiftAdminService.getRequest(requestId)
      return reply.send({ request: data })
    },
  )

  app.post(
    '/custom-gifts/requests/:requestId/complete',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Custom Gifts'],
        description:
          'PENDING → COMPLETED. Create the catalog gift via Gift Admin first, then optionally link `giftId` here.',
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            giftId: { type: 'string', format: 'uuid' },
            adminNote: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
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
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Custom Gifts'],
        description:
          'PENDING → FAILED. `refund` is required — `true` credits the original package coin debit back.',
        params: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['reason', 'refund'],
          properties: {
            reason: { type: 'string', minLength: 1, maxLength: 2000 },
            refund: { type: 'boolean' },
            adminNote: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { requestId } = request.params as { requestId: string }
      const body = parseRequest(FailCustomGiftRequestBodySchema, request.body ?? {})
      const data = await customGiftAdminService.failRequest(requestId, body, request.adminUser!.id)
      return reply.send({ request: data })
    },
  )
}

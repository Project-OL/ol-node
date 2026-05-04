import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { StoreItemCategory } from '@prisma/client'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { AppError } from '../../middlewares/errorHandler'
import { storeService } from '../../services/store.service'

const CreateStoreItemSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.nativeEnum(StoreItemCategory),
  coinCost: z.number().int().positive(),
  validityDays: z.number().int().positive().max(365).optional(),
  displayImageUrl: z.string().url(),
  effectUrl: z.string().url().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

const UpdateStoreItemSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  coinCost: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  effectUrl: z.string().url().nullable().optional(),
})

export default async function storeAdminRoutes(app: FastifyInstance) {
  app.post('/store/items', { preHandler: [requireAdmin] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateStoreItemSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
    }
    const created = await storeService.createStoreItem(parsed.data)
    return reply.status(201).send(created)
  })

  app.patch<{ Params: { id: string } }>(
    '/store/items/:id',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = UpdateStoreItemSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
      }
      const updated = await storeService.updateStoreItem(request.params.id, parsed.data)
      return reply.send(updated)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/store/items/:id',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await storeService.softDeleteStoreItem(request.params.id)
      return reply.status(204).send()
    },
  )
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { requireAdmin } from '../../middlewares/requireAdmin'
import { UpsertGiftGalleryBodySchema } from '../../models/gift-gallery.schemas'
import { giftGalleryService } from '../../services/gift-gallery.service'

export default async function giftGalleryRoutes(app: FastifyInstance) {
  app.post(
    '/',
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = UpsertGiftGalleryBodySchema.parse(request.body)
      const sections = body.sections.map((s, i) => ({
        title: s.name,
        sortOrder: s.sortOrder ?? i,
        giftIds: s.giftIds,
      }))
      const gallery = await giftGalleryService.upsertGallery({
        year: body.year,
        month: body.month,
        sections,
      })
      return reply.status(201).send({ ok: true, galleryId: gallery.id })
    },
  )

  app.get(
    '/check-full/:hostUserId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const hostUserId = (request.params as { hostUserId: string }).hostUserId
      const result = await giftGalleryService.checkIsFull(hostUserId)
      return reply.send(result)
    },
  )

  app.get(
    '/:hostUserId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const hostUserId = (request.params as { hostUserId: string }).hostUserId
      const result = await giftGalleryService.getGalleryForHost(hostUserId)
      return reply.send(result)
    },
  )
}

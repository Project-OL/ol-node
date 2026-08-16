import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import {
  AdminBannerListQuerySchema,
  BannerUploadUrlBodySchema,
  CreateBannerBodySchema,
  PatchBannerBodySchema,
} from '../../models/banner.schemas'
import { bannerAdminService } from '../../services/banner.service'
import { adminCatalogAssetUploadService } from '../../services/admin-catalog-asset-upload.service'
import { auditService } from '../../services/audit.service'

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

export default async function bannerAdminRoutes(app: FastifyInstance) {
  app.post(
    '/banners/upload-url',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseRequest(BannerUploadUrlBodySchema, request.body ?? {})
      const data = await adminCatalogAssetUploadService.getBannerUploadUrl(body)
      return reply.send(data)
    },
  )

  app.post(
    '/banners',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseRequest(CreateBannerBodySchema, request.body ?? {})
      const banner = await bannerAdminService.create(body, request.adminUser!.id)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_BANNER_CREATED',
        actionDetails: { bannerId: banner.id, title: banner.title, position: banner.position },
      })
      return reply.status(201).send({ banner })
    },
  )

  app.get(
    '/banners',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(AdminBannerListQuerySchema, request.query ?? {})
      const data = await bannerAdminService.list(query)
      return reply.send(data)
    },
  )

  app.get(
    '/banners/:bannerId',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { bannerId } = request.params as { bannerId: string }
      const banner = await bannerAdminService.getById(bannerId)
      return reply.send({ banner })
    },
  )

  app.patch(
    '/banners/:bannerId',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { bannerId } = request.params as { bannerId: string }
      const body = parseRequest(PatchBannerBodySchema, request.body ?? {})
      const banner = await bannerAdminService.patch(bannerId, body)
      const stopped = body.enabled === false
      auditService.logAdminFromRequest(request, {
        actionType: stopped ? 'ADMIN_BANNER_STOPPED' : 'ADMIN_BANNER_UPDATED',
        actionDetails: { bannerId, fields: Object.keys(body) },
      })
      return reply.send({ banner })
    },
  )

  app.delete(
    '/banners/:bannerId',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { bannerId } = request.params as { bannerId: string }
      await bannerAdminService.delete(bannerId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_BANNER_DELETED',
        actionDetails: { bannerId },
      })
      return reply.send({ ok: true })
    },
  )
}

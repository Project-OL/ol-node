import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { env } from '../../config/env'
import { uploadGiftAdminAsset } from '../../utils/gift-admin-assets'
import {
  GiftAdminListQuerySchema,
  CreateGiftCategoryBodySchema,
  UpdateGiftCategoryBodySchema,
  ReorderGiftCategoriesBodySchema,
  CreateGiftAdminBodySchema,
  CreateGiftAdminMultipartFieldsSchema,
  PatchGiftAdminBodySchema,
  PatchGiftAdminMultipartFieldsSchema,
  GalleryPeriodQuerySchema,
  CreateGalleryCategoryBodySchema,
  UpdateGalleryCategoryBodySchema,
  ReorderGalleryCategoriesBodySchema,
  AddGiftsToGalleryCategoryBodySchema,
  RemoveGiftsFromGalleryCategoryBodySchema,
} from '../../models/gift-admin.schemas'
import { giftAdminService, giftCategoryService } from '../../services/gift-admin.service'
import { giftGalleryAdminService } from '../../services/gift-gallery-admin.service'
import { adminCatalogAssetUploadService } from '../../services/admin-catalog-asset-upload.service'
import { AdminCatalogAssetUploadUrlBodySchema } from '../../models/admin-catalog-asset-upload.schemas'
import { auditService } from '../../services/audit.service'
import { catalogActiveToggleActionType } from '../../utils/admin-audit'

type FilePart = { buffer: Buffer; filename: string }

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

async function readGiftAdminMultipart(request: FastifyRequest): Promise<{
  fields: Record<string, string>
  displayImage?: FilePart
  effect?: FilePart
}> {
  const fields: Record<string, string> = {}
  let displayImage: FilePart | undefined
  let effect: FilePart | undefined

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'displayImage' || part.fieldname === 'display_image') {
          const chunks: Buffer[] = []
          for await (const ch of part.file) {
            chunks.push(ch as Buffer)
          }
          const filename = part.filename?.trim() || ''
          if (!filename) {
            throw new AppError(
              400,
              'displayImage upload must include a filename with extension',
              'INVALID_REQUEST',
            )
          }
          displayImage = { buffer: Buffer.concat(chunks), filename }
        } else if (part.fieldname === 'effect' || part.fieldname === 'effectFile') {
          const chunks: Buffer[] = []
          for await (const ch of part.file) {
            chunks.push(ch as Buffer)
          }
          const filename = part.filename?.trim() || ''
          if (!filename) {
            throw new AppError(
              400,
              'effect upload must include a filename with extension',
              'INVALID_REQUEST',
            )
          }
          effect = { buffer: Buffer.concat(chunks), filename }
        } else {
          part.file.resume()
          throw new AppError(400, `Unexpected file field: ${part.fieldname}`, 'INVALID_REQUEST')
        }
      } else {
        fields[part.fieldname] = String(part.value ?? '')
      }
    }
  } catch (e: unknown) {
    const err = e as { code?: string }
    if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError(413, 'File exceeds maximum size', 'FILE_TOO_LARGE', {
        maxBytes: env.MAX_UPLOAD_SIZE_BYTES,
      })
    }
    throw e
  }

  return { fields, displayImage, effect }
}

function hasOwnField(fields: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key)
}

export default async function giftAdminRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_SIZE_BYTES },
  })

  app.get(
    '/gifts/analytics',
    { preHandler: preAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const analytics = await giftAdminService.getAnalytics()
      return reply.send(analytics)
    },
  )

  app.post(
    '/gifts/upload-url',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = AdminCatalogAssetUploadUrlBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const result = await adminCatalogAssetUploadService.getGiftUploadUrl(parsed.data)
      return reply.send(result)
    },
  )

  app.get(
    '/gifts',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = GiftAdminListQuerySchema.parse(request.query)
      const result = await giftAdminService.listGifts(q)
      return reply.send(result)
    },
  )

  app.post(
    '/gifts',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ct = String(request.headers['content-type'] ?? '')

      if (ct.includes('multipart/form-data')) {
        const { fields, displayImage, effect } = await readGiftAdminMultipart(request)
        const parsed = CreateGiftAdminMultipartFieldsSchema.safeParse(fields)
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Invalid multipart fields',
            'INVALID_REQUEST',
          )
        }
        const f = parsed.data

        let displayImageUrl = f.displayImageUrl
        if (displayImage) {
          displayImageUrl = await uploadGiftAdminAsset({
            buffer: displayImage.buffer,
            filename: displayImage.filename,
            role: 'display',
          })
        }
        if (!displayImageUrl) {
          throw new AppError(
            400,
            'Provide displayImage file or displayImageUrl field',
            'INVALID_REQUEST',
          )
        }

        let effectUrl: string | null = null
        if (effect) {
          effectUrl = await uploadGiftAdminAsset({
            buffer: effect.buffer,
            filename: effect.filename,
            role: 'effect',
          })
        } else if (f.effectUrl !== undefined) {
          effectUrl = f.effectUrl === '' ? null : f.effectUrl
        }

        const created = await giftAdminService.createGift({
          name: f.name,
          code: f.code,
          coinCost: f.coinCost,
          displayImageUrl,
          effectUrl,
          categoryId: f.categoryId ?? null,
          displayOrder: f.displayOrder,
          vipOnly: f.vipOnly,
        })
        auditService.logAdminFromRequest(request, {
          actionType: 'ADMIN_GIFT_CREATED',
          actionDetails: { giftId: created.id, name: created.name, code: created.code },
        })
        return reply.status(201).send(created)
      }

      const parsed = CreateGiftAdminBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const created = await giftAdminService.createGift(parsed.data)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_CREATED',
        actionDetails: { giftId: created.id, name: created.name, code: created.code },
      })
      return reply.status(201).send(created)
    },
  )

  app.patch<{ Params: { giftId: string } }>(
    '/gifts/:giftId',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { giftId: string } }>, reply: FastifyReply) => {
      const ct = String(request.headers['content-type'] ?? '')

      if (ct.includes('multipart/form-data')) {
        const { fields, displayImage, effect } = await readGiftAdminMultipart(request)
        const parsed = PatchGiftAdminMultipartFieldsSchema.safeParse(fields)
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Invalid multipart fields',
            'INVALID_REQUEST',
          )
        }
        const f = parsed.data
        const patch: Parameters<typeof giftAdminService.patchGift>[1] = {}

        if (f.name !== undefined) patch.name = f.name
        if (f.code !== undefined) patch.code = f.code
        if (f.coinCost !== undefined) patch.coinCost = f.coinCost
        if (f.displayOrder !== undefined) patch.displayOrder = f.displayOrder
        if (f.vipOnly !== undefined) patch.vipOnly = f.vipOnly
        if (f.isActive !== undefined) patch.isActive = f.isActive
        if (f.categoryId !== undefined) patch.categoryId = f.categoryId
        if (f.displayImageUrl !== undefined) patch.displayImageUrl = f.displayImageUrl

        if (displayImage) {
          patch.displayImageUrl = await uploadGiftAdminAsset({
            buffer: displayImage.buffer,
            filename: displayImage.filename,
            role: 'display',
          })
        }

        if (effect) {
          patch.effectUrl = await uploadGiftAdminAsset({
            buffer: effect.buffer,
            filename: effect.filename,
            role: 'effect',
          })
        } else if (hasOwnField(fields, 'effectUrl')) {
          const raw = fields.effectUrl ?? ''
          if (raw === '') patch.effectUrl = null
          else {
            const urlCheck = z.string().url().safeParse(raw)
            if (!urlCheck.success) {
              throw new AppError(400, 'effectUrl must be a valid URL or empty', 'INVALID_REQUEST')
            }
            patch.effectUrl = urlCheck.data
          }
        }

        if (Object.keys(patch).length === 0) {
          throw new AppError(400, 'No fields or files to update', 'INVALID_REQUEST')
        }

        const updated = await giftAdminService.patchGift(request.params.giftId, patch)
        auditService.logAdminFromRequest(request, {
          actionType: catalogActiveToggleActionType('ADMIN_GIFT', patch),
          actionDetails: { giftId: request.params.giftId, fields: Object.keys(patch) },
        })
        return reply.send(updated)
      }

      const parsed = PatchGiftAdminBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const updated = await giftAdminService.patchGift(request.params.giftId, parsed.data)
      auditService.logAdminFromRequest(request, {
        actionType: catalogActiveToggleActionType('ADMIN_GIFT', parsed.data),
        actionDetails: { giftId: request.params.giftId, fields: Object.keys(parsed.data) },
      })
      return reply.send(updated)
    },
  )

  app.delete<{ Params: { giftId: string } }>(
    '/gifts/:giftId',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { giftId: string } }>, reply: FastifyReply) => {
      await giftAdminService.deleteGift(request.params.giftId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_DELETED',
        actionDetails: { giftId: request.params.giftId },
      })
      return reply.status(204).send()
    },
  )

  app.get(
    '/gift-categories',
    { preHandler: preAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const categories = await giftCategoryService.list()
      return reply.send({ categories })
    },
  )

  app.post(
    '/gift-categories',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateGiftCategoryBodySchema.parse(request.body ?? {})
      const created = await giftCategoryService.create(body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_CATEGORY_CREATED',
        actionDetails: { categoryId: created.id, name: created.name },
      })
      return reply.status(201).send(created)
    },
  )

  app.patch<{ Params: { categoryId: string } }>(
    '/gift-categories/:categoryId',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { categoryId: string } }>, reply: FastifyReply) => {
      const body = UpdateGiftCategoryBodySchema.parse(request.body ?? {})
      const updated = await giftCategoryService.update(request.params.categoryId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_CATEGORY_UPDATED',
        actionDetails: { categoryId: request.params.categoryId },
      })
      return reply.send(updated)
    },
  )

  app.post(
    '/gift-categories/reorder',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ReorderGiftCategoriesBodySchema.parse(request.body ?? {})
      const categories = await giftCategoryService.reorder(body.orderedIds)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_CATEGORY_REORDERED',
        actionDetails: { orderedIds: body.orderedIds },
      })
      return reply.send({ categories })
    },
  )

  app.delete<{ Params: { categoryId: string } }>(
    '/gift-categories/:categoryId',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { categoryId: string } }>, reply: FastifyReply) => {
      await giftCategoryService.delete(request.params.categoryId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_CATEGORY_DELETED',
        actionDetails: { categoryId: request.params.categoryId },
      })
      return reply.status(204).send()
    },
  )

  app.get(
    '/gift-gallery/categories',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = GalleryPeriodQuerySchema.parse(request.query)
      const result = await giftGalleryAdminService.listCategories(q.year, q.month)
      return reply.send(result)
    },
  )

  app.post(
    '/gift-gallery/categories',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateGalleryCategoryBodySchema.parse(request.body ?? {})
      const created = await giftGalleryAdminService.createCategory(body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_GALLERY_CREATED',
        actionDetails: { sectionId: created.id, categoryId: created.id },
      })
      return reply.status(201).send(created)
    },
  )

  app.patch<{ Params: { sectionId: string } }>(
    '/gift-gallery/categories/:sectionId',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { sectionId: string } }>, reply: FastifyReply) => {
      const body = UpdateGalleryCategoryBodySchema.parse(request.body ?? {})
      const updated = await giftGalleryAdminService.updateCategory(request.params.sectionId, body)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_GALLERY_UPDATED',
        actionDetails: {
          sectionId: request.params.sectionId,
          categoryId: request.params.sectionId,
        },
      })
      return reply.send(updated)
    },
  )

  app.post(
    '/gift-gallery/categories/reorder',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = ReorderGalleryCategoriesBodySchema.parse(request.body ?? {})
      const result = await giftGalleryAdminService.reorderCategories(
        body.orderedIds,
        body.year,
        body.month,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_GALLERY_REORDERED',
        actionDetails: { orderedIds: body.orderedIds, year: body.year, month: body.month },
      })
      return reply.send(result)
    },
  )

  app.delete<{ Params: { sectionId: string } }>(
    '/gift-gallery/categories/:sectionId',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { sectionId: string } }>, reply: FastifyReply) => {
      await giftGalleryAdminService.deleteCategory(request.params.sectionId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_GALLERY_DELETED',
        actionDetails: {
          sectionId: request.params.sectionId,
          categoryId: request.params.sectionId,
        },
      })
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { sectionId: string } }>(
    '/gift-gallery/categories/:sectionId/gifts',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { sectionId: string } }>, reply: FastifyReply) => {
      const body = AddGiftsToGalleryCategoryBodySchema.parse(request.body ?? {})
      const result = await giftGalleryAdminService.addGiftsToCategory(
        request.params.sectionId,
        body.giftIds,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_GALLERY_GIFTS_ADDED',
        actionDetails: {
          sectionId: request.params.sectionId,
          categoryId: request.params.sectionId,
          giftIds: body.giftIds,
        },
      })
      return reply.status(201).send(result)
    },
  )

  app.delete<{ Params: { sectionId: string } }>(
    '/gift-gallery/categories/:sectionId/gifts',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { sectionId: string } }>, reply: FastifyReply) => {
      const body = RemoveGiftsFromGalleryCategoryBodySchema.parse(request.body ?? {})
      const result = await giftGalleryAdminService.removeGiftsFromCategory(
        request.params.sectionId,
        body.giftIds,
      )
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_GIFT_GALLERY_GIFTS_REMOVED',
        actionDetails: {
          sectionId: request.params.sectionId,
          categoryId: request.params.sectionId,
          giftIds: body.giftIds,
        },
      })
      return reply.send(result)
    },
  )
}

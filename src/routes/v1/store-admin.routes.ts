import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { storeService } from '../../services/store.service'
import { storeAdminService } from '../../services/store-admin.service'
import { storeAdminRepository } from '../../repositories/store-admin.repository'
import { env } from '../../config/env'
import { uploadStoreAdminAsset } from '../../utils/store-admin-assets'
import { adminCatalogAssetUploadService } from '../../services/admin-catalog-asset-upload.service'
import { AdminCatalogAssetUploadUrlBodySchema } from '../../models/admin-catalog-asset-upload.schemas'
import {
  StoreAdminListQuerySchema,
  CreateStoreAdminBodySchema,
  CreateStoreAdminMultipartFieldsSchema,
  PatchStoreAdminBodySchema,
  PatchStoreAdminMultipartFieldsSchema,
} from '../../models/store-admin.schemas'

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

type FilePart = { buffer: Buffer; filename: string }

async function readStoreAdminMultipart(request: FastifyRequest): Promise<{
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

export default async function storeAdminRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_SIZE_BYTES },
  })

  app.get(
    '/store/analytics',
    { preHandler: preAuth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const analytics = await storeAdminService.getAnalytics()
      return reply.send(analytics)
    },
  )

  app.post(
    '/store/items/upload-url',
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
      const result = await adminCatalogAssetUploadService.getStoreItemUploadUrl(parsed.data)
      return reply.send(result)
    },
  )

  app.get(
    '/store/items',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = StoreAdminListQuerySchema.parse(request.query)
      const result = await storeAdminService.listItems(q)
      return reply.send(result)
    },
  )

  app.post(
    '/store/items',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ct = String(request.headers['content-type'] ?? '')

      if (ct.includes('multipart/form-data')) {
        const { fields, displayImage, effect } = await readStoreAdminMultipart(request)
        const parsed = CreateStoreAdminMultipartFieldsSchema.safeParse(fields)
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
          displayImageUrl = await uploadStoreAdminAsset({
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
          effectUrl = await uploadStoreAdminAsset({
            buffer: effect.buffer,
            filename: effect.filename,
            role: 'effect',
          })
        } else if (f.effectUrl !== undefined) {
          effectUrl = f.effectUrl === '' ? null : f.effectUrl
        }

        const created = await storeService.createStoreItem({
          name: f.name,
          description: f.description,
          category: f.category,
          coinCost: f.coinCost,
          validityDays: f.validityDays,
          displayImageUrl,
          effectUrl,
          sortOrder: f.sortOrder,
          isActive: f.isActive,
        })
        return reply.status(201).send(storeAdminService.mapStoreItemRow(created, 0))
      }

      const parsed = CreateStoreAdminBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const created = await storeService.createStoreItem(parsed.data)
      return reply.status(201).send(storeAdminService.mapStoreItemRow(created, 0))
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/store/items/:id',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const ct = String(request.headers['content-type'] ?? '')

      if (ct.includes('multipart/form-data')) {
        const { fields, displayImage, effect } = await readStoreAdminMultipart(request)
        const parsed = PatchStoreAdminMultipartFieldsSchema.safeParse(fields)
        if (!parsed.success) {
          throw new AppError(
            400,
            parsed.error.errors[0]?.message ?? 'Invalid multipart fields',
            'INVALID_REQUEST',
          )
        }
        const f = parsed.data

        const patch: Parameters<typeof storeService.updateStoreItem>[1] = {}
        if (f.name !== undefined) patch.name = f.name
        if (hasOwnField(fields, 'description')) {
          const raw = fields.description ?? ''
          if (raw.length > 2000) {
            throw new AppError(400, 'Description too long', 'INVALID_REQUEST')
          }
          patch.description = raw === '' ? null : raw
        }
        if (f.coinCost !== undefined) patch.coinCost = f.coinCost
        if (f.validityDays !== undefined) patch.validityDays = f.validityDays
        if (f.isActive !== undefined) patch.isActive = f.isActive
        if (f.sortOrder !== undefined) patch.sortOrder = f.sortOrder
        if (f.displayImageUrl !== undefined) patch.displayImageUrl = f.displayImageUrl

        if (displayImage) {
          patch.displayImageUrl = await uploadStoreAdminAsset({
            buffer: displayImage.buffer,
            filename: displayImage.filename,
            role: 'display',
          })
        }

        if (effect) {
          patch.effectUrl = await uploadStoreAdminAsset({
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

        const updated = await storeService.updateStoreItem(request.params.id, patch)
        const [purchaseCount] = await Promise.all([
          storeAdminRepository.getPurchaseCounts([updated.id]).then((m) => m.get(updated.id) ?? 0),
        ])
        return reply.send(storeAdminService.mapStoreItemRow(updated, purchaseCount))
      }

      const parsed = PatchStoreAdminBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const updated = await storeService.updateStoreItem(request.params.id, parsed.data)
      const purchaseCount = await storeAdminRepository
        .getPurchaseCounts([updated.id])
        .then((m) => m.get(updated.id) ?? 0)
      return reply.send(storeAdminService.mapStoreItemRow(updated, purchaseCount))
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/store/items/:id',
    { preHandler: preAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await storeService.softDeleteStoreItem(request.params.id)
      return reply.status(204).send()
    },
  )
}

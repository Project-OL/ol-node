import { z } from 'zod'

export const AdminCatalogAssetUploadUrlBodySchema = z.object({
  role: z.enum(['display', 'effect']),
  fileName: z.string().min(1).max(255),
  sizeBytes: z.coerce.number().int().positive().optional(),
})

export type AdminCatalogAssetUploadUrlBody = z.infer<typeof AdminCatalogAssetUploadUrlBodySchema>

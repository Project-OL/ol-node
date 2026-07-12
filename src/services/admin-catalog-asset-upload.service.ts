import { generatePresignedAdminCatalogAssetUpload } from '../utils/admin-catalog-asset-upload'
import type { AdminCatalogAssetUploadUrlBody } from '../models/admin-catalog-asset-upload.schemas'

export const adminCatalogAssetUploadService = {
  getGiftUploadUrl(input: AdminCatalogAssetUploadUrlBody) {
    return generatePresignedAdminCatalogAssetUpload({
      domain: 'gift',
      role: input.role,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
    })
  },

  getStoreItemUploadUrl(input: AdminCatalogAssetUploadUrlBody) {
    return generatePresignedAdminCatalogAssetUpload({
      domain: 'store',
      role: input.role,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
    })
  },
}

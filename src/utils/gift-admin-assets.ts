import { storageService } from '../services/storage.service'
import { buildAdminCatalogAssetKey } from './admin-catalog-asset-upload'

/** Upload a gift display/effect asset from admin multipart. Returns public CDN/S3 URL. */
export async function uploadGiftAdminAsset(params: {
  buffer: Buffer
  filename: string
  role: 'display' | 'effect'
}): Promise<string> {
  const { key, contentType } = buildAdminCatalogAssetKey({
    domain: 'gift',
    role: params.role,
    fileName: params.filename,
  })
  await storageService.putObjectBuffer({
    key,
    body: params.buffer,
    contentType,
  })
  return storageService.getCdnOrS3PublicUrl(key)
}

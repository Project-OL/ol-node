import { randomUUID } from 'crypto'
import { storageService } from '../services/storage.service'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'

export type AdminCatalogDomain = 'gift' | 'store'
export type AdminCatalogAssetRole = 'display' | 'effect'

/** Gift catalog assets (display + effect). */
export const GIFT_ADMIN_EXT_TO_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  json: 'application/json',
  lottie: 'application/zip',
  riv: 'application/octet-stream',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/** Store catalog assets (display + effect). */
export const STORE_ADMIN_EXT_TO_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  json: 'application/json',
  lottie: 'application/zip',
  riv: 'application/octet-stream',
}

const PRESIGNED_URL_EXPIRES_IN = 300

function extMapForDomain(domain: AdminCatalogDomain): Record<string, string> {
  return domain === 'gift' ? GIFT_ADMIN_EXT_TO_CONTENT_TYPE : STORE_ADMIN_EXT_TO_CONTENT_TYPE
}

export function extFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function sanitizeBaseName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'asset'
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'asset'
}

export function resolveAdminCatalogAssetContentType(
  domain: AdminCatalogDomain,
  fileName: string,
): { ext: string; contentType: string } {
  const ext = extFromFilename(fileName)
  const extMap = extMapForDomain(domain)
  if (!ext || !extMap[ext]) {
    const allowed = [...new Set(Object.keys(extMap))].sort().join(', ')
    const code = domain === 'gift' ? 'INVALID_GIFT_ASSET_TYPE' : 'INVALID_STORE_ASSET_TYPE'
    throw new AppError(
      400,
      `Unsupported file type .${ext || '(none)'}. Allowed: ${allowed}`,
      code,
    )
  }
  return { ext, contentType: extMap[ext]! }
}

export function buildAdminCatalogAssetKey(params: {
  domain: AdminCatalogDomain
  role: AdminCatalogAssetRole
  fileName: string
}): { key: string; contentType: string } {
  const { contentType } = resolveAdminCatalogAssetContentType(params.domain, params.fileName)
  const id = randomUUID()
  const safe = sanitizeBaseName(params.fileName)
  const prefix =
    params.domain === 'gift'
      ? `gifts/admin/${id}/${params.role}-${safe}`
      : `store/admin/items/${id}/${params.role}-${safe}`
  return { key: prefix, contentType }
}

export async function generatePresignedAdminCatalogAssetUpload(params: {
  domain: AdminCatalogDomain
  role: AdminCatalogAssetRole
  fileName: string
  sizeBytes?: number
}): Promise<{
  uploadUrl: string
  key: string
  publicUrl: string
  expiresIn: number
  role: AdminCatalogAssetRole
  contentType: string
}> {
  if (params.sizeBytes !== undefined && params.sizeBytes > env.MAX_UPLOAD_SIZE_BYTES) {
    throw new AppError(413, 'File exceeds maximum size', 'FILE_TOO_LARGE', {
      maxBytes: env.MAX_UPLOAD_SIZE_BYTES,
    })
  }

  const { key, contentType } = buildAdminCatalogAssetKey({
    domain: params.domain,
    role: params.role,
    fileName: params.fileName,
  })

  const uploadUrl = await storageService.getPresignedPutUrl(key, contentType, PRESIGNED_URL_EXPIRES_IN, {
    cacheControl: 'public, max-age=31536000, immutable',
  })

  return {
    uploadUrl,
    key,
    publicUrl: storageService.getCdnOrS3PublicUrl(key),
    expiresIn: PRESIGNED_URL_EXPIRES_IN,
    role: params.role,
    contentType,
  }
}

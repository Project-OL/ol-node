import { randomUUID } from 'crypto'
import { storageService } from '../services/storage.service'
import { AppError } from '../middlewares/errorHandler'

/** Allowed store asset extensions → Content-Type for S3. */
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
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

const ALLOWED_EXT = new Set(Object.keys(EXT_TO_CONTENT_TYPE))

function extFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

function sanitizeBaseName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'asset'
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'asset'
}

/**
 * Upload a store display/effect asset from admin multipart. Returns public CDN/S3 URL.
 */
export async function uploadStoreAdminAsset(params: {
  buffer: Buffer
  filename: string
  role: 'display' | 'effect'
}): Promise<string> {
  const ext = extFromFilename(params.filename)
  if (!ALLOWED_EXT.has(ext)) {
    throw new AppError(
      400,
      `Unsupported file type .${ext || '(none)'}. Allowed: ${[...ALLOWED_EXT].sort().join(', ')}`,
      'INVALID_STORE_ASSET_TYPE',
    )
  }
  const contentType = EXT_TO_CONTENT_TYPE[ext]!
  const id = randomUUID()
  const safe = sanitizeBaseName(params.filename)
  const key = `store/admin/items/${id}/${params.role}-${safe}`
  await storageService.putObjectBuffer({
    key,
    body: params.buffer,
    contentType,
  })
  return storageService.getCdnOrS3PublicUrl(key)
}

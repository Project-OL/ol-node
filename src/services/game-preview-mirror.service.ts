import crypto from 'crypto'
import { storageService } from './storage.service'
import { fetchAssetBytes } from '../utils/remote-asset'
import { rootLogger } from '../utils/rootLogger'

const logger = rootLogger.child({ module: 'game-preview-mirror' })

/**
 * Copies a game provider's preview image into our own object store.
 *
 * The provider serves previews off an overseas CDN — measured from an Indian consumer
 * connection, ~1.0-1.7s per image, of which 450-640ms is DNS+TCP+TLS before a single
 * byte of a 21 KB file moves. The bytes were never the problem; the distance is. Serving
 * the same image from our bucket removes that hop entirely.
 *
 * The key is content-addressed on the source URL, so re-syncing is idempotent and a
 * provider-side image swap lands on a fresh key rather than behind a stale cache.
 */
const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function extFor(contentType: string | null, sourceUrl: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default: {
      const fromUrl = sourceUrl.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''
      return /^(png|jpg|jpeg|webp|gif)$/.test(fromUrl) ? fromUrl : 'png'
    }
  }
}

/**
 * Short digest of the source URL, embedded in the mirrored object key.
 *
 * Exported because callers use it to decide whether a *stored* mirror URL still
 * corresponds to the provider's *current* preview URL — if the provider swaps the image,
 * the digest changes, the stored URL no longer contains it, and we re-mirror. Keep this
 * the single definition so that check cannot drift from the key it is checking against.
 */
export function previewMirrorDigest(sourceUrl: string): string {
  return crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 16)
}

function mirrorKeyFor(
  providerCode: string,
  gameId: number,
  sourceUrl: string,
  ext: string,
): string {
  return `games/preview/${providerCode.toLowerCase()}/${gameId}-${previewMirrorDigest(sourceUrl)}.${ext}`
}

export const gamePreviewMirrorService = {
  /**
   * Best-effort mirror. Returns our public URL, or `null` when the source could not be
   * fetched or is not an image — callers then keep serving the provider's own URL, so a
   * mirror failure degrades latency without breaking the catalog.
   */
  async mirror(params: {
    providerCode: string
    gameId: number
    sourceUrl: string
  }): Promise<string | null> {
    const { providerCode, gameId, sourceUrl } = params
    if (!sourceUrl) return null

    const asset = await fetchAssetBytes(sourceUrl)
    if (!asset) {
      logger.warn({ gameId, sourceUrl }, 'game preview mirror skipped: source not fetchable')
      return null
    }

    if (asset.contentType && !ALLOWED_CONTENT_TYPES.has(asset.contentType)) {
      logger.warn(
        { gameId, sourceUrl, contentType: asset.contentType },
        'game preview mirror skipped: not an image',
      )
      return null
    }

    const ext = extFor(asset.contentType, sourceUrl)
    const key = mirrorKeyFor(providerCode, gameId, sourceUrl, ext)

    try {
      await storageService.putObjectBuffer({
        key,
        body: asset.buffer,
        contentType: asset.contentType ?? `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        cacheControl: 'public, max-age=31536000, immutable',
      })
    } catch (err) {
      logger.error({ err, gameId, sourceUrl, key }, 'game preview mirror upload failed')
      return null
    }

    logger.info({ gameId, key, bytes: asset.buffer.byteLength }, 'game preview mirrored')
    return storageService.getCdnOrS3PublicUrl(key)
  },
}

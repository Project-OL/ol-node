import crypto from 'crypto'
import { storageService } from './storage.service'
import { fetchAssetBytes } from '../utils/remote-asset'
import { generateThumbnail, THUMBNAIL_CONTENT_TYPE, THUMBNAIL_EXT } from '../utils/image-thumbnail'
import { rootLogger } from '../utils/rootLogger'

const logger = rootLogger.child({ module: 'gift-thumbnail' })

/**
 * Derives the small image that client payloads serve in place of a gift's
 * full-resolution `displayImageUrl`.
 *
 * The key is content-addressed on the *source URL*, which makes regeneration idempotent
 * (re-running the backfill overwrites the same object rather than littering the bucket)
 * while still producing a fresh URL whenever the admin points the gift at a new image —
 * so a replaced asset is never served from a stale cache.
 */
function thumbnailKeyFor(sourceUrl: string): string {
  const digest = crypto.createHash('sha1').update(sourceUrl).digest('hex')
  return `gifts/thumb/${digest}.${THUMBNAIL_EXT}`
}

export const giftThumbnailService = {
  /**
   * Best-effort. Returns the thumbnail URL, or `null` when one should not or could not
   * be made — an unreachable source, an animated or vector asset, an image already small
   * enough, or a storage failure. Callers persist null and fall back to the original, so
   * a gift is never blocked from being created because its thumbnail did not generate.
   */
  async generateForSource(sourceUrl: string): Promise<string | null> {
    if (!sourceUrl) return null

    const source = await fetchAssetBytes(sourceUrl)
    if (!source) {
      logger.warn({ sourceUrl }, 'gift thumbnail skipped: source not fetchable')
      return null
    }

    const thumb = await generateThumbnail(source.buffer)
    if (!thumb) return null

    const key = thumbnailKeyFor(sourceUrl)
    try {
      await storageService.putObjectBuffer({
        key,
        body: thumb.buffer,
        contentType: THUMBNAIL_CONTENT_TYPE,
        // The key changes whenever the source does, so this object is genuinely immutable.
        cacheControl: 'public, max-age=31536000, immutable',
      })
    } catch (err) {
      logger.error({ err, sourceUrl, key }, 'gift thumbnail upload failed')
      return null
    }

    logger.info(
      {
        sourceUrl,
        key,
        sourceBytes: source.buffer.byteLength,
        thumbBytes: thumb.buffer.byteLength,
        dimensions: `${thumb.width}x${thumb.height}`,
      },
      'gift thumbnail generated',
    )
    return storageService.getCdnOrS3PublicUrl(key)
  },
}

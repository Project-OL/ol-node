import crypto from 'crypto'
import { storageService } from './storage.service'
import { generateThumbnail, THUMBNAIL_CONTENT_TYPE, THUMBNAIL_EXT } from '../utils/image-thumbnail'
import { parseOwnedAvatarS3Key } from '../utils/avatar-s3-key'
import { rootLogger } from '../utils/rootLogger'

const logger = rootLogger.child({ module: 'avatar-resize' })

/**
 * Longest edge of a stored avatar. Lists, chat and the live room draw avatars at
 * <= ~60dp, but tapping one opens a full-screen zoomable view of the *same*
 * `avatarUrl` (ol_app host_profile PhotoView), so this cannot go as low as the
 * 192px gift thumbnails without that view turning blurry. 512px WebP measured at
 * 22-45 KB against 66-198 KB originals.
 */
export const AVATAR_MAX_PX = 512

/** Suffix that marks an avatar this service produced (keeps the backfill idempotent). */
export const RESIZED_AVATAR_SUFFIX = `-${AVATAR_MAX_PX}.${THUMBNAIL_EXT}`

export type ResizedAvatar = { buffer: Buffer; contentType: string; ext: string }

/** Stays under `avatars/{userId}/` so ownership parsing and moderation keep working. */
export function resizedAvatarKey(userId: string): string {
  return `avatars/${userId}/${crypto.randomUUID()}${RESIZED_AVATAR_SUFFIX}`
}

export const avatarResizeService = {
  /**
   * Downscale avatar bytes to fit AVATAR_MAX_PX and re-encode as WebP. Returns null
   * (store the original) when the image is already small enough, animated, or not
   * decodable - resizing is an optimisation and must never block a profile save.
   */
  async shrinkBuffer(source: Buffer): Promise<ResizedAvatar | null> {
    const thumb = await generateThumbnail(source, { maxPx: AVATAR_MAX_PX })
    if (!thumb) return null
    return { buffer: thumb.buffer, contentType: THUMBNAIL_CONTENT_TYPE, ext: THUMBNAIL_EXT }
  },

  /**
   * For an avatar the client uploaded straight to storage (presigned PUT): store a
   * resized copy and return its public URL, or null to keep `avatarUrl` as-is. Only
   * this user's own `avatars/{userId}/` objects are touched; the original object is
   * left in place. Never throws.
   */
  async shrinkOwnedAvatarUrl(userId: string, avatarUrl: string): Promise<string | null> {
    const key = parseOwnedAvatarS3Key(avatarUrl, userId)
    if (!key || key.endsWith(RESIZED_AVATAR_SUFFIX)) return null
    try {
      const source = await storageService.getObjectBuffer(key)
      const resized = await avatarResizeService.shrinkBuffer(source)
      if (!resized) return null
      const newKey = resizedAvatarKey(userId)
      await storageService.putObjectBuffer({
        key: newKey,
        body: resized.buffer,
        contentType: resized.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      })
      logger.info(
        { userId, key, newKey, sourceBytes: source.byteLength, resizedBytes: resized.buffer.byteLength },
        'avatar resized',
      )
      return storageService.getCdnOrS3PublicUrl(newKey)
    } catch (err) {
      logger.warn({ err, userId, key }, 'avatar resize skipped')
      return null
    }
  },
}

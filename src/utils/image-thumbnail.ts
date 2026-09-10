import sharp from 'sharp'

/**
 * Catalog images are uploaded at whatever resolution the admin happened to export —
 * in production that means 1024x1536 PNGs (2-3 MB each) rendered by the app into a
 * 55x55 grid cell. These helpers derive a small WebP so the client payload matches
 * what actually gets drawn.
 *
 * WebP is used rather than PNG because it keeps the alpha channel these assets rely
 * on while being several times smaller, and it decodes natively on both iOS and
 * Android (so `cached_network_image` needs no change).
 */

/** Longest edge of a generated thumbnail, in pixels. ~3.5x the 55dp grid cell, so it
 *  stays sharp on a 3x display without carrying any more than that. */
export const THUMBNAIL_MAX_PX = 192

export const THUMBNAIL_CONTENT_TYPE = 'image/webp'
export const THUMBNAIL_EXT = 'webp'

export type ThumbnailResult = {
  buffer: Buffer
  width: number
  height: number
  contentType: string
}

/**
 * Downscales to fit inside a `THUMBNAIL_MAX_PX` box and re-encodes as WebP.
 *
 * Returns `null` — meaning "serve the original" — rather than throwing, for inputs
 * where a raster thumbnail would be a downgrade or is not worth generating:
 *
 * - **Animated** sources (multi-page GIF/WebP): flattening would silently drop the
 *   animation, and gift art is the one place that would be noticed.
 * - **SVG**: already resolution-independent and typically smaller than the WebP we
 *   would produce; rasterising it makes the asset strictly worse.
 * - Sources already inside the box, where re-encoding buys nothing.
 * - Anything sharp cannot parse (a video mislabelled as a display image, say).
 */
export async function generateThumbnail(
  source: Buffer,
  opts?: { maxPx?: number },
): Promise<ThumbnailResult | null> {
  const maxPx = opts?.maxPx ?? THUMBNAIL_MAX_PX

  let image: sharp.Sharp
  let metadata: sharp.Metadata
  try {
    image = sharp(source, { failOn: 'error' })
    metadata = await image.metadata()
  } catch {
    return null
  }

  if (metadata.format === 'svg') return null
  if ((metadata.pages ?? 1) > 1) return null

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) return null
  if (width <= maxPx && height <= maxPx) return null

  try {
    const buffer = await image
      .rotate() // honour EXIF orientation before we discard the metadata
      .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer()

    const scale = Math.min(maxPx / width, maxPx / height)
    return {
      buffer,
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      contentType: THUMBNAIL_CONTENT_TYPE,
    }
  } catch {
    return null
  }
}

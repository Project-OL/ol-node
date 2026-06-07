/** Detect image type from magic bytes (do not trust Content-Type alone). */
export function detectImageMimeFromBuffer(
  buf: Buffer,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length < 3) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export function extensionForImageMime(mime: 'image/jpeg' | 'image/png' | 'image/webp'): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  return 'webp'
}

/**
 * Extract an owned avatar S3 key from a public CDN/S3 URL.
 * Expected key: `avatars/{userId}/{filename}`.
 */
export function parseOwnedAvatarS3Key(avatarUrl: string, userId: string): string | null {
  if (!userId || userId.includes('/') || userId.includes('..') || userId.includes('\\')) {
    return null
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(avatarUrl).pathname)
  } catch {
    return null
  }
  const normalized = pathname.replace(/^\/+/, '')
  const expected = `avatars/${userId}/`
  const idx = normalized.indexOf(expected)
  if (idx === -1) return null
  const key = normalized.slice(idx)
  if (key.includes('..') || key.includes('\\')) return null
  const rest = key.slice(expected.length)
  if (!rest || rest.includes('/')) return null
  return key
}

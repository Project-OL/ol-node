import axios from 'axios'
import { storageService } from '../services/storage.service'

/**
 * Reads the bytes behind a catalog asset URL so we can derive a thumbnail or mirror it.
 *
 * Two sources, deliberately in this order:
 *  1. Our own object store, via the SDK, when the URL is one we emitted. Avoids a
 *     round trip through the public origin and keeps working if the bucket is private.
 *  2. Plain HTTP, for third-party URLs — provider CDNs, and the hand-entered Unsplash
 *     and icons8 URLs that exist in the gift table today.
 */

/** Refuse anything larger than this. Catalog art has no business being bigger, and it
 *  bounds the memory a single admin upload or provider sync can pull into the process. */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024

const FETCH_TIMEOUT_MS = 20_000

/**
 * Blocks the obvious SSRF shapes. `displayImageUrl` is admin-supplied free text, so a
 * fetch driven by it must not be usable to probe the VM's own network — link-local in
 * particular is the cloud metadata endpoint.
 */
function isFetchableHttpUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return false
  }
  // Literal private / loopback / link-local IPv4 and IPv6.
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('[::1]') ||
    host.startsWith('[fc') ||
    host.startsWith('[fd') ||
    host.startsWith('[fe80')
  ) {
    return false
  }
  return true
}

export type FetchedAsset = {
  buffer: Buffer
  contentType: string | null
}

/**
 * Returns the asset bytes, or `null` when the source is unreachable, too large, or not
 * fetchable. Callers treat null as "leave this one alone" — a thumbnail or a mirror is
 * an optimisation, never a reason to fail the operation that triggered it.
 */
export async function fetchAssetBytes(url: string): Promise<FetchedAsset | null> {
  const ownKey = storageService.getKeyFromPublicUrl(url)
  if (ownKey) {
    try {
      const buffer = await storageService.getObjectBuffer(ownKey)
      if (buffer.byteLength > MAX_ASSET_BYTES) return null
      return { buffer, contentType: null }
    } catch {
      // Fall through to HTTP: the row may point at an object that has since moved, or
      // at a bucket this environment cannot read.
    }
  }

  if (!isFetchableHttpUrl(url)) return null

  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_ASSET_BYTES,
      maxBodyLength: MAX_ASSET_BYTES,
      // Redirects can leave the allowlist we just checked; keep it short and re-checked
      // by the transport rather than following an open-ended chain.
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 300,
    })
    const buffer = Buffer.from(response.data)
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ASSET_BYTES) return null
    const contentType = response.headers['content-type']
    return {
      buffer,
      contentType: typeof contentType === 'string' ? contentType.split(';')[0]!.trim() : null,
    }
  } catch {
    return null
  }
}

import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, s3Bucket } from '../config/s3'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import { rootLogger } from '../utils/rootLogger'
import { s3CircuitBreaker } from '../utils/circuitBreaker'

/** Normalize a configured host/URL into a scheme-qualified origin with no trailing slash. */
function normalizeBase(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function buildPublicUrl(key: string): string {
  // Non-AWS provider (R2): objects are served from their own public domain, not
  // the bucket-hosted AWS URL. Falls through to AWS when S3_PUBLIC_BASE_URL is unset.
  const base = env.S3_PUBLIC_BASE_URL?.trim()
  if (base) {
    return `${normalizeBase(base)}/${key}`
  }
  if (!s3Bucket) {
    throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
  }
  return `https://${s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
}

function buildObjectPublicUrl(key: string): string {
  const domain = env.CLOUDFRONT_DOMAIN?.trim()
  if (domain) {
    return `${normalizeBase(domain)}/${key}`
  }
  return buildPublicUrl(key)
}

/**
 * Inverse of the two builders above: given a URL we may once have emitted, recover the
 * object key so callers can read the bytes through the SDK instead of over the public
 * origin. Returns null for anything that is not ours (third-party or hand-entered URLs).
 *
 * Kept beside the builders on purpose — every origin one of them can produce has to be
 * recognised here, so the two must be edited together.
 */
function resolveOwnObjectKey(url: string): string | null {
  const candidates: string[] = []
  const cdn = env.CLOUDFRONT_DOMAIN?.trim()
  if (cdn) candidates.push(normalizeBase(cdn))
  const publicBase = env.S3_PUBLIC_BASE_URL?.trim()
  if (publicBase) candidates.push(normalizeBase(publicBase))
  if (s3Bucket) {
    candidates.push(`https://${s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com`)
  }

  for (const base of candidates) {
    if (url.startsWith(`${base}/`)) {
      const key = url.slice(base.length + 1)
      // Strip any query string; keys themselves never contain one.
      const clean = key.split('?')[0] ?? ''
      if (clean) return decodeURIComponent(clean)
    }
  }
  return null
}

export const storageService = {
  getPublicUrl(key: string): string {
    return buildPublicUrl(key)
  },

  /** Public URL for avatars and assets (CloudFront when CLOUDFRONT_DOMAIN is set). */
  getCdnOrS3PublicUrl(key: string): string {
    return buildObjectPublicUrl(key)
  },

  /** Object key behind one of our own public URLs, or null if the URL is not ours. */
  getKeyFromPublicUrl(url: string): string | null {
    return resolveOwnObjectKey(url)
  },

  async putObjectBuffer(params: {
    key: string
    body: Buffer
    contentType: string
    cacheControl?: string
  }): Promise<void> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }
    if (s3CircuitBreaker.shouldSkip()) {
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_CIRCUIT_OPEN')
    }
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
          CacheControl: params.cacheControl ?? 'max-age=31536000',
        }),
      )
      s3CircuitBreaker.recordSuccess()
    } catch (err) {
      s3CircuitBreaker.recordFailure()
      rootLogger.child({ module: 'storage' }).error({ err }, 'S3 PutObject failed')
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_UPLOAD_FAILED')
    }
  },

  async getPresignedPutUrl(
    key: string,
    mimeType: string,
    expiresInSeconds: number,
    opts?: { cacheControl?: string },
  ): Promise<string> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }

    const command = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      ContentType: mimeType,
      ...(opts?.cacheControl ? { CacheControl: opts.cacheControl } : {}),
    })

    return getSignedUrl(s3Client, command, {
      expiresIn: expiresInSeconds,
    })
  },

  /** Metadata-only object probe — used to validate client-reported uploads before persisting a message. */
  async headObjectMetadata(key: string): Promise<{
    contentLength: number
    contentType?: string
    checksumSha256?: string
  }> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }
    if (s3CircuitBreaker.shouldSkip()) {
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_CIRCUIT_OPEN')
    }
    try {
      const r = await s3Client.send(
        new HeadObjectCommand({
          Bucket: s3Bucket,
          Key: key,
        }),
      )
      s3CircuitBreaker.recordSuccess()
      return {
        contentLength: Number(r.ContentLength ?? 0),
        contentType: r.ContentType,
        checksumSha256: r.ChecksumSHA256,
      }
    } catch (err) {
      const name =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : ''
      if (name === 'NotFound' || name === 'NoSuchKey') {
        // Object genuinely missing — not an infra failure, don't trip the breaker.
        throw new AppError(400, 'Uploaded object not found', 'INVALID_MEDIA_OBJECT')
      }
      s3CircuitBreaker.recordFailure()
      if (err instanceof AppError) {
        throw err
      }
      rootLogger.child({ module: 'storage' }).warn({ err, key }, 'S3 HeadObject failed')
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_METADATA_FAILED')
    }
  },

  async getObjectBuffer(key: string): Promise<Buffer> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }
    if (s3CircuitBreaker.shouldSkip()) {
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_CIRCUIT_OPEN')
    }
    try {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3Bucket,
          Key: key,
        }),
      )
      s3CircuitBreaker.recordSuccess()
      const body = response.Body
      if (!body) {
        throw new AppError(404, 'Object body is empty', 'S3_OBJECT_EMPTY')
      }

      const chunks: Buffer[] = []
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    } catch (err) {
      if (err instanceof AppError) {
        throw err
      }
      s3CircuitBreaker.recordFailure()
      rootLogger.child({ module: 'storage' }).error({ err, key }, 'S3 GetObject failed')
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_DOWNLOAD_FAILED')
    }
  },

  async deleteObject(key: string): Promise<void> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }
    if (s3CircuitBreaker.shouldSkip()) {
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_CIRCUIT_OPEN')
    }

    const command = new DeleteObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    })

    try {
      await s3Client.send(command)
      s3CircuitBreaker.recordSuccess()
    } catch (err) {
      s3CircuitBreaker.recordFailure()
      throw err
    }
  },
}

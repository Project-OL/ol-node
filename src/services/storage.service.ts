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

function buildPublicUrl(key: string): string {
  if (!s3Bucket) {
    throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
  }
  return `https://${s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
}

function buildObjectPublicUrl(key: string): string {
  const domain = env.CLOUDFRONT_DOMAIN?.trim()
  if (domain) {
    const host = domain.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    return `https://${host}/${key}`
  }
  return buildPublicUrl(key)
}

export const storageService = {
  getPublicUrl(key: string): string {
    return buildPublicUrl(key)
  },

  /** Public URL for avatars and assets (CloudFront when CLOUDFRONT_DOMAIN is set). */
  getCdnOrS3PublicUrl(key: string): string {
    return buildObjectPublicUrl(key)
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
    } catch (err) {
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
    try {
      const r = await s3Client.send(
        new HeadObjectCommand({
          Bucket: s3Bucket,
          Key: key,
        }),
      )
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
        throw new AppError(400, 'Uploaded object not found', 'INVALID_MEDIA_OBJECT')
      }
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
    try {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3Bucket,
          Key: key,
        }),
      )
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
      rootLogger.child({ module: 'storage' }).error({ err, key }, 'S3 GetObject failed')
      throw new AppError(502, 'File storage temporarily unavailable', 'S3_DOWNLOAD_FAILED')
    }
  },

  async deleteObject(key: string): Promise<void> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }

    const command = new DeleteObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    })

    await s3Client.send(command)
  },
}

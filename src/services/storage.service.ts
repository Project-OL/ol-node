import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, s3Bucket } from '../config/s3'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'

function buildPublicUrl(key: string): string {
  if (!s3Bucket) {
    throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
  }
  return `https://${s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
}

export const storageService = {
  getPublicUrl(key: string): string {
    return buildPublicUrl(key)
  },

  async getPresignedPutUrl(key: string, mimeType: string, expiresInSeconds: number): Promise<string> {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }

    const command = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      ContentType: mimeType,
    })

    return getSignedUrl(s3Client, command, {
      expiresIn: expiresInSeconds,
    })
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


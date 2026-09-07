import { S3Client } from '@aws-sdk/client-s3'
import { env } from './env'

// Storage credentials: prefer the S3_* pair (R2 token) and fall back to the AWS pair,
// so an unset S3_* block leaves AWS behaviour byte-for-byte unchanged.
const accessKeyId = env.S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID
const secretAccessKey = env.S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY

export const s3Client = new S3Client({
  region: env.S3_REGION ?? env.AWS_REGION,
  ...(env.S3_ENDPOINT_URL ? { endpoint: env.S3_ENDPOINT_URL } : {}),
  ...(env.S3_FORCE_PATH_STYLE ? { forcePathStyle: true } : {}),
  credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  // R2 rejects the SDK's default trailing-checksum behaviour; WHEN_REQUIRED suits both.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

export const s3Bucket = env.S3_BUCKET ?? env.AWS_S3_BUCKET ?? ''

/**
 * True when object storage is real AWS S3 (no custom endpoint configured).
 *
 * Rekognition takes images either as raw `Bytes` or as an `S3Object{Bucket,Name}`
 * reference, and the reference form only works against an AWS S3 bucket in
 * Rekognition's own region. Every call in `lib/rekognition.client.ts` that
 * matters already uses `Bytes` (sourced from `storageService.getObjectBuffer`,
 * which follows whichever provider is configured), so R2 works as-is. This flag
 * gates the handful of places that additionally *prefer* the S3Object shortcut,
 * plus Face Liveness `OutputConfig`, which has AWS write into the bucket itself.
 */
export const isAwsS3 = !env.S3_ENDPOINT_URL

/**
 * Which object store this process actually resolved, for logging and health output.
 *
 * The provider is chosen entirely at runtime from `.env` - the code is identical on
 * every branch - so the one failure mode nothing else catches is a host whose env
 * does not match its environment. A GCP box missing `S3_ENDPOINT_URL` boots happily
 * and writes uploads into the AWS bucket. Surfacing the resolved target at boot and
 * on `/health/ready` makes that visible in one line instead of being discovered when
 * objects turn up missing.
 *
 * Contains no credentials - bucket names and the public origin are not secrets.
 */
export const storageTarget = {
  provider: isAwsS3 ? ('aws-s3' as const) : ('s3-compatible' as const),
  bucket: s3Bucket || null,
  region: env.S3_REGION ?? env.AWS_REGION,
  endpoint: env.S3_ENDPOINT_URL ?? null,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  publicBaseUrl: env.S3_PUBLIC_BASE_URL ?? env.CLOUDFRONT_DOMAIN ?? null,
}

/** One-line, secret-free summary for the startup log. */
export function describeStorageTarget(): string {
  return [
    `provider=${storageTarget.provider}`,
    `bucket=${storageTarget.bucket ?? '<unset>'}`,
    `region=${storageTarget.region}`,
    `endpoint=${storageTarget.endpoint ?? '<aws-default>'}`,
    `publicBaseUrl=${storageTarget.publicBaseUrl ?? '<bucket-hosted>'}`,
  ].join(' ')
}

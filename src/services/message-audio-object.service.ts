import { AppError } from '../middlewares/errorHandler'
import { rootLogger } from '../utils/rootLogger'
import {
  AUDIO_ALLOWED_MIMES,
  guessAudioMimeFromKey,
  MESSAGING_AUDIO_MAX_DURATION_SEC,
  MESSAGING_AUDIO_WAV_MAX_BYTES,
  normalizeAudioMime,
} from '../lib/message-audio.constants'
import { storageService } from './storage.service'

const AUDIO_MAX_BYTES_DEFAULT = 25 * 1024 * 1024

function maxBytesForMime(mime: string): number {
  const n = normalizeAudioMime(mime)
  if (n === 'audio/wav' || n === 'audio/x-wav' || n === 'audio/wave') {
    return MESSAGING_AUDIO_WAV_MAX_BYTES
  }
  return AUDIO_MAX_BYTES_DEFAULT
}

function isAllowedAudioMime(mime: string): boolean {
  return (AUDIO_ALLOWED_MIMES as readonly string[]).includes(normalizeAudioMime(mime))
}

export type VerifyAudioObjectParams = {
  s3Key: string
  /**
   * Optional client hint; when missing or unknown, MIME is taken from S3 **Content-Type** or from the key extension.
   * If both client and S3 provide a MIME and they disagree (after normalization), the request is rejected.
   */
  declaredMimeType?: string
  /**
   * Optional; when set, must equal S3 **Content-Length** exactly.
   * When omitted, the server uses the object size from S3 (avoids client/S3 drift after upload).
   */
  declaredSizeBytes?: number
  /** Optional client-supplied SHA-256 hex (must match S3 checksum when object was uploaded with checksum). */
  declaredChecksumSha256?: string
}

function resolveEffectiveAudioMime(params: {
  declaredMimeType?: string
  headContentType?: string
  s3Key: string
}): string {
  const declaredNorm = params.declaredMimeType?.trim()
    ? normalizeAudioMime(params.declaredMimeType)
    : ''
  const headNorm = params.headContentType?.trim()
    ? normalizeAudioMime(params.headContentType)
    : ''
  const fromKey = guessAudioMimeFromKey(params.s3Key)

  if (declaredNorm && isAllowedAudioMime(declaredNorm)) {
    if (headNorm && isAllowedAudioMime(headNorm) && headNorm !== declaredNorm) {
      rootLogger
        .child({ module: 'message-audio-object' })
        .warn({ s3Key: params.s3Key, declaredNorm, headNorm }, 'audio MIME client vs S3 mismatch')
      throw new AppError(400, 'Audio MIME does not match object Content-Type', 'INVALID_MEDIA_OBJECT')
    }
    return declaredNorm
  }
  if (headNorm && isAllowedAudioMime(headNorm)) {
    return headNorm
  }
  if (fromKey && isAllowedAudioMime(fromKey)) {
    return fromKey
  }
  throw new AppError(
    400,
    'Could not determine audio MIME (set mimeType, upload with a known Content-Type, or use a standard file extension on the key)',
    'INVALID_REQUEST',
  )
}

/**
 * Validates the object exists in our bucket and matches declared audio constraints.
 * Call **before** the send transaction (does not hold row locks).
 */
export async function verifyUploadedAudioObject(
  params: VerifyAudioObjectParams,
): Promise<{ contentLength: number; contentType: string; checksumSha256?: string }> {
  const { s3Key, declaredMimeType, declaredSizeBytes, declaredChecksumSha256 } = params
  if (s3Key.includes('..') || s3Key.includes('//') || s3Key.startsWith('/') || s3Key.length > 500) {
    throw new AppError(400, 'Invalid media key', 'INVALID_REQUEST')
  }

  const meta = await storageService.headObjectMetadata(s3Key)
  if (meta.contentLength <= 0) {
    throw new AppError(400, 'Empty audio object', 'INVALID_MEDIA_OBJECT')
  }

  const effectiveMime = resolveEffectiveAudioMime({
    declaredMimeType,
    headContentType: meta.contentType,
    s3Key,
  })

  const maxB = maxBytesForMime(effectiveMime)
  if (meta.contentLength > maxB) {
    throw new AppError(400, 'Audio object exceeds size limit', 'INVALID_MEDIA_OBJECT')
  }

  if (declaredSizeBytes !== undefined && declaredSizeBytes !== meta.contentLength) {
    throw new AppError(400, 'Audio size does not match uploaded object', 'INVALID_MEDIA_OBJECT')
  }

  if (declaredChecksumSha256 && meta.checksumSha256) {
    const a = declaredChecksumSha256.toLowerCase()
    const b = meta.checksumSha256.toLowerCase()
    if (a !== b) {
      throw new AppError(400, 'Audio checksum mismatch', 'INVALID_MEDIA_OBJECT')
    }
  }

  return {
    contentLength: meta.contentLength,
    contentType: effectiveMime,
    checksumSha256: meta.checksumSha256,
  }
}

export function assertAudioDurationAllowed(durationSec: number | undefined): void {
  if (durationSec === undefined) return
  if (!Number.isFinite(durationSec) || durationSec < 1 || durationSec > MESSAGING_AUDIO_MAX_DURATION_SEC) {
    throw new AppError(
      400,
      `durationSec must be between 1 and ${MESSAGING_AUDIO_MAX_DURATION_SEC}`,
      'INVALID_REQUEST',
    )
  }
}

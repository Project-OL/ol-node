import type { MediaType, MessageType } from '@prisma/client'
import { MediaProcessingStatus, MediaTranscriptionStatus } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import type { SendMessageInput } from '../models/messaging.schemas'
import type { MediaItemInput } from '../repositories/message.repository'
import {
  assertAudioDurationAllowed,
  verifyUploadedAudioObject,
} from './message-audio-object.service'
import { AUDIO_CODEC_VALUES, type AudioCodecValue } from '../lib/message-audio.constants'
import {
  assertValidWaveformPeaksNormalized,
  encodeWaveformPeaksNormalized,
} from '../lib/message-audio-waveform'

type MediaRow = NonNullable<SendMessageInput['mediaItems']>[number]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Preferred production key layout + legacy per-user prefix (older clients). */
export function assertAudioS3KeyAllowed(
  senderId: string,
  conversationId: string,
  s3Key: string,
): void {
  if (s3Key.includes('..') || s3Key.includes('//') || s3Key.startsWith('/')) {
    throw new AppError(400, 'Invalid media key', 'INVALID_REQUEST')
  }
  const scoped = new RegExp(
    `^messaging/audio/${escapeRegExp(conversationId)}/\\d{4}/\\d{2}/[a-f0-9-]+\\.([a-z0-9]+)$`,
    'i',
  )
  const legacy = new RegExp(`^messaging/${escapeRegExp(senderId)}/`)
  if (!scoped.test(s3Key) && !legacy.test(s3Key)) {
    throw new AppError(
      400,
      'Audio object key must use conversation-scoped upload path or legacy messaging prefix',
      'INVALID_REQUEST',
    )
  }
}

export function assertMediaOrdersContiguous(items: MediaRow[]): void {
  const orders = items.map((item, i) => item.order ?? i).sort((a, b) => a - b)
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) {
      throw new AppError(400, 'mediaItems order must be contiguous from 0', 'INVALID_REQUEST')
    }
  }
}

export function assertMessageTypeMediaAlignment(
  type: MessageType,
  items: MediaRow[] | undefined,
): void {
  if (type === 'TEXT_COINS' || type === 'GIFT') {
    if (items?.length) {
      throw new AppError(400, `${type} must not include media`, 'INVALID_REQUEST')
    }
    return
  }
  if (!items || items.length === 0) {
    if (type === 'TEXT') return
    throw new AppError(400, 'Media message requires mediaItems', 'INVALID_REQUEST')
  }
  assertMediaOrdersContiguous(items)
  if (type === 'AUDIO') {
    if (items.length !== 1 || items[0]!.mediaType !== 'AUDIO') {
      throw new AppError(
        400,
        'AUDIO messages require exactly one AUDIO media item',
        'INVALID_REQUEST',
      )
    }
  }
  if (type === 'TEXT' && items.length > 0) {
    throw new AppError(400, 'TEXT messages must not include mediaItems', 'INVALID_REQUEST')
  }
}

function toCodec(v: string | undefined): string | undefined {
  if (!v) return undefined
  const lower = v.toLowerCase()
  if ((AUDIO_CODEC_VALUES as readonly string[]).includes(lower)) return lower
  throw new AppError(400, 'Invalid audio codec field', 'INVALID_REQUEST')
}

/**
 * Validates S3 objects (audio) and returns DB-ready rows with authoritative processing flags.
 */
export async function prepareMediaItemsForSend(params: {
  senderId: string
  conversationId: string
  messageType: MessageType
  items: MediaRow[]
}): Promise<MediaItemInput[]> {
  const { senderId, conversationId, messageType, items } = params
  const out: MediaItemInput[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.mediaType === 'AUDIO' && messageType !== 'AUDIO') {
      throw new AppError(400, 'AUDIO media items require message type AUDIO', 'INVALID_REQUEST')
    }
    if (item.mediaType === 'AUDIO') {
      assertAudioS3KeyAllowed(senderId, conversationId, item.s3Key)
      assertAudioDurationAllowed(item.durationSec)
      const verified = await verifyUploadedAudioObject({
        s3Key: item.s3Key,
        declaredMimeType: item.mimeType?.trim() || undefined,
        declaredSizeBytes: item.sizeBytes,
        declaredChecksumSha256: item.checksumSha256,
      })
      let waveformJson: MediaItemInput['waveformJson']
      if (item.waveformPeaksNormalized?.length) {
        assertValidWaveformPeaksNormalized(item.waveformPeaksNormalized)
        waveformJson = encodeWaveformPeaksNormalized(item.waveformPeaksNormalized) as object
      }
      const processingStatus: MediaProcessingStatus = waveformJson
        ? MediaProcessingStatus.READY
        : MediaProcessingStatus.ENQUEUED
      const codec = toCodec(item.codec) as AudioCodecValue | undefined
      out.push({
        s3Key: item.s3Key,
        s3Bucket: '',
        mediaType: 'AUDIO' as MediaType,
        fileName: item.fileName,
        mimeType: item.mimeType ?? verified.contentType,
        sizeBytes: item.sizeBytes ?? verified.contentLength,
        durationSec: item.durationSec,
        width: item.width,
        height: item.height,
        order: item.order ?? i,
        waveformJson,
        codec,
        bitrate: item.bitrate,
        sampleRate: item.sampleRate,
        channels: item.channels,
        processingStatus,
        transcriptionStatus: MediaTranscriptionStatus.NONE,
        checksumSha256: item.checksumSha256?.toLowerCase(),
      })
    } else {
      out.push({
        s3Key: item.s3Key,
        s3Bucket: '',
        mediaType: item.mediaType as MediaType,
        fileName: item.fileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        durationSec: item.durationSec,
        width: item.width,
        height: item.height,
        order: item.order ?? i,
        processingStatus: MediaProcessingStatus.NONE,
        transcriptionStatus: MediaTranscriptionStatus.NONE,
      })
    }
  }
  if (messageType !== 'AUDIO') {
    for (const row of out) {
      if (row.mediaType === 'AUDIO') {
        throw new AppError(400, 'AUDIO media only allowed on AUDIO messages', 'INVALID_REQUEST')
      }
    }
  }
  return out
}

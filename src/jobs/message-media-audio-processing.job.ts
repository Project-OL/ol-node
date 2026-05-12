import { MediaProcessingStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { redisClient } from '../config/redis'
import { RedisKeys } from '../config/redis'
import { rootLogger } from '../utils/rootLogger'
import { publishServerFrameToConversation } from '../utils/ws-publisher'
import { storageService } from '../services/storage.service'
import type { ServerFrame } from '../realtime/types'

const log = rootLogger.child({ module: 'message-media-audio-job' })

/**
 * Async audio sidecar: waveform extraction, transcoding, moderation, transcription — **queue-only**.
 * This handler is idempotent and safe under retries (only transitions ENQUEUED → READY).
 */
export async function processMessageMediaAudioJob(messageMediaId: string): Promise<void> {
  const row = await prisma.messageMedia.findUnique({
    where: { id: messageMediaId },
    include: { message: { select: { id: true, conversationId: true, seq: true } } },
  })
  if (!row) {
    log.warn({ messageMediaId }, 'message_media missing — ack')
    return
  }
  if (row.mediaType !== 'AUDIO') return
  if (row.processingStatus !== MediaProcessingStatus.ENQUEUED) return

  const t0 = Date.now()

  const updated = await prisma.messageMedia.updateMany({
    where: { id: messageMediaId, processingStatus: MediaProcessingStatus.ENQUEUED },
    data: { processingStatus: MediaProcessingStatus.READY },
  })
  if (updated.count === 0) return

  const fresh = await prisma.messageMedia.findUniqueOrThrow({
    where: { id: messageMediaId },
  })

  await redisClient.del(RedisKeys.convMessages(row.message.conversationId)).catch(() => {})

  const frame: ServerFrame = {
    t: 'MESSAGE_MEDIA_UPDATE',
    conversationId: row.message.conversationId,
    messageId: row.message.id,
    mediaItemId: fresh.id,
    seq: Number(row.message.seq),
    processingStatus: fresh.processingStatus,
    transcriptionStatus: fresh.transcriptionStatus,
    waveformJson: fresh.waveformJson === null ? undefined : fresh.waveformJson,
    durationSec: fresh.durationSec,
    codec: fresh.codec,
    bitrate: fresh.bitrate,
    sampleRate: fresh.sampleRate,
    channels: fresh.channels,
    streamingUrl: storageService.getCdnOrS3PublicUrl(fresh.s3Key),
  }

  await publishServerFrameToConversation(row.message.conversationId, frame)

  log.info(
    {
      messageMediaId,
      conversationId: row.message.conversationId,
      ms: Date.now() - t0,
    },
    'audio_media_processing_complete',
  )
}

import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  MESSAGE_MEDIA_AUDIO_PROCESS_JOB,
  MESSAGE_MEDIA_AUDIO_QUEUE,
} from './message-media-audio.constants'

const jobOpts = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: 5000,
  removeOnFail: 2000,
}

export const messageMediaAudioQueue = new Queue(MESSAGE_MEDIA_AUDIO_QUEUE, {
  connection: redisClient,
})

export async function enqueueMessageMediaAudioProcessing(messageMediaId: string): Promise<void> {
  await messageMediaAudioQueue.add(MESSAGE_MEDIA_AUDIO_PROCESS_JOB, { messageMediaId }, jobOpts)
}

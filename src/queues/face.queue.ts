import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { FACE_INDEXING_QUEUE, FACE_INDEX_JOB_INDEX } from './face.constants'

export const faceIndexingQueue = new Queue(FACE_INDEXING_QUEUE, {
  connection: redisClient,
})

export async function enqueueFaceIndexingJob(payload: {
  userId: string
  faceProfileId: string
  s3Key: string
}) {
  await faceIndexingQueue.add(FACE_INDEX_JOB_INDEX, payload, {
    jobId: `face-index-${payload.faceProfileId}`,
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 4,
    backoff: { type: 'exponential', delay: 2000 },
  })
}


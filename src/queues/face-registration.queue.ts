import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  FACE_REGISTRATION_QUEUE,
  FACE_REGISTRATION_VERIFY_JOB,
} from './face-registration.constants'

const verifyJobOpts = {
  /** Rekognition may stay IN_PROGRESS until the client finishes the Face Liveness SDK. */
  attempts: 15,
  backoff: { type: 'exponential' as const, delay: 3000 },
  removeOnComplete: 2000,
  removeOnFail: 5000,
}

export const faceRegistrationQueue = new Queue(FACE_REGISTRATION_QUEUE, {
  connection: redisClient,
})

export type FaceRegistrationVerifyJobData = {
  sessionId: string
  userId: string
  idempotencyKey: string
  requestId?: string
}

export async function enqueueFaceRegistrationVerification(
  data: FaceRegistrationVerifyJobData,
): Promise<void> {
  await faceRegistrationQueue.add(FACE_REGISTRATION_VERIFY_JOB, data, {
    ...verifyJobOpts,
    jobId: `face-reg-${data.sessionId}-${data.idempotencyKey}`,
  })
}

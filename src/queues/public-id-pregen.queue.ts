import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { PUBLIC_ID_PREGEN_HORIZON_JOB, PUBLIC_ID_PREGEN_QUEUE } from './public-id-pregen.constants'

export const publicIdPregenQueue = new Queue(PUBLIC_ID_PREGEN_QUEUE, {
  connection: redisClient,
})

export async function schedulePublicIdPregen(): Promise<void> {
  await publicIdPregenQueue.add(
    PUBLIC_ID_PREGEN_HORIZON_JOB,
    {},
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'pregen-horizon-recurring',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  )
}

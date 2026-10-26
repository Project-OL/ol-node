import type { Job } from 'bullmq'
import { runShadowWorkerTick } from '../services/luckyWater/shadowWorker.service'

export async function processLuckyShadowWorkerJob(_job: Job): Promise<void> {
  const result = await runShadowWorkerTick()
  if (result.processed > 0 || result.errors > 0) {
    console.info('[lucky-shadow-worker] tick', result)
  }
}

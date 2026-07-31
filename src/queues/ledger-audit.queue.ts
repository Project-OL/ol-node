import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { LEDGER_AUDIT_JOB, LEDGER_AUDIT_QUEUE } from './ledger-audit.constants'
import { randomUUID } from 'crypto'

export type LedgerAuditJobData = {
  triggeredByAdminId?: string
  windowStartIso?: string
  windowEndIso?: string
}

export const ledgerAuditQueue = new Queue(LEDGER_AUDIT_QUEUE, {
  connection: redisClient,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
})

export async function enqueueLedgerAuditRun(data: LedgerAuditJobData = {}): Promise<string> {
  const job = await ledgerAuditQueue.add(LEDGER_AUDIT_JOB, data, {
    jobId: `ledger-audit-manual-${randomUUID()}`,
  })
  return job.id ?? ''
}

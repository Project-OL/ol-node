import type { Job } from 'bullmq'
import { ledgerAuditService } from '../services/ledgerAudit.service'
import type { LedgerAuditJobData } from '../queues/ledger-audit.queue'

export async function processLedgerAuditJob(job: Job<LedgerAuditJobData>) {
  const windowStart = job.data.windowStartIso ? new Date(job.data.windowStartIso) : undefined
  const windowEnd = job.data.windowEndIso ? new Date(job.data.windowEndIso) : undefined
  const result = await ledgerAuditService.runOvernightAudit({ windowStart, windowEnd })
  console.info('[Ledger audit] completed', {
    jobId: job.id,
    triggeredByAdminId: job.data.triggeredByAdminId ?? null,
    ...result,
  })
  return result
}

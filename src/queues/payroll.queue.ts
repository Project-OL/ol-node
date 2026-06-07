import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  PAYROLL_SLA_JOB,
  PAYROLL_SLA_JOB_ID,
  PAYROLL_SLA_QUEUE,
  PAYROLL_WAITING_JOB,
  PAYROLL_WAITING_JOB_ID,
} from './payroll.constants'

export const payrollSlaQueue = new Queue(PAYROLL_SLA_QUEUE, {
  connection: redisClient,
})

export function msUntil(expiresAt: Date): number {
  return Math.max(0, expiresAt.getTime() - Date.now())
}

export async function enqueuePayrollSla(assignmentId: string, expiresAt: Date): Promise<void> {
  await payrollSlaQueue.add(
    PAYROLL_SLA_JOB,
    { assignmentId },
    {
      jobId: PAYROLL_SLA_JOB_ID(assignmentId),
      delay: msUntil(expiresAt),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  )
}

export async function removePayrollSla(assignmentId: string): Promise<void> {
  try {
    const job = await payrollSlaQueue.getJob(PAYROLL_SLA_JOB_ID(assignmentId))
    if (job) await job.remove()
  } catch {
    /* job may already be consumed */
  }
}

export async function enqueuePayrollWaiting(
  assignmentId: string,
  waitingExpiresAt: Date,
): Promise<void> {
  const delay = msUntil(waitingExpiresAt)
  await payrollSlaQueue.add(
    PAYROLL_WAITING_JOB,
    { assignmentId, jobType: 'waiting-auto-complete' },
    {
      jobId: PAYROLL_WAITING_JOB_ID(assignmentId),
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  )
}

export async function removePayrollWaiting(assignmentId: string): Promise<void> {
  try {
    const job = await payrollSlaQueue.getJob(PAYROLL_WAITING_JOB_ID(assignmentId))
    if (job) await job.remove()
  } catch {
    /* job may already be consumed */
  }
}

import type { Job } from 'bullmq'
import { VIP_MEMBERSHIP_EXPIRY_JOB } from '../queues/vip-membership.constants'
import { vipMembershipService } from '../services/vip-membership.service'

export async function processVipMembershipExpiryJob(job: Job<{ userId: string }>): Promise<void> {
  if (job.name !== VIP_MEMBERSHIP_EXPIRY_JOB) return
  await vipMembershipService.processExpiryJob({ userId: job.data.userId })
}

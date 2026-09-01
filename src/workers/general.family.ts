import type Redis from 'ioredis'
import { Queue, Worker, type Job } from 'bullmq'
import { env } from '../config/env'
import { mapPool } from '../utils/map-pool'
import { prisma } from '../config/database'
import { runAccountDeletionJob } from '../jobs/account-deletion.job'
import { runFaceRegistrationSweepJob } from '../jobs/face-registration-sweep.job'
import { WALLET_WITHDRAWAL_QUEUE } from '../queues/wallet-withdrawal.constants'
import { WALLET_LEVEL_BACKFILL_QUEUE } from '../queues/wallet-level-backfill.constants'
import { runWalletLevelBackfillForUser } from '../jobs/wallet-level-backfill.job'
import {
  SUBSCRIPTION_GRACE_QUEUE,
  SUBSCRIPTION_RENEWAL_QUEUE,
} from '../queues/subscription.constants'
import { subscriptionService } from '../services/subscription.service'
import { GUARDIAN_EXPIRY_QUEUE } from '../queues/guardian.constants'
import { guardianService } from '../services/guardian.service'
import {
  RARE_ID_EXPIRY_JOB,
  STORE_ITEM_EXPIRY_JOB,
  STORE_ITEM_EXPIRY_QUEUE,
} from '../queues/store-item-expiry.constants'
import { storeService } from '../services/store.service'
import { SUPPORT_AUTOCLOSE_QUEUE } from '../queues/support-autoclose.constants'
import { supportService } from '../services/support.service'
import {
  PUBLIC_ID_PREGEN_HORIZON_JOB,
  PUBLIC_ID_PREGEN_QUEUE,
} from '../queues/public-id-pregen.constants'
import { publicIdPreGenerationService } from '../services/public-id-pre-generation.service'
import { RICH_TIER_JOB_MASTER, RICH_TIER_ROLLOVER_QUEUE } from '../queues/rich-tier.constants'
import { processRichTierRolloverJob } from '../jobs/rich-tier-rollover.job'
import {
  VIP_MEMBERSHIP_EXPIRY_JOB,
  VIP_MEMBERSHIP_EXPIRY_QUEUE,
} from '../queues/vip-membership.constants'
import { processVipMembershipExpiryJob } from '../jobs/vip-membership-expiry.job'
import {
  AGENCY_LEAVE_AUTO_APPROVE_QUEUE,
  AGENCY_LEAVE_SAFETY_NET_JOB,
} from '../queues/agency.constants'
import { agencyLeaveAutoApproveQueue } from '../queues/agency.queue'
import { processAgencyLeaveWorkerJob } from '../jobs/agency-leave-auto-approve.job'
import {
  AGENCY_LEVEL_JOB_MASTER,
  AGENCY_LEVEL_RECOMPUTE_QUEUE,
} from '../queues/agency-commission.constants'
import { agencyLevelRecomputeQueue } from '../queues/agency-commission.queue'
import { processAgencyLevelRecomputeJob } from '../jobs/agency-level-recompute.job'
import { EPAY_WEBHOOK_RETRY_JOB, EPAY_WEBHOOK_RETRY_QUEUE } from '../queues/epay-webhook.constants'
import { coinWalletService } from '../services/coin-wallet.service'
import { coinTradingService } from '../services/coinTrading.service'
import {
  PAYROLL_SLA_JOB,
  PAYROLL_SLA_QUEUE,
  PAYROLL_SAFETY_NET_JOB,
  PAYROLL_WAITING_JOB,
  PAYROLL_PLATFORM_WAITING_JOB,
} from '../queues/payroll.constants'
import { payrollSlaQueue } from '../queues/payroll.queue'
import {
  processPayrollSlaJob,
  processWaitingAutoComplete,
  processPlatformWaitingAutoComplete,
  runPayrollSlaSafetyNet,
} from '../jobs/payroll-sla.job'
import { LIVE_SESSION_JOBS, LIVE_SESSION_QUEUE } from '../queues/live-session.constants'
import { liveSessionQueue } from '../queues/live-session.queue'
import { liveSessionRepository } from '../repositories/liveSession.repository'
import { liveSessionService } from '../services/liveSession.service'
import { platformMessagingService } from '../services/platformMessaging.service'
import { LEDGER_AUDIT_JOB, LEDGER_AUDIT_QUEUE } from '../queues/ledger-audit.constants'
import { processLedgerAuditJob } from '../jobs/ledger-audit.job'
import type { LedgerAuditJobData } from '../queues/ledger-audit.queue'
import {
  LEDGER_FLOAT_SNAPSHOT_JOB,
  LEDGER_FLOAT_SNAPSHOT_QUEUE,
} from '../queues/ledger-float-snapshot.constants'
import { processLedgerFloatSnapshotJob } from '../jobs/ledger-float-snapshot.job'
import { RANKING_BACKFILL_QUEUE } from '../queues/ranking.constants'
import { registerRankingReconcileJob } from '../queues/ranking.queue'
import { processRankingBackfillJob } from '../jobs/ranking-backfill.job'
import type { WorkerFamily } from './family'

const ACCOUNT_DELETION_QUEUE = 'account-deletion'
const FACE_REGISTRATION_SWEEP_QUEUE = 'face-registration-sweep'

/**
 * Payroll, expiry, agency, live-session, and other non-chat workers.
 */
export async function startGeneralWorkerFamily(connection: Redis): Promise<WorkerFamily> {
  await registerRankingReconcileJob()

  const accountDeletionQueue = new Queue(ACCOUNT_DELETION_QUEUE, { connection })
  await accountDeletionQueue.add(
    'run',
    {},
    {
      jobId: 'account-deletion-daily-2am',
      repeat: { pattern: '0 2 * * *' },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  )
  await accountDeletionQueue.add(
    'sweep',
    {},
    {
      jobId: 'account-deletion-sweep-5min',
      repeat: { every: 5 * 60 * 1000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  )

  const faceRegistrationSweepQueue = new Queue(FACE_REGISTRATION_SWEEP_QUEUE, { connection })
  await faceRegistrationSweepQueue.add(
    'sweep',
    {},
    {
      jobId: 'face-registration-sweep-10min',
      repeat: { every: 10 * 60 * 1000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  )

  const ledgerAuditQueue = new Queue(LEDGER_AUDIT_QUEUE, { connection })
  await ledgerAuditQueue.add(LEDGER_AUDIT_JOB, {} satisfies LedgerAuditJobData, {
    jobId: 'ledger-audit-daily-3am-utc',
    repeat: { pattern: '0 3 * * *', tz: 'UTC' },
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: 50,
    removeOnFail: 50,
  })

  const ledgerAuditWorker = new Worker(
    LEDGER_AUDIT_QUEUE,
    async (job: Job<LedgerAuditJobData>) => processLedgerAuditJob(job),
    { connection, concurrency: 1 },
  )

  const ledgerFloatSnapshotQueue = new Queue(LEDGER_FLOAT_SNAPSHOT_QUEUE, { connection })
  await ledgerFloatSnapshotQueue.add(
    LEDGER_FLOAT_SNAPSHOT_JOB,
    {},
    {
      jobId: 'ledger-float-snapshot-daily-1am-utc',
      repeat: { pattern: '0 1 * * *', tz: 'UTC' },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 30,
      removeOnFail: 30,
    },
  )

  const ledgerFloatSnapshotWorker = new Worker(
    LEDGER_FLOAT_SNAPSHOT_QUEUE,
    async (job: Job) => processLedgerFloatSnapshotJob(job),
    { connection, concurrency: 1 },
  )

  const rankingBackfillWorker = new Worker(
    RANKING_BACKFILL_QUEUE,
    async (job: Job) => processRankingBackfillJob(job),
    { connection, concurrency: 1 },
  )

  const accountDeletionWorker = new Worker(
    ACCOUNT_DELETION_QUEUE,
    async (_job: Job) => {
      await runAccountDeletionJob()
    },
    { connection, concurrency: 3 },
  )

  const faceRegistrationSweepWorker = new Worker(
    FACE_REGISTRATION_SWEEP_QUEUE,
    async (_job: Job) => {
      await runFaceRegistrationSweepJob()
    },
    { connection, concurrency: 1 },
  )

  const withdrawalWorker = new Worker(
    WALLET_WITHDRAWAL_QUEUE,
    async (job: Job<{ withdrawalId: string; userId: string }>) => {
      const { withdrawalId, userId } = job.data
      console.info('[Wallet Withdrawal] Processing', { withdrawalId, userId })
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const levelBackfillWorker = new Worker(
    WALLET_LEVEL_BACKFILL_QUEUE,
    async (job: Job<{ userId: string }>) => {
      await runWalletLevelBackfillForUser(job.data.userId)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const subscriptionRenewalWorker = new Worker(
    SUBSCRIPTION_RENEWAL_QUEUE,
    async (job: Job<{ subscriptionId: string }>) => {
      await subscriptionService.processRenewalJob(job.data.subscriptionId)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const subscriptionGraceWorker = new Worker(
    SUBSCRIPTION_GRACE_QUEUE,
    async (job: Job<{ subscriptionId: string }>) => {
      await subscriptionService.processGraceJob(job.data.subscriptionId)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const guardianExpiryWorker = new Worker(
    GUARDIAN_EXPIRY_QUEUE,
    async (job: Job<{ guardianId: string }>) => {
      await guardianService.processExpiryJob(job.data.guardianId)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const storeItemExpiryWorker = new Worker(
    STORE_ITEM_EXPIRY_QUEUE,
    async (job: Job<{ userStoreItemId?: string; assignmentId?: string }>) => {
      if (job.name === STORE_ITEM_EXPIRY_JOB) {
        await storeService.processExpiryJob(job.data.userStoreItemId!)
      } else if (job.name === RARE_ID_EXPIRY_JOB) {
        await storeService.processRareIdExpiryJob(job.data.assignmentId!)
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const supportAutocloseWorker = new Worker(
    SUPPORT_AUTOCLOSE_QUEUE,
    async (job: Job<{ ticketId: string }>) => {
      await supportService.processAutocloseJob(BigInt(job.data.ticketId))
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const publicIdPregenWorker = new Worker(
    PUBLIC_ID_PREGEN_QUEUE,
    async (job: Job) => {
      if (job.name === PUBLIC_ID_PREGEN_HORIZON_JOB) {
        await publicIdPreGenerationService.runHorizonJob()
      }
    },
    { connection, concurrency: 1 },
  )

  const richTierRolloverQueue = new Queue(RICH_TIER_ROLLOVER_QUEUE, { connection })
  await richTierRolloverQueue.add(
    RICH_TIER_JOB_MASTER,
    {},
    {
      repeat: { pattern: '5 0 1 * *', tz: 'UTC' },
      jobId: 'rich-tier-repeatable-master-utc',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  )

  const richTierRolloverWorker = new Worker(
    RICH_TIER_ROLLOVER_QUEUE,
    async (job: Job) => {
      await processRichTierRolloverJob(job)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const vipMembershipExpiryWorker = new Worker(
    VIP_MEMBERSHIP_EXPIRY_QUEUE,
    async (job: Job<{ userId: string }>) => {
      if (job.name === VIP_MEMBERSHIP_EXPIRY_JOB) {
        await processVipMembershipExpiryJob(job)
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  await agencyLeaveAutoApproveQueue.add(
    AGENCY_LEAVE_SAFETY_NET_JOB,
    {},
    {
      repeat: { pattern: '0 * * * *', tz: 'UTC' },
      jobId: 'agency-leave-safety-net-hourly-utc',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  )

  const agencyLeaveWorker = new Worker(
    AGENCY_LEAVE_AUTO_APPROVE_QUEUE,
    async (job: Job<{ applicationId?: string }>) => {
      await processAgencyLeaveWorkerJob(job)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  await agencyLevelRecomputeQueue.add(
    AGENCY_LEVEL_JOB_MASTER,
    {},
    {
      repeat: { pattern: '0 0 * * *', tz: 'UTC' },
      jobId: 'agency-level-recompute-repeatable-master-utc',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  )

  const agencyLevelRecomputeWorker = new Worker(
    AGENCY_LEVEL_RECOMPUTE_QUEUE,
    async (job: Job) => {
      await processAgencyLevelRecomputeJob(job)
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  await payrollSlaQueue.add(
    PAYROLL_SAFETY_NET_JOB,
    {},
    {
      repeat: { pattern: '10 * * * *', tz: 'UTC' },
      jobId: 'payroll-sla-safety-net-hourly-utc',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  )

  const payrollSlaWorker = new Worker(
    PAYROLL_SLA_QUEUE,
    async (job: Job<{ assignmentId?: string; withdrawalId?: string }>) => {
      if (job.name === PAYROLL_SLA_JOB) {
        const id = job.data?.assignmentId
        if (id) await processPayrollSlaJob({ assignmentId: id })
      } else if (job.name === PAYROLL_WAITING_JOB) {
        const id = job.data?.assignmentId
        if (id) await processWaitingAutoComplete(id)
      } else if (job.name === PAYROLL_PLATFORM_WAITING_JOB) {
        const id = job.data?.withdrawalId
        if (id) await processPlatformWaitingAutoComplete(id)
      } else if (job.name === PAYROLL_SAFETY_NET_JOB) {
        await runPayrollSlaSafetyNet()
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  const epayWebhookRetryWorker = new Worker(
    EPAY_WEBHOOK_RETRY_QUEUE,
    async (job: Job<{ payload: any; orderType: 'PERSONAL_TOPUP' | 'TRADING_TOPUP' }>) => {
      if (job.name !== EPAY_WEBHOOK_RETRY_JOB) return
      const payload = job.data.payload
      if (job.data.orderType === 'PERSONAL_TOPUP') {
        await coinWalletService.confirmTopup(
          payload.userId,
          payload.orderId,
          payload.gatewayRef,
          `epay-personal-topup:${payload.orderId}`,
        )
      } else {
        const order = await prisma.coinTradingTopupOrder.findUnique({
          where: { id: payload.orderId },
        })
        if (order) await coinTradingService.confirmTopup(order, payload)
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_DEFAULT },
  )

  await liveSessionQueue.add(
    LIVE_SESSION_JOBS.SAFETY_NET_CRON,
    {},
    {
      repeat: { pattern: '*/30 * * * *', tz: 'UTC' },
      jobId: 'live-session-safety-net-cron-utc',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  )

  const liveSessionWorker = new Worker(
    LIVE_SESSION_QUEUE,
    async (job: Job<{ sessionId?: string; hostUserId?: string }>) => {
      if (job.name === LIVE_SESSION_JOBS.NOTIFY_LIVE_SUBSCRIBERS) {
        const { hostUserId, sessionId } = job.data
        if (!hostUserId || !sessionId) return

        const subscribers = await prisma.broadcastReminder.findMany({
          where: { creatorId: hostUserId, notifyOnLive: true },
          select: { userId: true },
        })
        if (subscribers.length === 0) return

        const host = await prisma.user.findUnique({
          where: { id: hostUserId },
          select: { username: true },
        })
        const hostName = host?.username ?? 'Someone you follow'

        await mapPool(subscribers, env.WORKER_CONCURRENCY_PLATFORM_MESSAGE, async (sub) => {
          try {
            await platformMessagingService.sendPlatformMessage({
              targetUserId: sub.userId,
              type: 'NOTIFICATION',
              content: `${hostName} is live now!`,
              metadata: { category: 'notification', refId: sessionId },
              clientMessageId: `live-notify:${sessionId}:${sub.userId}`,
            })
          } catch (err) {
            console.error('[Live session] Failed to notify live subscriber', {
              err,
              hostUserId,
              subscriberId: sub.userId,
            })
          }
        })
      } else if (job.name === LIVE_SESSION_JOBS.SAFETY_NET_SESSION) {
        const { sessionId, hostUserId } = job.data
        if (!sessionId || !hostUserId) return

        const session = await prisma.hostLiveSession.findUnique({
          where: { id: sessionId },
          select: { status: true, startedAt: true },
        })

        if (!session || session.status !== 'ACTIVE') return

        console.warn('[Live session] Safety-net triggered — interrupting stale session', {
          sessionId,
          hostUserId,
        })
        await liveSessionService.interruptStaleSession(sessionId, hostUserId, session.startedAt)
      } else if (job.name === LIVE_SESSION_JOBS.SAFETY_NET_CRON) {
        const cutoff = new Date(Date.now() - env.LIVE_SESSION_TIMEOUT_HOURS * 60 * 60 * 1000)
        const stale = await liveSessionRepository.findStaleActiveSessions(cutoff)

        console.info('[Live session] Safety-net cron: found stale sessions', {
          count: stale.length,
        })

        for (const s of stale) {
          try {
            await liveSessionService.interruptStaleSession(s.id, s.hostUserId, s.startedAt)
          } catch (err) {
            console.error('[Live session] Safety-net failed to interrupt session', {
              err,
              sessionId: s.id,
            })
          }
        }
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY_LIVE_SESSION },
  )

  const onFail =
    (label: string) =>
    (job: Job | undefined, err: Error): void => {
      console.error(`[${label}] Job failed:`, job?.id, err)
    }

  accountDeletionWorker.on('failed', onFail('Account Deletion'))
  faceRegistrationSweepWorker.on('failed', onFail('Face Registration Sweep'))
  withdrawalWorker.on('failed', onFail('Wallet Withdrawal'))
  levelBackfillWorker.on('failed', onFail('Wallet Level Backfill'))
  subscriptionRenewalWorker.on('failed', onFail('Subscription renewal'))
  subscriptionGraceWorker.on('failed', onFail('Subscription grace'))
  guardianExpiryWorker.on('failed', onFail('Guardian expiry'))
  storeItemExpiryWorker.on('failed', onFail('Store item expiry'))
  supportAutocloseWorker.on('failed', onFail('Support autoclose'))
  publicIdPregenWorker.on('failed', onFail('Public ID pregen'))
  richTierRolloverWorker.on('failed', onFail('Rich tier rollover'))
  vipMembershipExpiryWorker.on('failed', onFail('VIP membership expiry'))
  agencyLeaveWorker.on('failed', onFail('Agency leave auto-approve'))
  agencyLevelRecomputeWorker.on('failed', onFail('Agency level recompute'))
  epayWebhookRetryWorker.on('failed', onFail('Epay webhook retry'))
  payrollSlaWorker.on('failed', onFail('Payroll SLA'))
  liveSessionWorker.on('failed', onFail('Live session'))
  ledgerAuditWorker.on('failed', onFail('Ledger audit'))
  ledgerFloatSnapshotWorker.on('failed', onFail('Ledger float snapshot'))
  rankingBackfillWorker.on('failed', onFail('Ranking backfill'))

  return {
    name: 'general',
    close: async () => {
      await liveSessionWorker.close()
      await liveSessionQueue.close()
      await ledgerAuditWorker.close()
      await ledgerAuditQueue.close()
      await ledgerFloatSnapshotWorker.close()
      await ledgerFloatSnapshotQueue.close()
      await payrollSlaWorker.close()
      await payrollSlaQueue.close()
      await epayWebhookRetryWorker.close()
      await agencyLevelRecomputeWorker.close()
      await agencyLevelRecomputeQueue.close()
      await agencyLeaveWorker.close()
      await rankingBackfillWorker.close()
      await agencyLeaveAutoApproveQueue.close()
      await vipMembershipExpiryWorker.close()
      await richTierRolloverWorker.close()
      await richTierRolloverQueue.close()
      await publicIdPregenWorker.close()
      await storeItemExpiryWorker.close()
      await supportAutocloseWorker.close()
      await guardianExpiryWorker.close()
      await subscriptionGraceWorker.close()
      await subscriptionRenewalWorker.close()
      await levelBackfillWorker.close()
      await withdrawalWorker.close()
      await accountDeletionWorker.close()
      await accountDeletionQueue.close()
      await faceRegistrationSweepWorker.close()
      await faceRegistrationSweepQueue.close()
    },
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const envMock = vi.hoisted(() => ({ ROYAL_HOST_WEEKLY_EVAL_ENABLED: false }))
vi.mock('../../src/config/env', () => ({ env: envMock }))

const userFindUnique = vi.fn()
vi.mock('../../src/config/database', () => ({
  prismaRead: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a) } },
}))

const setTags = vi.fn()
vi.mock('../../src/services/admin-user-tags.service', () => ({
  adminUserTagsService: { setTags: (...a: unknown[]) => setTags(...a) },
}))

const getConfig = vi.fn()
vi.mock('../../src/services/royalHostRewardConfig.service', () => ({
  royalHostRewardConfigService: { getConfig: (...a: unknown[]) => getConfig(...a) },
}))

const listTaggedUsers = vi.fn()
const getQualifyingEarningsForRange = vi.fn()
const getLatestEvaluation = vi.fn()
const upsertEvaluation = vi.fn()
vi.mock('../../src/repositories/royalHostReward.repository', () => ({
  royalHostRewardRepository: {
    listTaggedUsers: (...a: unknown[]) => listTaggedUsers(...a),
    getQualifyingEarningsForRange: (...a: unknown[]) => getQualifyingEarningsForRange(...a),
    getLatestEvaluation: (...a: unknown[]) => getLatestEvaluation(...a),
    upsertEvaluation: (...a: unknown[]) => upsertEvaluation(...a),
  },
}))

const auditLog = vi.fn()
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...a: unknown[]) => auditLog(...a) },
}))

const enqueueEvalBatch = vi.fn()
vi.mock('../../src/queues/royalHost.queue', () => ({
  enqueueEvalBatch: (...a: unknown[]) => enqueueEvalBatch(...a),
}))

import { processRoyalHostWeeklyEvalJob } from '../../src/jobs/royal-host-weekly-eval.job'
import { ROYAL_HOST_JOB_BATCH, ROYAL_HOST_JOB_MASTER } from '../../src/queues/royalHost.constants'

const WEEK = '2026-10-04'

function batchJob(userIds: string[]): Job {
  return { name: ROYAL_HOST_JOB_BATCH, data: { weekStart: WEEK, userIds } } as unknown as Job
}

describe('royal-host weekly eval job', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envMock.ROYAL_HOST_WEEKLY_EVAL_ENABLED = false
    getConfig.mockResolvedValue({
      autoRevokeEarningThresholdBigInt: 1_000_000n,
      consecutiveMissWeeksLimit: 3,
    })
  })

  it('master no-ops while ROYAL_HOST_WEEKLY_EVAL_ENABLED is off', async () => {
    await processRoyalHostWeeklyEvalJob({ name: ROYAL_HOST_JOB_MASTER, data: {} } as unknown as Job)
    expect(listTaggedUsers).not.toHaveBeenCalled()
    expect(enqueueEvalBatch).not.toHaveBeenCalled()
  })

  it('master fans tagged users out into batches when enabled', async () => {
    envMock.ROYAL_HOST_WEEKLY_EVAL_ENABLED = true
    listTaggedUsers.mockResolvedValueOnce(['u1', 'u2'])

    await processRoyalHostWeeklyEvalJob({
      name: ROYAL_HOST_JOB_MASTER,
      data: { weekStart: WEEK },
    } as unknown as Job)

    expect(enqueueEvalBatch).toHaveBeenCalledWith(new Date(WEEK), ['u1', 'u2'])
  })

  it('first missed week only counts the miss; the tag stays', async () => {
    getQualifyingEarningsForRange.mockResolvedValue(10n)
    getLatestEvaluation.mockResolvedValue(null)
    userFindUnique.mockResolvedValue({ adminTags: ['royal host'] })

    await processRoyalHostWeeklyEvalJob(batchJob(['u1']))

    expect(upsertEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        targetMet: false,
        consecutiveMissCountAfterThisWeek: 1,
        tagRevokedAfterThisWeek: false,
      }),
    )
    expect(setTags).not.toHaveBeenCalled()
  })

  it('third consecutive miss revokes the tag, matching it case-insensitively', async () => {
    getQualifyingEarningsForRange.mockResolvedValue(999_999n)
    getLatestEvaluation.mockResolvedValue({ consecutiveMissCountAfterThisWeek: 2 })
    userFindUnique.mockResolvedValue({ adminTags: ['Agency', ' Royal Host '] })

    await processRoyalHostWeeklyEvalJob(batchJob(['u1']))

    expect(upsertEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveMissCountAfterThisWeek: 3, tagRevokedAfterThisWeek: true }),
    )
    expect(setTags).toHaveBeenCalledWith('u1', ['Agency'])
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', actionType: 'SYSTEM_ROYAL_HOST_TAG_REVOKED' }),
    )
  })

  it('meeting the target resets the miss count', async () => {
    getQualifyingEarningsForRange.mockResolvedValue(1_000_000n)
    getLatestEvaluation.mockResolvedValue({ consecutiveMissCountAfterThisWeek: 2 })
    userFindUnique.mockResolvedValue({ adminTags: ['royal host'] })

    await processRoyalHostWeeklyEvalJob(batchJob(['u1']))

    expect(upsertEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ targetMet: true, consecutiveMissCountAfterThisWeek: 0, tagRevokedAfterThisWeek: false }),
    )
    expect(setTags).not.toHaveBeenCalled()
  })
})

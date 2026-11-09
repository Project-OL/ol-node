import { describe, it, expect, vi, beforeEach } from 'vitest'

// BullMQ 5 throws "Custom Id cannot contain :" for custom job ids with ':' unless they split
// into exactly 3 parts. These enqueue helpers build stable ids, so keep them colon-free.
const added: Array<{ name: string; opts: { jobId?: string } }> = []

vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, _data: unknown, opts: { jobId?: string }) {
      added.push({ name, opts })
      return { id: opts.jobId }
    }
  },
}))
vi.mock('../../src/config/redis', () => ({ redisClient: {} }))

import { enqueueRolloverBatch, enqueueRolloverMaster } from '../../src/queues/rich-tier.queue'
import {
  enqueueAgencyRecomputeBatch,
  enqueueAgencyRecomputeMaster,
} from '../../src/queues/agency-commission.queue'
import { enqueueEvalBatch, enqueueEvalMaster } from '../../src/queues/royalHost.queue'

const U1 = '0b6a6a3e-1f0e-4a43-9c55-0d1d3c1b2a01'
const U2 = 'f803f7d8-2e92-40ff-8ef5-406be24c8824'

describe('periodic queue job ids', () => {
  beforeEach(() => {
    added.length = 0
  })

  it('never contain ":" and stay distinct for force / non-force', async () => {
    const week = new Date(Date.UTC(2026, 10, 2))
    await enqueueRolloverMaster(2026, 10)
    await enqueueRolloverMaster(2026, 10, true)
    await enqueueRolloverBatch(2026, 10, [U1, U2])
    await enqueueAgencyRecomputeMaster('2026-11-09')
    await enqueueAgencyRecomputeMaster('2026-11-09', true)
    await enqueueAgencyRecomputeBatch('2026-11-09', [U1, U2])
    await enqueueEvalMaster(week)
    await enqueueEvalMaster(week, true)
    await enqueueEvalBatch(week, [U1, U2])

    const ids = added.map((a) => a.opts.jobId!)
    expect(ids).toHaveLength(9)
    for (const id of ids) {
      expect(id).not.toContain(':')
      expect(`${parseInt(id, 10)}`).not.toBe(id) // BullMQ also rejects integer ids
    }
    expect(new Set(ids).size).toBe(9)
    expect(ids).toContain('master-2026-10')
    expect(ids).toContain('master-2026-10-force')
    expect(ids).toContain(`batch-2026-10-${U1}-${U2}`)
  })
})

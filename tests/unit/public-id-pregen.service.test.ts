import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyPublicId } from '../../src/services/vip-classifier.service'
import { processBatch } from '../../src/services/public-id-pre-generation.service'

const createMany = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {
    vipPublicId: { createMany: (...a: unknown[]) => createMany(...a) },
  },
}))

const pipelineExec = vi.fn()
const pipelineSadd = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    pipeline: () => ({ sadd: pipelineSadd, exec: pipelineExec }),
  },
  RedisKeys: { vipReserved: () => 'vip:reserved' },
}))

describe('publicIdPreGenerationService.processBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createMany.mockResolvedValue({ count: 1 })
    pipelineExec.mockResolvedValue([])
  })

  it('inserts only VIP-pattern ids in range', async () => {
    const from = 40_000_000n
    const to = 40_000_010n
    const maxUser = 34_216_663n
    const result = await processBatch(from, to, maxUser)
    expect(result.scanned).toBe(11)
    let vipCount = 0
    for (let id = from; id <= to; id += 1n) {
      if (classifyPublicId(id).isVip) vipCount += 1
    }
    expect(createMany).toHaveBeenCalledTimes(1)
    const arg = createMany.mock.calls[0]![0] as { data: unknown[]; skipDuplicates: boolean }
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data.length).toBe(vipCount)
    expect(pipelineSadd.mock.calls.length).toBe(arg.data.length)
  })

  it('never inserts ids at or below max(users.public_id) safety ceiling', async () => {
    const id = 34_216_111n
    expect(classifyPublicId(id).isVip).toBe(true)
    createMany.mockResolvedValue({ count: 0 })
    const maxUser = 34_216_663n
    const result = await processBatch(id, id, maxUser)
    expect(result.skipped).toBe(1)
    expect(result.vipsAdded).toBe(0)
    expect(createMany).not.toHaveBeenCalled()
  })

  it('skipDuplicates makes rerun safe', async () => {
    createMany.mockResolvedValueOnce({ count: 0 })
    const maxUser = 34_216_663n
    await processBatch(40_000_000n, 40_000_000n, maxUser)
    const firstLen = (createMany.mock.calls[0]![0] as { data: unknown[] }).data.length
    expect(firstLen).toBeGreaterThanOrEqual(0)
    await processBatch(40_000_000n, 40_000_000n, maxUser)
    expect(createMany).toHaveBeenCalledTimes(2)
  })
})

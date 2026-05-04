import { describe, it, expect, vi, beforeEach } from 'vitest'
import { publicIdService } from '../../src/services/public-id.service'

const getNextAndIncrement = vi.fn()
vi.mock('../../src/repositories/public-id.repository', () => ({
  publicIdRepository: {
    getNextAndIncrement: (...a: unknown[]) => getNextAndIncrement(...a),
  },
}))

const sismember = vi.fn()
const sadd = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    sismember: (...a: unknown[]) => sismember(...a),
    sadd: (...a: unknown[]) => sadd(...a),
  },
  RedisKeys: { vipReserved: () => 'vip:reserved' },
}))

const findUnique = vi.fn()
const create = vi.fn()
vi.mock('../../src/config/database', () => ({
  prisma: {
    vipPublicId: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      create: (...a: unknown[]) => create(...a),
    },
  },
}))

vi.mock('../../src/services/user-public-id.service', () => ({
  userPublicIdService: {
    setOriginalPublicId: vi.fn().mockResolvedValue(undefined),
  },
}))

const logError = vi.fn()
vi.mock('../../src/utils/rootLogger', () => ({
  rootLogger: {
    child: () => ({ error: (...a: unknown[]) => logError(...a) }),
  },
}))

describe('publicIdService._nextNonReservedNonVip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sismember.mockResolvedValue(0)
    findUnique.mockResolvedValue(null)
    create.mockResolvedValue({})
    sadd.mockResolvedValue(1)
  })

  it('returns first non-reserved non-VIP id', async () => {
    getNextAndIncrement.mockResolvedValueOnce(100_103_455n)
    const out = await publicIdService._nextNonReservedNonVip()
    expect(out.publicId).toBe(100_103_455n)
    expect(out.classification.isVip).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  it('inline-enrolls VIP pattern when pre-gen missed and continues', async () => {
    getNextAndIncrement
      .mockResolvedValueOnce(40_000_000n)
      .mockResolvedValueOnce(100_103_456n)
    const out = await publicIdService._nextNonReservedNonVip()
    expect(out.publicId).toBe(100_103_456n)
    expect(create).toHaveBeenCalled()
    expect(sadd).toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
    const msg = String(logError.mock.calls[0]?.[1] ?? '')
    expect(msg).toContain('[public-id] pregen miss')
  })
})

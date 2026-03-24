import { describe, it, expect, vi, beforeEach } from 'vitest'

const cacheGet = vi.fn()
const cacheSet = vi.fn()
const cacheDelete = vi.fn()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: (...args: unknown[]) => cacheGet(...args),
    set: (...args: unknown[]) => cacheSet(...args),
    delete: (...args: unknown[]) => cacheDelete(...args),
  },
}))

const upsertLevel = vi.fn()
const findLevelsByUserIds = vi.fn()
const updateLevel = vi.fn()
const findLevelConfig = vi.fn()
vi.mock('../../src/repositories/userLevel.repository', () => ({
  userLevelRepository: {
    upsertLevel: (...args: unknown[]) => upsertLevel(...args),
    findLevelsByUserIds: (...args: unknown[]) => findLevelsByUserIds(...args),
    updateLevel: (...args: unknown[]) => updateLevel(...args),
    findLevelConfig: (...args: unknown[]) => findLevelConfig(...args),
    updateXp: vi.fn(),
  },
}))

const { userLevelService } = await import('../../src/services/userLevel.service')

describe('userLevelService', () => {
  const userId = 'user-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recalculateLevel updates level when XP in range', async () => {
    cacheGet.mockResolvedValueOnce(null)
    upsertLevel.mockResolvedValueOnce({
      id: 'lvl-1',
      userId,
      livestreamLevel: 1,
      wealthLevel: 0,
      livestreamXp: BigInt(150),
      wealthXp: BigInt(0),
      updatedAt: new Date(),
    })
    findLevelConfig.mockResolvedValueOnce([
      {
        id: 'cfg-1',
        levelType: 'livestream',
        level: 1,
        minXp: BigInt(0),
        maxXp: BigInt(100),
        label: 'Bronze',
        iconUrl: null,
      },
      {
        id: 'cfg-2',
        levelType: 'livestream',
        level: 2,
        minXp: BigInt(100),
        maxXp: BigInt(200),
        label: 'Silver',
        iconUrl: null,
      },
    ])

    await userLevelService.recalculateLevel(userId, 'livestream')

    expect(updateLevel).toHaveBeenCalledWith(userId, 'livestream', 2)
    expect(cacheDelete).toHaveBeenCalled()
  })
})


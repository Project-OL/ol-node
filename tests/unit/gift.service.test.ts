import { describe, it, expect, vi, beforeEach } from 'vitest'

const findById = vi.fn()
const updateWithTags = vi.fn()
const redisDel = vi.fn()
const redisScan = vi.fn()

vi.mock('../../src/repositories/gift.repository', () => ({
  giftRepository: {
    findById: (...a: unknown[]) => findById(...a),
    updateWithTags: (...a: unknown[]) => updateWithTags(...a),
  },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    del: (...a: unknown[]) => redisDel(...a),
    scan: (...a: unknown[]) => redisScan(...a),
  },
  RedisKeys: {
    giftList: (page: number, limit: number) => `gifts:list:v3:${page}:${limit}`,
    giftByTag: (tag: string, page: number, limit: number) => `gifts:tag:v3:${tag}:${page}:${limit}`,
  },
  GIFT_LIST_CACHE_TTL: 300,
}))

// Cached pages the SCAN "finds", by pattern.
const cachedKeys: Record<string, string[]> = {
  'gifts:list*': ['gifts:list:v3:1:20', 'gifts:list:v3:2:20', 'gifts:list:v2'],
  'gifts:tag:v3:classic:*': ['gifts:tag:v3:classic:1:20'],
}

const invalidateActiveMonthCaches = vi.fn()
vi.mock('../../src/services/gift-gallery.service', () => ({
  giftGalleryService: {
    invalidateActiveMonthCaches: (...a: unknown[]) => invalidateActiveMonthCaches(...a),
  },
}))

import { giftService } from '../../src/services/gift.service'

describe('giftService.patch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findById.mockResolvedValue({
      id: '511b15fd-bcf3-468c-b771-4525198b5ea1',
      tags: [{ tag: 'classic' }],
    })
    updateWithTags.mockResolvedValue({ id: '511b15fd-bcf3-468c-b771-4525198b5ea1' })
    redisDel.mockResolvedValue(1)
    redisScan.mockImplementation(async (_cursor: string, _m: string, pattern: string) => [
      '0',
      cachedKeys[pattern] ?? [],
    ])
    invalidateActiveMonthCaches.mockResolvedValue(undefined)
  })

  it('invalidates every cached list page, tag pages and active-month gallery caches when displayImageUrl changes', async () => {
    await giftService.patch('511b15fd-bcf3-468c-b771-4525198b5ea1', {
      displayImageUrl: 'https://images.unsplash.com/photo-1562690868-60bbe7293e94',
    })
    // List pages are cached per page/limit, so they are found by SCAN, not by a fixed key.
    expect(redisScan).toHaveBeenCalledWith('0', 'MATCH', 'gifts:list*', 'COUNT', 200)
    expect(redisDel).toHaveBeenCalledWith('gifts:list:v3:1:20', 'gifts:list:v3:2:20', 'gifts:list:v2')
    expect(redisScan).toHaveBeenCalledWith('0', 'MATCH', 'gifts:tag:v3:classic:*', 'COUNT', 200)
    expect(redisDel).toHaveBeenCalledWith('gifts:tag:v3:classic:1:20')
    // Legacy tag keys are still dropped by name.
    expect(redisDel).toHaveBeenCalledWith(
      'gifts:tag:v2:classic',
      'gifts:tag:classic:vip',
      'gifts:tag:classic:novip',
      'gifts:tag:classic',
    )
    expect(invalidateActiveMonthCaches).toHaveBeenCalled()
  })
})

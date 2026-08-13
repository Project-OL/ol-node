import { describe, it, expect, vi, beforeEach } from 'vitest'

const findById = vi.fn()
const updateWithTags = vi.fn()
const redisDel = vi.fn()

vi.mock('../../src/repositories/gift.repository', () => ({
  giftRepository: {
    findById: (...a: unknown[]) => findById(...a),
    updateWithTags: (...a: unknown[]) => updateWithTags(...a),
  },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    del: (...a: unknown[]) => redisDel(...a),
  },
  RedisKeys: {
    giftList: () => 'gifts:list',
    giftByTag: (tag: string) => `gifts:tag:${tag}`,
  },
  GIFT_LIST_CACHE_TTL: 300,
}))

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
    invalidateActiveMonthCaches.mockResolvedValue(undefined)
  })

  it('invalidates gift list and active-month gallery caches when displayImageUrl changes', async () => {
    await giftService.patch('511b15fd-bcf3-468c-b771-4525198b5ea1', {
      displayImageUrl: 'https://images.unsplash.com/photo-1562690868-60bbe7293e94',
    })
    // invalidateGiftCaches also busts legacy :vip/:novip suffixed keys (see the
    // RedisKeys comment in config/redis.ts) alongside the plain key.
    expect(redisDel).toHaveBeenCalledWith('gifts:list', 'gifts:list:vip', 'gifts:list:novip', 'gifts:list')
    expect(redisDel).toHaveBeenCalledWith(
      'gifts:tag:classic',
      'gifts:tag:classic:vip',
      'gifts:tag:classic:novip',
      'gifts:tag:classic',
    )
    expect(invalidateActiveMonthCaches).toHaveBeenCalled()
  })
})

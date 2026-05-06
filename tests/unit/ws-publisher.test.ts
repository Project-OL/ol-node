import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisPublish = vi.fn()

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    publish: (...a: unknown[]) => redisPublish(...a),
  },
  RedisKeys: {
    convChannel: (id: string) => `msg:conv:${id}`,
  },
}))

import { publishToConversation } from '../../src/utils/ws-publisher'

describe('publishToConversation', () => {
  beforeEach(() => {
    redisPublish.mockReset()
    redisPublish.mockResolvedValue(1)
  })

  it('publishes ServerFrame JSON on msg:conv:{id} with t=NEW_MESSAGE', async () => {
    await publishToConversation('clxyz123abc4567890123456789', {
      type: 'NEW_MESSAGE',
      conversationId: 'clxyz123abc4567890123456789',
      message: { id: 'm1', createdAt: new Date('2020-01-01T00:00:00.000Z') },
    })
    expect(redisPublish).toHaveBeenCalledTimes(1)
    const [channel, payload] = redisPublish.mock.calls[0] as [string, string]
    expect(channel).toBe('msg:conv:clxyz123abc4567890123456789')
    const parsed = JSON.parse(payload) as { t: string; seq: number }
    expect(parsed.t).toBe('NEW_MESSAGE')
    expect(parsed.seq).toBe(0)
  })
})

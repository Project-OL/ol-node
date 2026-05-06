import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisSet = vi.fn()
const redisGetdel = vi.fn()

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    set: (...a: unknown[]) => redisSet(...a),
    getdel: (...a: unknown[]) => redisGetdel(...a),
  },
  RedisKeys: {
    wsTicket: (t: string) => `ws:ticket:${t}`,
  },
  WS_TICKET_TTL_SEC: 900,
}))

import { mintWsTicket, consumeWsTicket } from '../../src/services/ws-ticket.service'

describe('ws-ticket.service', () => {
  beforeEach(() => {
    redisSet.mockReset()
    redisGetdel.mockReset()
  })

  it('mintWsTicket stores user id with EX TTL', async () => {
    redisSet.mockResolvedValue('OK')
    const out = await mintWsTicket('user-uuid')
    expect(out.expiresInSec).toBe(900)
    expect(out.token.length).toBeGreaterThan(16)
    expect(redisSet).toHaveBeenCalledWith(
      `ws:ticket:${out.token}`,
      'user-uuid',
      'EX',
      900,
    )
  })

  it('consumeWsTicket returns null for missing or short token', async () => {
    expect(await consumeWsTicket(undefined)).toBe(null)
    expect(await consumeWsTicket('short')).toBe(null)
    expect(redisGetdel).not.toHaveBeenCalled()
  })

  it('consumeWsTicket returns user id from GETDEL', async () => {
    redisGetdel.mockResolvedValueOnce('u1')
    const u = await consumeWsTicket('a'.repeat(32))
    expect(u).toBe('u1')
    expect(redisGetdel).toHaveBeenCalledTimes(1)
  })
})

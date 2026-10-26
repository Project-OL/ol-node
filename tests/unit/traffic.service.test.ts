import { describe, it, expect, vi, beforeEach } from 'vitest'

const pipe = {
  hincrby: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  pfadd: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
}

vi.mock('../../src/config/redis', () => ({
  redisClient: {
    zadd: vi.fn().mockResolvedValue(1),
    zcount: vi.fn().mockResolvedValue(0),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    hgetall: vi.fn().mockResolvedValue({}),
    pipeline: vi.fn(() => pipe),
  },
  RedisKeys: {
    presenceLastPing: () => 'presence:lastping',
    trafficHourUsers: (h: string) => `traffic:u:${h}`,
    trafficHourSectionUsers: (h: string, s: string) => `traffic:su:${h}:${s}`,
    trafficHourRequests: (h: string) => `traffic:req:${h}`,
    trafficHourErrors: (h: string) => `traffic:err:${h}`,
    trafficLiveNow: () => 'traffic:live:now',
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: { trafficMinute: { upsert: vi.fn().mockResolvedValue({}) } },
}))

import { istHourKey, sectionForPath, trafficService, ONLINE_WINDOW_MS } from '../../src/services/traffic.service'
import { redisClient } from '../../src/config/redis'
import { prisma } from '../../src/config/database'

describe('istHourKey', () => {
  it('buckets by IST hour, crossing the UTC date line', () => {
    expect(istHourKey(Date.parse('2026-10-25T18:29:59Z'))).toBe('2026102523')
    expect(istHourKey(Date.parse('2026-10-25T18:30:00Z'))).toBe('2026102600')
    expect(istHourKey(new Date('2026-10-26T06:45:00Z'))).toBe('2026102612')
  })
})

describe('sectionForPath', () => {
  it('maps app routes to sections', () => {
    expect(sectionForPath('/api/v1/wallet/coins/balance')).toBe('Wallet')
    expect(sectionForPath('/api/v1/conversations/abc/messages?limit=20')).toBe('Chat')
    expect(sectionForPath('/api/v1/users/me')).toBe('Profile')
    expect(sectionForPath('/agency/hosts')).toBe('Agency')
    expect(sectionForPath('/api/v1/something-new/x')).toBe('Other')
  })

  it('leaves machine, admin and health traffic out', () => {
    expect(sectionForPath('/api/v1/admin/users')).toBeNull()
    expect(sectionForPath('/api/v1/game-webhooks/baishun/get_user_info')).toBeNull()
    expect(sectionForPath('/api/v1/webhooks/epay')).toBeNull()
    expect(sectionForPath('/health')).toBeNull()
    expect(sectionForPath('/')).toBeNull()
  })
})

describe('trafficService.recordRequest', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts the request and the user in one pipeline, with expiries', async () => {
    const at = Date.parse('2026-10-26T06:45:00Z')
    await trafficService.recordRequest('Wallet', 'u1', 200, at)
    expect(pipe.hincrby).toHaveBeenCalledWith('traffic:req:2026102612', 'Wallet', 1)
    expect(pipe.pfadd).toHaveBeenCalledWith('traffic:u:2026102612', 'u1')
    expect(pipe.pfadd).toHaveBeenCalledWith('traffic:su:2026102612:Wallet', 'u1')
    expect(pipe.expire).toHaveBeenCalledTimes(3)
    expect(pipe.exec).toHaveBeenCalledOnce()
  })

  it('counts 5xx separately and skips user sets for anonymous requests', async () => {
    await trafficService.recordRequest('Sign-in', undefined, 503, Date.parse('2026-10-26T06:45:00Z'))
    expect(pipe.hincrby).toHaveBeenCalledWith('traffic:err:2026102612', 'Sign-in', 1)
    expect(pipe.pfadd).not.toHaveBeenCalled()
  })
})

describe('trafficService.sampleMinute', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes online users and fresh Live-server counts for the minute', async () => {
    const now = Date.parse('2026-10-26T09:00:30Z')
    vi.mocked(redisClient.zcount).mockResolvedValueOnce(7)
    vi.mocked(redisClient.hgetall).mockResolvedValueOnce({
      at: String(now - 20_000),
      hostsLive: '2',
      viewers: '9',
      callsActive: '1',
      usersInCalls: '2',
      socketUsers: '11',
    })
    const res = await trafficService.sampleMinute(now)
    expect(redisClient.zcount).toHaveBeenCalledWith('presence:lastping', now - ONLINE_WINDOW_MS, '+inf')
    expect(res.minute.toISOString()).toBe('2026-10-26T09:00:00.000Z')
    expect(prisma.trafficMinute.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ onlineUsers: 7, hostsLive: 2, liveViewers: 9, callsActive: 1, usersInCalls: 2, liveSocketUsers: 11 }),
      }),
    )
  })

  it('stores null live counts when the Live-server snapshot is stale', async () => {
    const now = Date.parse('2026-10-26T09:00:30Z')
    vi.mocked(redisClient.hgetall).mockResolvedValueOnce({ at: String(now - 10 * 60_000), hostsLive: '2' })
    await trafficService.sampleMinute(now)
    expect(prisma.trafficMinute.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ hostsLive: null, liveViewers: null }) }),
    )
  })
})

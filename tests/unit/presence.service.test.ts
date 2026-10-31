import { describe, it, expect, vi, beforeEach } from 'vitest'



const incr = vi.fn()

const set = vi.fn()

const get = vi.fn()

const del = vi.fn()

const evalMock = vi.fn()

const publish = vi.fn()

const touchUserLastActive = vi.fn()

const mget = vi.fn()

const getEffectiveFlagsBulk = vi.fn()

const findMany = vi.fn()

vi.mock('../../src/middlewares/lastActiveTracker.middleware', () => ({
  touchUserLastActive: (...args: unknown[]) => touchUserLastActive(...args),
}))

vi.mock('../../src/services/privacy.service', () => ({
  privacyService: { getEffectiveFlagsBulk: (...a: unknown[]) => getEffectiveFlagsBulk(...a) },
}))

vi.mock('../../src/config/database', () => ({
  prismaRead: { user: { findMany: (...a: unknown[]) => findMany(...a) } },
}))

vi.mock('../../src/config/redis', () => ({

  redisClient: {

    incr,

    set,

    get,

    del,

    eval: evalMock,

    publish,

    mget,

  },

  PRESENCE_HEARTBEAT_TTL_SEC: 60,

  PRESENCE_LAST_ACTIVE_THROTTLE_TTL_SEC: 60,

  RedisKeys: {

    presenceCount: (u: string) => `presence:count:${u}`,

    userOnlineStatus: (u: string) => `online:${u}`,

    presenceChannel: (u: string) => `presence:user:${u}`,

    userActiveStream: (u: string) => `user:active_stream:${u}`,

  },

}))



describe('presenceService', () => {

  beforeEach(() => {

    incr.mockReset()

    set.mockReset()

    get.mockReset()

    del.mockReset()

    evalMock.mockReset()

    publish.mockReset()
    touchUserLastActive.mockReset()
    touchUserLastActive.mockResolvedValue(undefined)
  })



  it(
    'recordSocketConnected publishes when count becomes 1',
    async () => {
      // eval atomically INCRs presence:count and peeks the previous online flag,
      // returning [count, wasOnlineFlag]; the SET of online:{userId} happens
      // inside the Lua script itself, not via a separate redisClient.set call.
      evalMock.mockResolvedValueOnce([1, 0])

      publish.mockResolvedValueOnce(1)

      const { presenceService } = await import('../../src/services/presence.service')

      await presenceService.recordSocketConnected('u1')

      expect(touchUserLastActive).toHaveBeenCalledWith('u1', {
        throttleSec: 60,
        presenceGate: true,
      })
      expect(publish).toHaveBeenCalled()

      const payload = publish.mock.calls[0]?.[1] as string

      expect(JSON.parse(payload)).toMatchObject({ t: 'PRESENCE', userId: 'u1', online: true })
    },
    15_000,
  )



  it(
    'recordSocketConnected skips publish when count > 1',
    async () => {
      // count=2 (not the first socket) and wasOnline=1 (already online) → no publish.
      evalMock.mockResolvedValueOnce([2, 1])

      const { presenceService } = await import('../../src/services/presence.service')

      await presenceService.recordSocketConnected('u1')

      expect(set).not.toHaveBeenCalled()

      expect(publish).not.toHaveBeenCalled()
    },
    15_000,
  )



  it('recordSocketDisconnected publishes offline when count hits 0', async () => {

    evalMock.mockResolvedValueOnce(0)

    del.mockResolvedValueOnce(1)

    publish.mockResolvedValueOnce(1)

    const { presenceService } = await import('../../src/services/presence.service')

    await presenceService.recordSocketDisconnected('u1')

    expect(del).toHaveBeenCalledWith('online:u1')

    const payload = publish.mock.calls[0]?.[1] as string

    expect(JSON.parse(payload)).toMatchObject({ t: 'PRESENCE', userId: 'u1', online: false })

  })



  it('refreshOnlineHeartbeat sets online key', async () => {

    set.mockResolvedValueOnce('OK')

    const { presenceService } = await import('../../src/services/presence.service')

    await presenceService.refreshOnlineHeartbeat('u1')

    expect(set).toHaveBeenCalledWith('online:u1', '1', 'EX', 60)
    expect(touchUserLastActive).toHaveBeenCalledWith('u1', {
      throttleSec: 60,
      presenceGate: true,
    })
  })

  describe('LIVE-60 isLive', () => {
    beforeEach(() => {
      mget.mockReset()
      findMany.mockReset()
      getEffectiveFlagsBulk.mockReset()
      getEffectiveFlagsBulk.mockResolvedValue(new Map())
      findMany.mockResolvedValue([])
    })

    it('reads online and active-stream keys in one MGET', async () => {
      // online: a=yes, b=no, c=yes; active_stream: a=s-a, b=s-b, c=none
      mget.mockResolvedValueOnce(['1', null, '1', 's-a', 's-b', null])
      const { presenceService } = await import('../../src/services/presence.service')

      const map = await presenceService.getPublicPresenceForUsers('viewer', ['a', 'b', 'c'])

      expect(mget).toHaveBeenCalledTimes(1)
      expect(mget).toHaveBeenCalledWith(
        'online:a',
        'online:b',
        'online:c',
        'user:active_stream:a',
        'user:active_stream:b',
        'user:active_stream:c',
      )
      expect(map.get('a')).toMatchObject({ isOnline: true, isLive: true, liveStreamId: 's-a' })
      expect(map.get('b')).toMatchObject({ isOnline: false, isLive: true, liveStreamId: 's-b' })
      expect(map.get('c')).toMatchObject({ isOnline: true, isLive: false, liveStreamId: null })
    })

    it('keeps isLive for an invisible-online VIP host while hiding isOnline', async () => {
      getEffectiveFlagsBulk.mockResolvedValueOnce(
        new Map([['vip', { invisibleOnline: true, invisibleOnlineLastSeenAt: null }]]),
      )
      mget.mockResolvedValueOnce(['1', 's-vip'])
      const { presenceService } = await import('../../src/services/presence.service')

      const p = (await presenceService.getPublicPresenceForUsers('viewer', ['vip'])).get('vip')

      expect(p).toMatchObject({ isOnline: false, isLive: true, liveStreamId: 's-vip' })
    })

    it('PRESENCE_INCLUDE_LIVE=false skips the active-stream keys', async () => {
      const { env } = await import('../../src/config/env')
      const prev = env.PRESENCE_INCLUDE_LIVE
      ;(env as { PRESENCE_INCLUDE_LIVE: boolean }).PRESENCE_INCLUDE_LIVE = false
      try {
        mget.mockResolvedValueOnce(['1'])
        const { presenceService } = await import('../../src/services/presence.service')

        const p = (await presenceService.getPublicPresenceForUsers('viewer', ['a'])).get('a')

        expect(mget).toHaveBeenCalledWith('online:a')
        expect(p).toMatchObject({ isOnline: true, isLive: false, liveStreamId: null })
      } finally {
        ;(env as { PRESENCE_INCLUDE_LIVE: boolean }).PRESENCE_INCLUDE_LIVE = prev
      }
    })

    it('publishLiveStatus sends a LIVE_STATUS frame on the presence channel', async () => {
      publish.mockResolvedValueOnce(1)
      const { presenceService } = await import('../../src/services/presence.service')

      await presenceService.publishLiveStatus('h1', false, 's1')

      expect(publish.mock.calls[0]?.[0]).toBe('presence:user:h1')
      expect(JSON.parse(publish.mock.calls[0]?.[1] as string)).toEqual({
        t: 'LIVE_STATUS',
        userId: 'h1',
        isLive: false,
        liveStreamId: null,
      })
    })
  })

})


import { describe, it, expect, vi, beforeEach } from 'vitest'



const incr = vi.fn()

const set = vi.fn()

const del = vi.fn()

const evalMock = vi.fn()

const publish = vi.fn()

const touchUserLastActive = vi.fn()

vi.mock('../../src/middlewares/lastActiveTracker.middleware', () => ({
  touchUserLastActive: (...args: unknown[]) => touchUserLastActive(...args),
}))

vi.mock('../../src/config/redis', () => ({

  redisClient: {

    incr,

    set,

    del,

    eval: evalMock,

    publish,

  },

  PRESENCE_HEARTBEAT_TTL_SEC: 60,

  RedisKeys: {

    presenceCount: (u: string) => `presence:count:${u}`,

    userOnlineStatus: (u: string) => `online:${u}`,

    presenceChannel: (u: string) => `presence:user:${u}`,

  },

}))



describe('presenceService', () => {

  beforeEach(() => {

    incr.mockReset()

    set.mockReset()

    del.mockReset()

    evalMock.mockReset()

    publish.mockReset()
    touchUserLastActive.mockReset()
    touchUserLastActive.mockResolvedValue(undefined)
  })



  it('recordSocketConnected publishes when count becomes 1', async () => {

    incr.mockResolvedValueOnce(1)

    set.mockResolvedValueOnce('OK')

    publish.mockResolvedValueOnce(1)

    const { presenceService } = await import('../../src/services/presence.service')

    await presenceService.recordSocketConnected('u1')

    expect(set).toHaveBeenCalledWith('online:u1', '1', 'EX', 60)
    expect(touchUserLastActive).toHaveBeenCalledWith('u1')
    expect(publish).toHaveBeenCalled()

    const payload = publish.mock.calls[0]?.[1] as string

    expect(JSON.parse(payload)).toMatchObject({ t: 'PRESENCE', userId: 'u1', online: true })

  })



  it('recordSocketConnected skips publish when count > 1', async () => {

    incr.mockResolvedValueOnce(2)

    const { presenceService } = await import('../../src/services/presence.service')

    await presenceService.recordSocketConnected('u1')

    expect(set).not.toHaveBeenCalled()

    expect(publish).not.toHaveBeenCalled()

  })



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
    expect(touchUserLastActive).toHaveBeenCalledWith('u1')
  })

})


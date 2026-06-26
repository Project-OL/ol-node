import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { signRefresh, verifyRefresh } from '../../src/utils/jwt'

const loginCreateOrReuseSession = vi.fn()
const findById = vi.fn()
const findByRefreshTokenHash = vi.fn()
const revokeById = vi.fn()
const findActiveByUserId = vi.fn()
const revokeAllByUserId = vi.fn()
const updateRefreshTokenAndBumpVersion = vi.fn()

const findActiveByUserIdAndDeviceId = vi.fn()
const deleteLinkedAccountIfExists = vi.fn()
vi.mock('../../src/repositories/device.repository', () => ({
  deviceRepository: {
    deleteLinkedAccountIfExists: (...a: unknown[]) => deleteLinkedAccountIfExists(...a),
  },
}))

vi.mock('../../src/repositories/session.repository', () => ({
  sessionRepository: {
    loginCreateOrReuseSession: (...a: unknown[]) => loginCreateOrReuseSession(...a),
    findByRefreshTokenHash: (...a: unknown[]) => findByRefreshTokenHash(...a),
    findById: (...a: unknown[]) => findById(...a),
    revokeById: (...a: unknown[]) => revokeById(...a),
    findActiveByUserId: (...a: unknown[]) => findActiveByUserId(...a),
    findActiveByUserIdAndDeviceId: (...a: unknown[]) => findActiveByUserIdAndDeviceId(...a),
    revokeAllByUserId: (...a: unknown[]) => revokeAllByUserId(...a),
    updateRefreshTokenAndBumpVersion: (...a: unknown[]) => updateRefreshTokenAndBumpVersion(...a),
  },
  MAX_SESSIONS_PER_USER: 3,
}))

const upsertDevice = vi.fn()
const findByUserAndDevice = vi.fn().mockResolvedValue(null)
vi.mock('../../src/repositories/device-registry.repository', () => ({
  deviceRegistryRepository: {
    upsert: (...a: unknown[]) => upsertDevice(...a),
    findByUserAndDevice: (...a: unknown[]) => findByUserAndDevice(...a),
  },
}))

const getTokenVersion = vi.fn().mockResolvedValue(0)
const incrementTokenVersion = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    getTokenVersion: (...a: unknown[]) => getTokenVersion(...a),
    incrementTokenVersion: (...a: unknown[]) => incrementTokenVersion(...a),
  },
}))

const redisDel = vi.fn().mockResolvedValue(1)
const redisSet = vi.fn().mockResolvedValue('OK')
const redisGet = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: {
    del: (...a: unknown[]) => redisDel(...a),
    set: (...a: unknown[]) => redisSet(...a),
    get: (...a: unknown[]) => redisGet(...a),
    pipeline: () => {
      const p = {
        del: (...a: unknown[]) => {
          void redisDel(...a)
          return p
        },
        exec: vi.fn().mockResolvedValue([]),
      }
      return p
    },
  },
  RedisKeys: {
    session: (id: string) => `session:${id}`,
    refreshLock: (id: string) => `refresh:${id}`,
    userTokenVersion: (id: string) => `utv:${id}`,
    deviceLinkedAccounts: (deviceId: string) => `device:${deviceId}:linked`,
  },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn().mockResolvedValue(undefined) },
}))

const { sessionService } = await import('../../src/services/session.service')

describe('sessionService one active session per (userId, deviceId)', () => {
  const baseParams = {
    userId: '00000000-0000-4000-8000-000000000001',
    publicId: 1,
    passwordSet: true,
    deviceName: 'Phone',
    deviceId: 'device-a',
    ipAddress: '127.0.0.1',
    userAgent: 'ua',
    loginType: 'password',
    displayName: 'Test User',
    avatarUrl: null as string | null,
  }

  beforeEach(() => {
    loginCreateOrReuseSession.mockReset()
    redisDel.mockClear()
    redisSet.mockClear()
    redisGet.mockResolvedValue(null)
    getTokenVersion.mockClear()
    findById.mockReset()
    findByRefreshTokenHash.mockReset()
    revokeById.mockReset()
    findActiveByUserId.mockReset()
    findActiveByUserIdAndDeviceId.mockReset()
    deleteLinkedAccountIfExists.mockReset()
    deleteLinkedAccountIfExists.mockResolvedValue(true)
    revokeAllByUserId.mockReset()
    updateRefreshTokenAndBumpVersion.mockReset()
    upsertDevice.mockClear()
  })

  it('retries login on Prisma unique violation (P2002)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    })
    loginCreateOrReuseSession
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({
        session: {
          id: '99999999-9999-4999-8999-999999999999',
          tokenVersion: 0,
          deviceId: 'device-a',
          userId: baseParams.userId,
        },
        refreshToken: 'rt-retry',
        revokedSessionIds: [],
        reused: false,
      })

    const out = await sessionService.createSession(baseParams)
    expect(out.sessionId).toBe('99999999-9999-4999-8999-999999999999')
    expect(loginCreateOrReuseSession).toHaveBeenCalledTimes(2)
  })

  it('login twice same device returns SAME sessionId', async () => {
    const sid = '11111111-1111-4111-8111-111111111111'
    loginCreateOrReuseSession
      .mockResolvedValueOnce({
        session: {
          id: sid,
          tokenVersion: 0,
          deviceId: 'device-a',
          userId: baseParams.userId,
        },
        refreshToken: 'rt1',
        revokedSessionIds: [],
        reused: false,
      })
      .mockResolvedValueOnce({
        session: {
          id: sid,
          tokenVersion: 1,
          deviceId: 'device-a',
          userId: baseParams.userId,
        },
        refreshToken: 'rt2',
        revokedSessionIds: [],
        reused: true,
      })

    const first = await sessionService.createSession(baseParams)
    const second = await sessionService.createSession(baseParams)

    expect(first.sessionId).toBe(sid)
    expect(second.sessionId).toBe(sid)
    expect(loginCreateOrReuseSession).toHaveBeenCalledTimes(2)
  })

  it('login different device yields NEW sessionId', async () => {
    loginCreateOrReuseSession
      .mockResolvedValueOnce({
        session: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tokenVersion: 0,
          deviceId: 'device-a',
          userId: baseParams.userId,
        },
        refreshToken: 'rta',
        revokedSessionIds: [],
        reused: false,
      })
      .mockResolvedValueOnce({
        session: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tokenVersion: 0,
          deviceId: 'device-b',
          userId: baseParams.userId,
        },
        refreshToken: 'rtb',
        revokedSessionIds: [],
        reused: false,
      })

    const a = await sessionService.createSession(baseParams)
    const b = await sessionService.createSession({ ...baseParams, deviceId: 'device-b' })

    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('login same device different user yields NEW session (repository scoped by userId)', async () => {
    const user2 = '00000000-0000-4000-8000-000000000002'
    loginCreateOrReuseSession
      .mockResolvedValueOnce({
        session: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          tokenVersion: 0,
          deviceId: 'shared-dev',
          userId: baseParams.userId,
        },
        refreshToken: 'r1',
        revokedSessionIds: [],
        reused: false,
      })
      .mockResolvedValueOnce({
        session: {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          tokenVersion: 0,
          deviceId: 'shared-dev',
          userId: user2,
        },
        refreshToken: 'r2',
        revokedSessionIds: [],
        reused: false,
      })

    const u1 = await sessionService.createSession({ ...baseParams, deviceId: 'shared-dev' })
    const u2 = await sessionService.createSession({
      ...baseParams,
      userId: user2,
      deviceId: 'shared-dev',
    })

    expect(u1.sessionId).not.toBe(u2.sessionId)
  })

  it('logout revokes session and deletes Redis', async () => {
    const sid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    findById.mockResolvedValue({
      id: sid,
      userId: baseParams.userId,
      deviceId: baseParams.deviceId,
    })
    findActiveByUserIdAndDeviceId.mockResolvedValue(null)

    await sessionService.revokeSession(sid, baseParams.userId)

    expect(revokeById).toHaveBeenCalledWith(sid)
    expect(redisDel).toHaveBeenCalledWith(`session:${sid}`)
    expect(redisDel).toHaveBeenCalledWith(`device:${baseParams.deviceId}:linked`)
    expect(deleteLinkedAccountIfExists).toHaveBeenCalledWith(
      baseParams.deviceId,
      baseParams.userId,
    )
  })

  it('logout keeps device link when another active session remains on device', async () => {
    const sid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    findById.mockResolvedValue({
      id: sid,
      userId: baseParams.userId,
      deviceId: baseParams.deviceId,
    })
    findActiveByUserIdAndDeviceId.mockResolvedValue({ id: 'other-session' })

    await sessionService.revokeSession(sid, baseParams.userId)

    expect(deleteLinkedAccountIfExists).not.toHaveBeenCalled()
  })

  it('revokeAllSessions clears Redis for each active session', async () => {
    const ids = ['s1', 's2']
    findActiveByUserId.mockResolvedValue(
      ids.map((id, i) => ({ id, deviceId: i === 0 ? 'dev-a' : 'dev-b' })),
    )
    revokeAllByUserId.mockResolvedValue({ count: 2 })

    await sessionService.revokeAllSessions(baseParams.userId)

    expect(redisDel).toHaveBeenCalledWith('session:s1')
    expect(redisDel).toHaveBeenCalledWith('session:s2')
    expect(deleteLinkedAccountIfExists).toHaveBeenCalledWith('dev-a', baseParams.userId)
    expect(deleteLinkedAccountIfExists).toHaveBeenCalledWith('dev-b', baseParams.userId)
    expect(incrementTokenVersion).toHaveBeenCalledWith(baseParams.userId)
  })

  it('refresh increments sessionTokenVersion (repository contract)', async () => {
    const sid = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const oldRt = signRefresh({
      userId: baseParams.userId,
      sessionId: sid,
      jti: sid,
    })
    const oldHash = crypto.createHash('sha256').update(oldRt).digest('hex')

    findByRefreshTokenHash.mockResolvedValue({
      id: sid,
      userId: baseParams.userId,
      deviceId: 'd',
      refreshTokenHash: oldHash,
      tokenVersion: 0,
      user: {
        id: baseParams.userId,
        publicId: BigInt(1),
        passwordSet: true,
        firstName: 'T',
        lastName: 'U',
        username: 'tu',
        avatarUrl: null,
      },
    })
    updateRefreshTokenAndBumpVersion.mockResolvedValue({ sessionTokenVersion: 1 })

    const out = await sessionService.rotateRefresh(oldRt, '127.0.0.1')

    expect(out.sessionId).toBe(sid)
    expect(updateRefreshTokenAndBumpVersion).toHaveBeenCalled()
    const payload = verifyRefresh(out.refreshToken)
    expect(payload.sessionId).toBe(sid)
    expect(redisSet).toHaveBeenCalled()
    const redisPayload = JSON.parse(redisSet.mock.calls.at(-1)![1] as string)
    expect(redisPayload.sessionTokenVersion).toBe(1)
  })
})

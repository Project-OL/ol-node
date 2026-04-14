import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const isActive = vi.fn()
const grant = vi.fn()
const revoke = vi.fn()
vi.mock('../../src/repositories/super-host.repository', () => ({
  superHostRepository: {
    isActive: (...args: unknown[]) => isActive(...args),
    grant: (...args: unknown[]) => grant(...args),
    revoke: (...args: unknown[]) => revoke(...args),
  },
}))

const findById = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: (...args: unknown[]) => findById(...args),
  },
}))

vi.mock('../../src/config/env', () => ({
  env: {
    ADMIN_USER_IDS: ['admin-1'],
  },
}))

vi.mock('../../src/config/redis', () => ({
  RedisKeys: {
    superHostStatus: (targetUserId: string) => `superhost:status:${targetUserId}`,
  },
  SUPER_HOST_STATUS_TTL: 300,
}))

const { superHostService } = await import('../../src/services/super-host.service')

describe('superHostService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findById.mockResolvedValue({ id: 'target-1' })
  })

  it('isSuperHost returns true on cache hit', async () => {
    cacheGet.mockResolvedValueOnce('1')
    const result = await superHostService.isSuperHost('target-1')
    expect(result).toBe(true)
    expect(isActive).not.toHaveBeenCalled()
  })

  it('isSuperHost returns false on cache hit', async () => {
    cacheGet.mockResolvedValueOnce('0')
    const result = await superHostService.isSuperHost('target-1')
    expect(result).toBe(false)
    expect(isActive).not.toHaveBeenCalled()
  })

  it('isSuperHost falls back to DB true and warms cache', async () => {
    cacheGet.mockResolvedValueOnce(null)
    isActive.mockResolvedValueOnce(true)

    const result = await superHostService.isSuperHost('target-1')
    expect(result).toBe(true)
    expect(cacheSet).toHaveBeenCalledWith('superhost:status:target-1', '1', 300)
  })

  it('isSuperHost falls back to DB false and warms cache', async () => {
    cacheGet.mockResolvedValueOnce(null)
    isActive.mockResolvedValueOnce(false)

    const result = await superHostService.isSuperHost('target-1')
    expect(result).toBe(false)
    expect(cacheSet).toHaveBeenCalledWith('superhost:status:target-1', '0', 300)
  })

  it('grantSuperHost throws 403 for non-admin', async () => {
    await expect(superHostService.grantSuperHost('user-1', 'target-1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    })
  })

  it('grantSuperHost writes DB and invalidates cache', async () => {
    isActive.mockResolvedValueOnce(false)
    grant.mockResolvedValueOnce(undefined)

    await superHostService.grantSuperHost('admin-1', 'target-1')

    expect(grant).toHaveBeenCalledWith('target-1', 'admin-1')
    expect(cacheDelete).toHaveBeenCalledWith('superhost:status:target-1')
  })

  it('revokeSuperHost throws 403 for non-admin', async () => {
    await expect(superHostService.revokeSuperHost('user-1', 'target-1')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    })
  })

  it('revokeSuperHost writes DB and invalidates cache', async () => {
    isActive.mockResolvedValueOnce(true)
    revoke.mockResolvedValueOnce(undefined)

    await superHostService.revokeSuperHost('admin-1', 'target-1')

    expect(revoke).toHaveBeenCalledWith('target-1', 'admin-1')
    expect(cacheDelete).toHaveBeenCalledWith('superhost:status:target-1')
  })
})

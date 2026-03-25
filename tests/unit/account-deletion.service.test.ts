import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const findByUserId = vi.fn()
const create = vi.fn()
const update = vi.fn()
const findForDeletion = vi.fn()
vi.mock('../../src/repositories/account-deletion.repository', () => ({
  accountDeletionRepository: {
    findByUserId: (...args: unknown[]) => findByUserId(...args),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
    findForDeletion: (...args: unknown[]) => findForDeletion(...args),
  },
}))

const userUpdate = vi.fn()
const deleteAccountPermanently = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    update: (...args: unknown[]) => userUpdate(...args),
    deleteAccountPermanently: (...args: unknown[]) => deleteAccountPermanently(...args),
  },
}))

const revokeAllSessions = vi.fn()
vi.mock('../../src/services/session.service', () => ({
  sessionService: {
    revokeAllSessions: (...args: unknown[]) => revokeAllSessions(...args),
  },
}))

const verifyCurrentPassword = vi.fn()
vi.mock('../../src/services/security-password.service', () => ({
  securityPasswordService: {
    verifyCurrentPassword: (...args: unknown[]) => verifyCurrentPassword(...args),
  },
}))

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

vi.mock('../../src/config/redis', () => ({
  RedisKeys: {
    userDeletionStatus: (userId: string) => `user:${userId}:deletion-status`,
    userAuthIdentifiers: (userId: string) => `user:${userId}:auth_identifiers`,
    userDevices: (userId: string) => `user:${userId}:devices`,
    userSessions: (userId: string) => `user:${userId}:sessions`,
    userMe: (userId: string) => `user:me:${userId}`,
    userProfile: (userId: string) => `user:profile:${userId}`,
    userUsernameLock: (userId: string) => `user:username_lock:${userId}`,
  },
}))

vi.mock('../../src/services/cacheRedis.service', () => ({
  cacheRedisService: {
    del: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ttl: vi.fn().mockResolvedValue(-2),
  },
}))

const auditLog = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: (...args: unknown[]) => auditLog(...args) },
}))

const { accountDeletionService } = await import('../../src/services/account-deletion.service')

const userId = 'user-123'

beforeEach(() => {
  vi.clearAllMocks()
  verifyCurrentPassword.mockResolvedValue(undefined)
  auditLog.mockResolvedValue(undefined)
})

describe('accountDeletionService.scheduleDeletion', () => {
  it('schedules deletion and revokes all sessions', async () => {
    findByUserId.mockResolvedValue(null)
    const now = new Date()
    const deactivationUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    const deletionAt = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000)
    create.mockResolvedValue({
      userId,
      scheduledAt: now,
      deactivationUntil,
      deletionAt,
    })

    const result = await accountDeletionService.scheduleDeletion(userId, 'MyP@ssw0rd!', 'Privacy')

    expect(verifyCurrentPassword).toHaveBeenCalledWith(userId, 'MyP@ssw0rd!')
    expect(findByUserId).toHaveBeenCalledWith(userId)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        reason: 'Privacy',
        ipAddress: undefined,
      }),
    )
    expect(userUpdate).toHaveBeenCalledWith(userId, { status: 'deactivating' })
    expect(revokeAllSessions).toHaveBeenCalledWith(userId)
    expect(result.success).toBe(true)
    expect(result.status).toBe('deactivating')
    expect(result.daysUntilDeletion).toBe(45)
    expect(result.daysGracePeriod).toBe(30)
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        actionType: 'ACCOUNT_DELETION_SCHEDULED',
        actionStatus: 'success',
      }),
    )
  })

  it('throws SECURITY_PASSWORD_INCORRECT when password wrong', async () => {
    verifyCurrentPassword.mockRejectedValue(new AppError(401, 'Incorrect security password', 'SECURITY_PASSWORD_INCORRECT'))

    await expect(
      accountDeletionService.scheduleDeletion(userId, 'Wrong'),
    ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT', statusCode: 401 })

    expect(create).not.toHaveBeenCalled()
  })

  it('throws DELETION_ALREADY_SCHEDULED when already scheduled', async () => {
    findByUserId.mockResolvedValue({ isCancelled: false })

    await expect(
      accountDeletionService.scheduleDeletion(userId, 'MyP@ssw0rd!'),
    ).rejects.toMatchObject({ code: 'DELETION_ALREADY_SCHEDULED', statusCode: 409 })

    expect(create).not.toHaveBeenCalled()
  })
})

describe('accountDeletionService.getDeletionStatus', () => {
  it('returns isScheduledForDeletion false when no record', async () => {
    cacheGet.mockResolvedValue(null)
    findByUserId.mockResolvedValue(null)

    const result = await accountDeletionService.getDeletionStatus(userId)

    expect(result.isScheduledForDeletion).toBe(false)
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it('returns isScheduledForDeletion false when cancelled', async () => {
    cacheGet.mockResolvedValue(null)
    findByUserId.mockResolvedValue({ isCancelled: true })

    const result = await accountDeletionService.getDeletionStatus(userId)

    expect(result.isScheduledForDeletion).toBe(false)
  })

  it('returns full status when scheduled', async () => {
    cacheGet.mockResolvedValue(null)
    const now = new Date()
    const deactivationUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    const deletionAt = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000)
    findByUserId.mockResolvedValue({
      isCancelled: false,
      scheduledAt: now,
      deactivationUntil,
      deletionAt,
      reason: 'Privacy',
    })

    const result = await accountDeletionService.getDeletionStatus(userId)

    expect(result.isScheduledForDeletion).toBe(true)
    expect(result.daysRemaining).toBe(45)
    expect(result.canReactivate).toBe(true)
    expect(result.reason).toBe('Privacy')
    expect(cacheSet).toHaveBeenCalled()
  })

  it('returns cached result when cache hit', async () => {
    const cached = JSON.stringify({
      isScheduledForDeletion: true,
      scheduledAt: new Date().toISOString(),
      deactivationUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
      deletionAt: new Date(Date.now() + 45 * 86400000).toISOString(),
      daysRemaining: 44,
      daysUntilCancel: 29,
      canReactivate: true,
      reason: null,
    })
    cacheGet.mockResolvedValue(cached)

    const result = await accountDeletionService.getDeletionStatus(userId)

    expect(result.isScheduledForDeletion).toBe(true)
    expect(result.daysRemaining).toBe(44)
    expect(findByUserId).not.toHaveBeenCalled()
  })
})

describe('accountDeletionService.cancelDeletion', () => {
  it('cancels deletion within grace period', async () => {
    const now = new Date()
    const deactivationUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    findByUserId.mockResolvedValue({
      id: 'del-1',
      isCancelled: false,
      deactivationUntil,
    })
    update.mockResolvedValue({})

    const result = await accountDeletionService.cancelDeletion(userId, 'MyP@ssw0rd!')

    expect(verifyCurrentPassword).toHaveBeenCalledWith(userId, 'MyP@ssw0rd!')
    expect(update).toHaveBeenCalledWith('del-1', expect.objectContaining({ isCancelled: true }))
    expect(userUpdate).toHaveBeenCalledWith(userId, { status: 'active' })
    expect(result.success).toBe(true)
    expect(result.status).toBe('active')
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'ACCOUNT_DELETION_CANCELLED',
        actionStatus: 'success',
      }),
    )
  })

  it('throws NOT_SCHEDULED_FOR_DELETION when no record', async () => {
    findByUserId.mockResolvedValue(null)

    await expect(
      accountDeletionService.cancelDeletion(userId, 'MyP@ssw0rd!'),
    ).rejects.toMatchObject({ code: 'NOT_SCHEDULED_FOR_DELETION', statusCode: 400 })
  })

  it('throws NOT_SCHEDULED_FOR_DELETION when already cancelled', async () => {
    findByUserId.mockResolvedValue({ isCancelled: true })

    await expect(
      accountDeletionService.cancelDeletion(userId, 'MyP@ssw0rd!'),
    ).rejects.toMatchObject({ code: 'NOT_SCHEDULED_FOR_DELETION', statusCode: 400 })
  })

  it('throws DELETION_WINDOW_EXPIRED when grace period passed', async () => {
    const past = new Date(Date.now() - 1000)
    findByUserId.mockResolvedValue({
      id: 'del-1',
      isCancelled: false,
      deactivationUntil: past,
    })

    await expect(
      accountDeletionService.cancelDeletion(userId, 'MyP@ssw0rd!'),
    ).rejects.toMatchObject({ code: 'DELETION_WINDOW_EXPIRED', statusCode: 400 })

    expect(update).not.toHaveBeenCalled()
  })

  it('throws SECURITY_PASSWORD_INCORRECT when password wrong', async () => {
    const future = new Date(Date.now() + 86400000)
    findByUserId.mockResolvedValue({
      id: 'del-1',
      isCancelled: false,
      deactivationUntil: future,
    })
    verifyCurrentPassword.mockRejectedValue(
      new AppError(401, 'Incorrect security password', 'SECURITY_PASSWORD_INCORRECT'),
    )

    await expect(
      accountDeletionService.cancelDeletion(userId, 'Wrong'),
    ).rejects.toMatchObject({ code: 'SECURITY_PASSWORD_INCORRECT', statusCode: 401 })
  })
})

describe('accountDeletionService.runDeletionJob', () => {
  it('calls deleteAccountPermanently for each account and returns counts', async () => {
    const now = new Date()
    findForDeletion.mockResolvedValue([
      { id: 'del-1', userId: 'user-1', deletionAt: now },
      { id: 'del-2', userId: 'user-2', deletionAt: now },
    ])
    deleteAccountPermanently.mockResolvedValue(undefined)

    const result = await accountDeletionService.runDeletionJob()

    expect(findForDeletion).toHaveBeenCalled()
    expect(deleteAccountPermanently).toHaveBeenCalledWith('user-1', 'del-1')
    expect(deleteAccountPermanently).toHaveBeenCalledWith('user-2', 'del-2')
    expect(result.deletedCount).toBe(2)
    expect(result.errors).toHaveLength(0)
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'system',
        actionType: 'ACCOUNT_DELETION_JOB_COMPLETED',
        actionStatus: 'success',
      }),
    )
  })

  it('collects errors and reports partial success', async () => {
    findForDeletion.mockResolvedValue([
      { id: 'del-1', userId: 'user-1', deletionAt: new Date() },
      { id: 'del-2', userId: 'user-2', deletionAt: new Date() },
    ])
    deleteAccountPermanently
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('DB error'))

    const result = await accountDeletionService.runDeletionJob()

    expect(result.deletedCount).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ userId: 'user-2', error: 'DB error' })
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionStatus: 'failed',
        actionDetails: expect.objectContaining({ errorCount: 1, partial: true }),
      }),
    )
  })

  it('returns zero when no accounts to delete', async () => {
    findForDeletion.mockResolvedValue([])

    const result = await accountDeletionService.runDeletionJob()

    expect(result.deletedCount).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(deleteAccountPermanently).not.toHaveBeenCalled()
  })
})

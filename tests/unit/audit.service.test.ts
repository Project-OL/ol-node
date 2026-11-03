import { describe, it, expect, vi, beforeEach } from 'vitest'

const logMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/repositories/audit.repository', () => ({
  auditRepository: { log: (...args: unknown[]) => logMock(...args) },
}))

const { auditService } = await import('../../src/services/audit.service')

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'

describe('auditService.log (BE-07)', () => {
  beforeEach(() => logMock.mockClear())

  it('passes UUID actors through unchanged', () => {
    auditService.log({
      userId: UUID,
      adminUserId: UUID,
      actionType: 'login',
      actionStatus: 'success',
      actionDetails: { a: 1 },
    })
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: UUID, adminUserId: UUID, actionDetails: { a: 1 } }),
    )
  })

  it('stores null and keeps a non-UUID actor in the details instead of failing the insert', () => {
    auditService.log({
      userId: 'system',
      adminUserId: 'cron',
      actionType: 'JOB',
      actionStatus: 'success',
      actionDetails: { n: 2 },
    })
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        adminUserId: null,
        actionDetails: { n: 2, userIdNonUuid: 'system', adminUserIdNonUuid: 'cron' },
      }),
    )
  })

  it('leaves null / missing actors alone', () => {
    auditService.log({ actionType: 'anon', actionStatus: 'failed' })
    const arg = logMock.mock.calls[0][0]
    expect(arg.userId).toBeUndefined()
    expect(arg.adminUserId).toBeUndefined()
    expect(arg.actionDetails).toBeUndefined()
  })
})

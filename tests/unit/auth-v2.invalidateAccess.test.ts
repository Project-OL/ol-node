import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const invalidateAccessToken = vi.fn()
vi.mock('../../src/services/session.service', () => ({
  sessionService: {
    invalidateAccessToken: (...a: unknown[]) => invalidateAccessToken(...a),
  },
  invalidateUserTokenVersionCache: vi.fn(),
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}))

import { signAccess } from '../../src/utils/jwt'
import { authV2Service } from '../../src/services/auth-v2.service'

describe('authV2Service.invalidateAccessByToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateAccessToken.mockResolvedValue({ sessionTokenVersion: 3 })
  })

  it('invalidates access only and returns new sessionTokenVersion', async () => {
    const accessToken = signAccess({
      userId: 'user-1',
      publicId: 99,
      passwordSet: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      tokenVersion: 0,
      sessionTokenVersion: 2,
      jti: 'jti-1',
    })
    const out = await authV2Service.invalidateAccessByToken(accessToken)
    expect(invalidateAccessToken).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    )
    expect(out).toEqual({
      message: 'Access token invalidated; refresh to continue',
      sessionTokenVersion: 3,
    })
  })

  it('rejects invalid token', async () => {
    await expect(authV2Service.invalidateAccessByToken('bad')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
  })

  it('requires sessionId in token', async () => {
    const accessToken = signAccess({
      userId: 'user-1',
      publicId: 99,
      passwordSet: true,
      tokenVersion: 0,
      jti: 'jti-2',
    })
    await expect(authV2Service.invalidateAccessByToken(accessToken)).rejects.toMatchObject({
      code: 'SESSION_ID_REQUIRED',
    })
  })

  it('surfaces session invalid', async () => {
    const accessToken = signAccess({
      userId: 'user-1',
      publicId: 99,
      passwordSet: true,
      sessionId: '22222222-2222-4222-8222-222222222222',
      tokenVersion: 0,
      sessionTokenVersion: 0,
      jti: 'jti-3',
    })
    invalidateAccessToken.mockRejectedValueOnce(
      new AppError(401, 'Session invalid', 'SESSION_INVALID'),
    )
    await expect(authV2Service.invalidateAccessByToken(accessToken)).rejects.toMatchObject({
      code: 'SESSION_INVALID',
    })
  })
})

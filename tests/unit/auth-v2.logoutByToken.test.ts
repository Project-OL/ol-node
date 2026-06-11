import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '../../src/middlewares/errorHandler'

const revokeSession = vi.fn()
vi.mock('../../src/services/session.service', () => ({
  sessionService: {
    revokeSession: (...a: unknown[]) => revokeSession(...a),
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

describe('authV2Service.logoutByAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokeSession.mockResolvedValue(undefined)
  })

  it('revokes session from accessToken in body', async () => {
    const accessToken = signAccess({
      userId: 'user-1',
      publicId: 99,
      passwordSet: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      tokenVersion: 0,
      sessionTokenVersion: 0,
      jti: 'jti-1',
    })
    const out = await authV2Service.logoutByAccessToken(accessToken)
    expect(out.message).toBe('Logged out successfully')
    expect(revokeSession).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'user-1',
    )
  })

  it('rejects invalid token', async () => {
    await expect(authV2Service.logoutByAccessToken('not-a-jwt')).rejects.toMatchObject({
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
    await expect(authV2Service.logoutByAccessToken(accessToken)).rejects.toMatchObject({
      code: 'SESSION_ID_REQUIRED',
    })
  })

  it('is idempotent when session already removed', async () => {
    const accessToken = signAccess({
      userId: 'user-1',
      publicId: 99,
      passwordSet: true,
      sessionId: '22222222-2222-4222-8222-222222222222',
      tokenVersion: 0,
      sessionTokenVersion: 0,
      jti: 'jti-3',
    })
    revokeSession.mockRejectedValueOnce(new AppError(404, 'Session not found', 'SESSION_NOT_FOUND'))
    const out = await authV2Service.logoutByAccessToken(accessToken)
    expect(out).toEqual({ message: 'Logged out successfully', alreadyRevoked: true })
  })
})

/**
 * Shared vi.mock side effects for HTTP contract tests.
 * Import first: `import './helpers/mocks'`
 */
import { vi } from 'vitest'
import { AppError } from '../../../src/middlewares/errorHandler'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001'

const { rateLimitNoop } = vi.hoisted(() => {
  const fn = async () => {}
  return { rateLimitNoop: fn }
})

vi.mock('../../../src/middlewares/auth.middleware', () => ({
  authenticate: async (request: { headers: Record<string, unknown>; userId?: string }) => {
    const auth = request.headers.authorization
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    request.userId = TEST_USER_ID
  },
}))

vi.mock('../../../src/middlewares/rateLimitAuth', () => ({
  buildRateLimit: () => rateLimitNoop,
  rateLimitMsgSend: rateLimitNoop,
  rateLimitConvCreate: rateLimitNoop,
  rateLimitMediaUpload: rateLimitNoop,
  rateLimitReaction: rateLimitNoop,
  rateLimitWithdrawalCreate: rateLimitNoop,
  rateLimitWithdrawalDispute: rateLimitNoop,
  rateLimitCtExchange: rateLimitNoop,
  rateLimitCtTopup: rateLimitNoop,
  rateLimitCtTransfer: rateLimitNoop,
  giftSendRateLimit: rateLimitNoop,
  authRateLimits: {
    signupSendOtp: rateLimitNoop,
    signupVerifyOtp: rateLimitNoop,
    loginSendOtp: rateLimitNoop,
    loginVerifyOtp: rateLimitNoop,
    loginPassword: rateLimitNoop,
    passwordResetSendOtp: rateLimitNoop,
    passwordResetConfirm: rateLimitNoop,
    providerBind: rateLimitNoop,
    providerUnbind: rateLimitNoop,
    logoutToken: rateLimitNoop,
    invalidateAccessToken: rateLimitNoop,
  },
}))

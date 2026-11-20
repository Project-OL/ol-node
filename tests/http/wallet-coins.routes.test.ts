import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHttpTestApp, authHeader, TEST_USER_ID } from './helpers/http-test-app'

vi.mock('../../src/middlewares/auth.middleware', async () => {
  const { AppError } = await import('../../src/middlewares/errorHandler')
  return {
    authenticate: async (request: { headers: Record<string, unknown>; userId?: string }) => {
      const auth = request.headers.authorization
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      }
      request.userId = TEST_USER_ID
    },
  }
})

const getCoinBalance = vi.fn()

vi.mock('../../src/services/wallet.service', () => ({
  walletService: { getCoinBalance: (...a: unknown[]) => getCoinBalance(...a) },
}))

const confirmTopup = vi.fn()

vi.mock('../../src/services/coin-wallet.service', () => ({
  coinWalletService: { confirmTopup: (...a: unknown[]) => confirmTopup(...a) },
}))

import { walletCoinsRoutes } from '../../src/routes/v1/wallet-coins.routes'

describe('HTTP contract: wallet coins routes', () => {
  let app: Awaited<ReturnType<typeof createHttpTestApp>>

  beforeEach(async () => {
    getCoinBalance.mockReset()
    app = await createHttpTestApp(walletCoinsRoutes, { prefix: '/api/v1/wallet/coins' })
  })

  afterEach(async () => {
    await app.close()
  })

  it('POST /wallet/coins/topup/confirm is retired: 410 and never credits', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/coins/topup/confirm',
      headers: authHeader(),
      payload: {
        orderId: '00000000-0000-4000-8000-000000000001',
        gatewayRef: 'anything',
        idempotencyKey: 'idem-key-12345',
      },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'TOPUP_CONFIRM_REMOVED' })
    expect(confirmTopup).not.toHaveBeenCalled()
  })

  it('GET /wallet/coins/balance returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/wallet/coins/balance' })
    expect(res.statusCode).toBe(401)
  })

  it('GET /wallet/coins/balance returns balance string', async () => {
    getCoinBalance.mockResolvedValue(1234n)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/coins/balance',
      headers: authHeader(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balance: '1234' })
    expect(getCoinBalance).toHaveBeenCalledWith(TEST_USER_ID)
  })
})

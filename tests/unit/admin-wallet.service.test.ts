import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: {
    findById: vi.fn(),
  },
}))

vi.mock('../../src/services/point-wallet.service', () => ({
  pointWalletService: {
    creditPoints: vi.fn(),
  },
}))

vi.mock('../../src/services/coin-wallet.service', () => ({
  coinWalletService: {
    credit: vi.fn(),
  },
}))

vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    adjustCoinBalanceCache: vi.fn(),
    adjustTradingBalanceCache: vi.fn(),
  },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: {
    log: vi.fn(),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}))

const { userRepository } = await import('../../src/repositories/user.repository')
const { pointWalletService } = await import('../../src/services/point-wallet.service')
const { adminWalletService } = await import('../../src/services/adminWallet.service')

describe('adminWalletService.creditUserWallets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(userRepository.findById).mockResolvedValue({ id: 'user-1' } as never)
  })

  it('rejects when no amounts are provided', async () => {
    await expect(
      adminWalletService.creditUserWallets({
        adminUserId: 'admin-1',
        targetUserId: 'user-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('rejects unknown user', async () => {
    vi.mocked(userRepository.findById).mockResolvedValue(null)
    await expect(
      adminWalletService.creditUserWallets({
        adminUserId: 'admin-1',
        targetUserId: 'missing',
        points: 100n,
      }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' })
  })

  it('credits points with ADJUSTMENT idempotency suffix', async () => {
    vi.mocked(pointWalletService.creditPoints).mockResolvedValue({
      ledgerEntryId: 'pl-1',
      balanceAfter: '1000',
    } as never)

    const result = await adminWalletService.creditUserWallets({
      adminUserId: 'admin-1',
      targetUserId: 'user-1',
      points: 500n,
      idempotencyKey: 'idem-abc',
    })

    expect(pointWalletService.creditPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        amount: 500n,
        idempotencyKey: 'idem-abc:points',
      }),
    )
    expect(result.credited.points).toBe('500')
    expect(result.balances.points?.ledgerEntryId).toBe('pl-1')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LevelType, PointTxType, WalletCurrencyType } from '@prisma/client'

/**
 * Livestream XP is host-earnings based and must be strictly opt-in. These tests pin
 * the gating in pointWalletService.creditInTransaction: applyCredit(LIVESTREAM) fires
 * only when `applyLivestreamLevel === true` AND the txType is not an agent transfer/
 * commission. Payroll and withdrawal refund credits never pass the flag.
 */

const applyCredit = vi.fn().mockResolvedValue({
  newCumulative: 0n,
  newLevel: 1,
  previousLevel: 1,
})
vi.mock('../../src/services/user-level.service', () => ({
  walletLevelService: { applyCredit: (...a: unknown[]) => applyCredit(...a) },
}))

const applyCommission = vi.fn().mockResolvedValue({ bustAgentUserId: null })
vi.mock('../../src/services/agencyCommission.service', () => ({
  agencyCommissionService: {
    applyCommission: (...a: unknown[]) => applyCommission(...a),
    bustAgentCommissionCaches: vi.fn(),
  },
}))

vi.mock('../../src/services/withdrawal.service', () => ({
  withdrawalService: { createWithdrawal: vi.fn() },
}))

const onHostPointCredit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/services/ranking.service', () => ({
  rankingService: {
    onHostPointCredit: (...a: unknown[]) => onHostPointCredit(...a),
  },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  getRedisForRead: () => ({ get: vi.fn() }),
  RedisKeys: { walletPointsUnconfirmed: (id: string) => `wallet:points:unconfirmed:${id}` },
  WALLET_BALANCE_TTL: 300,
}))

vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    adjustPointBalanceCache: vi.fn(),
    getPointBalance: vi.fn(),
  },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn() },
}))

vi.mock('../../src/repositories/wallet.repository', () => ({
  walletRepository: {
    getOrCreate: vi.fn(),
    lockForUpdate: vi.fn(),
    bumpVersion: vi.fn(),
  },
}))

vi.mock('../../src/repositories/point-ledger.repository', () => ({
  pointLedgerRepository: {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    insert: vi
      .fn()
      .mockImplementation(async (_tx, data: { balanceAfter: bigint }) => ({
        id: 'pt-ledger-1',
        balanceAfter: data.balanceAfter,
      })),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {},
  prismaRead: {},
}))

import { pointWalletService } from '../../src/services/point-wallet.service'

function makeTx(startingBalance = 0n) {
  return {
    wallet: {
      upsert: vi.fn().mockResolvedValue({ id: 'wallet-1', currencyType: WalletCurrencyType.POINT }),
    },
    pointLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue({ balanceAfter: startingBalance }),
    },
  }
}

describe('Livestream XP triggers (creditInTransaction gating)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GIFT_RECEIVE with applyLivestreamLevel=true: applyCredit(LIVESTREAM) called', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'host-1',
      6_000n,
      PointTxType.GIFT_RECEIVE,
      tx as never,
      { idempotencyKey: 'gift-recv-1', applyLivestreamLevel: true },
    )
    expect(applyCredit).toHaveBeenCalledWith(tx, 'host-1', LevelType.LIVESTREAM, 6_000n)
  })

  it('SUBSCRIPTION host credit with applyLivestreamLevel=true: applyCredit(LIVESTREAM) called', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'host-1',
      37_500n,
      PointTxType.SUBSCRIPTION,
      tx as never,
      { idempotencyKey: 'sub-1', applyLivestreamLevel: true },
    )
    expect(applyCredit).toHaveBeenCalledWith(tx, 'host-1', LevelType.LIVESTREAM, 37_500n)
  })

  it('GUARDIAN_PURCHASE host credit with applyLivestreamLevel=true: applyCredit(LIVESTREAM) called', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'host-1',
      112_500n,
      PointTxType.GUARDIAN_PURCHASE,
      tx as never,
      { idempotencyKey: 'guardian-1', applyLivestreamLevel: true },
    )
    expect(applyCredit).toHaveBeenCalledWith(tx, 'host-1', LevelType.LIVESTREAM, 112_500n)
  })

  it('PAYROLL_HOST_PAYOUT (flag omitted): applyCredit(LIVESTREAM) NOT called', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'host-1',
      10_000n,
      PointTxType.PAYROLL_HOST_PAYOUT,
      tx as never,
      { idempotencyKey: 'payroll-1' },
    )
    expect(applyCredit).not.toHaveBeenCalled()
  })

  it('WITHDRAWAL_REFUND (flag omitted): applyCredit(LIVESTREAM) NOT called', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'host-1',
      10_000n,
      PointTxType.WITHDRAWAL_REFUND,
      tx as never,
      { idempotencyKey: 'refund-1' },
    )
    expect(applyCredit).not.toHaveBeenCalled()
  })

  it('AGENT_COMMISSION never applies livestream even if flag is true', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'agent-1',
      500n,
      PointTxType.AGENT_COMMISSION,
      tx as never,
      { idempotencyKey: 'commission-1', applyLivestreamLevel: true },
    )
    expect(applyCredit).not.toHaveBeenCalled()
  })

  it('AGENT_POINT_TRANSFER never applies livestream even if flag is true', async () => {
    const tx = makeTx()
    await pointWalletService.creditInTransaction(
      'agent-1',
      500n,
      PointTxType.AGENT_POINT_TRANSFER,
      tx as never,
      { idempotencyKey: 'agent-transfer-1', applyLivestreamLevel: true },
    )
    expect(applyCredit).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CoinTxType, LevelType, WalletCurrencyType } from '@prisma/client'

/**
 * Wealth XP tracks coin SPEND (debits). These tests pin the gating logic in
 * coinWalletService: applyCredit(WEALTH) fires only when the caller opts in
 * (`applyWealthXp` for debits / `applyWealthCredit` for credits) and the wallet
 * is personal COIN. Recharge flows (TOPUP, transfer-in, admin credit) pass
 * `applyWealthCredit: false` at call sites — rich tier only.
 */

const applyCredit = vi.fn().mockResolvedValue({
  newCumulative: 0n,
  newLevel: 1,
  previousLevel: 1,
})
vi.mock('../../src/services/user-level.service', () => ({
  walletLevelService: { applyCredit: (...a: unknown[]) => applyCredit(...a) },
}))

const applyRecharge = vi.fn().mockResolvedValue({ year: 2026, month: 6 })
vi.mock('../../src/services/rich-tier.service', () => ({
  RECHARGE_TX_TYPES: new Set([
    CoinTxType.TOPUP,
    CoinTxType.TRADING_TRANSFER_IN,
    CoinTxType.ADJUSTMENT,
  ]),
  richTierService: { applyRecharge: (...a: unknown[]) => applyRecharge(...a) },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  getRedisForRead: () => ({ get: vi.fn() }),
  RedisKeys: {},
}))

vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    adjustCoinBalanceCache: vi.fn(),
    adjustPointBalanceCache: vi.fn(),
  },
}))

vi.mock('../../src/services/audit.service', () => ({
  auditService: { log: vi.fn() },
}))

vi.mock('../../src/lib/epay.client', () => ({
  epayClient: { createOrder: vi.fn() },
}))

vi.mock('../../src/repositories/wallet.repository', () => ({
  walletRepository: {
    getOrCreate: vi.fn(),
    lockForUpdate: vi.fn(),
    bumpVersion: vi.fn(),
  },
}))

vi.mock('../../src/repositories/coin-ledger.repository', () => ({
  coinLedgerRepository: {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    insert: vi
      .fn()
      .mockImplementation(async (_tx, data: { balanceAfter: bigint }) => ({
        id: 'ledger-1',
        balanceAfter: data.balanceAfter,
      })),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        personalCoinsFrozen: false,
        tradingCoinsFrozen: false,
        pointsFrozen: false,
      }),
    },
  },
  prismaRead: {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        personalCoinsFrozen: false,
        tradingCoinsFrozen: false,
        pointsFrozen: false,
      }),
    },
  },
}))

import { coinWalletService } from '../../src/services/coin-wallet.service'

function makeTx(startingBalance = 1_000_000n) {
  return {
    wallet: {
      upsert: vi.fn().mockImplementation(
        ({
          where,
        }: {
          where: { userId_currencyType: { currencyType: WalletCurrencyType } }
        }) => ({
          id: 'wallet-1',
          currencyType: where.userId_currencyType.currencyType,
        }),
      ),
    },
    coinLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue({ balanceAfter: startingBalance }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        personalCoinsFrozen: false,
        tradingCoinsFrozen: false,
        pointsFrozen: false,
      }),
    },
  }
}

describe('Wealth XP triggers (coin debit gating)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gift send: applyCredit(WEALTH) called with full coin cost when applyWealthXp=true', async () => {
    const tx = makeTx()
    await coinWalletService.debit('sender-1', 50_000n, CoinTxType.GIFT_SEND, tx as never, {
      idempotencyKey: 'gift-1',
      applyWealthXp: true,
    })
    expect(applyCredit).toHaveBeenCalledWith(tx, 'sender-1', LevelType.WEALTH, 50_000n)
  })

  it('username change (applyWealthXp omitted): applyCredit(WEALTH) NOT called', async () => {
    const tx = makeTx()
    await coinWalletService.debit('user-1', 10_000n, CoinTxType.USERNAME_CHANGE, tx as never, {
      idempotencyKey: 'username-1',
    })
    expect(applyCredit).not.toHaveBeenCalled()
  })

  it('trading-coin debit never applies wealth even with applyWealthXp=true', async () => {
    const tx = makeTx()
    await coinWalletService.debit(
      'agent-1',
      500n,
      CoinTxType.TRADING_TRANSFER_OUT,
      tx as never,
      {
        idempotencyKey: 'trade-out-1',
        applyWealthXp: true,
        currencyType: WalletCurrencyType.TRADING_COIN,
      },
    )
    expect(applyCredit).not.toHaveBeenCalled()
  })

  it('store item purchase: applyCredit(WEALTH) called when applyWealthXp=true', async () => {
    const tx = makeTx()
    await coinWalletService.debitForStoreItemPurchase(
      'buyer-1',
      30_000n,
      {
        recipientId: 'r-1',
        storeItemId: 'item-1',
        idempotencyKey: 'store-1',
        applyWealthXp: true,
      },
      tx as never,
    )
    expect(applyCredit).toHaveBeenCalledWith(tx, 'buyer-1', LevelType.WEALTH, 30_000n)
  })

  it('rare ID purchase: applyCredit(WEALTH) called when applyWealthXp=true', async () => {
    const tx = makeTx()
    await coinWalletService.debitForVipPurchase(
      'buyer-1',
      80_000n,
      {
        recipientId: 'r-1',
        publicId: '12345',
        idempotencyKey: 'vip-1',
        applyWealthXp: true,
      },
      tx as never,
    )
    expect(applyCredit).toHaveBeenCalledWith(tx, 'buyer-1', LevelType.WEALTH, 80_000n)
  })
})

describe('Wealth XP triggers (coin credit gating)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('applyWealthCredit=true on personal COIN credit still applies wealth (opt-in gate)', async () => {
    const tx = makeTx()
    await coinWalletService.credit(
      'recipient-1',
      500n,
      CoinTxType.TRADING_TRANSFER_IN,
      tx as never,
      { idempotencyKey: 'transfer-in-1', applyWealthCredit: true },
    )
    expect(applyCredit).toHaveBeenCalledWith(tx, 'recipient-1', LevelType.WEALTH, 500n)
  })

  it('VIP_REWARD credit with applyWealthCredit=false: applyCredit(WEALTH) NOT called', async () => {
    const tx = makeTx()
    await coinWalletService.credit('user-1', 1_000n, CoinTxType.VIP_REWARD, tx as never, {
      idempotencyKey: 'vip-reward-1',
      applyWealthCredit: false,
    })
    expect(applyCredit).not.toHaveBeenCalled()
  })

  it('TRADING_TRANSFER_IN to TRADING_COIN never applies wealth even with applyWealthCredit=true', async () => {
    const tx = makeTx()
    await coinWalletService.credit(
      'agent-1',
      500n,
      CoinTxType.TRADING_TRANSFER_IN,
      tx as never,
      {
        idempotencyKey: 'transfer-in-trading-1',
        applyWealthCredit: true,
        currencyType: WalletCurrencyType.TRADING_COIN,
      },
    )
    expect(applyCredit).not.toHaveBeenCalled()
  })
})

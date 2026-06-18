import { describe, it, expect } from 'vitest'
import { CoinTxType, LedgerDirection, PointTxType } from '@prisma/client'
import { getTransactionName } from '../../src/config/transaction-display-names'

describe('getTransactionName', () => {
  it('returns point credit labels', () => {
    expect(
      getTransactionName('POINT', PointTxType.GIFT_RECEIVE, LedgerDirection.CREDIT),
    ).toBe('Gift received')
    expect(
      getTransactionName('POINT', PointTxType.ADJUSTMENT, LedgerDirection.CREDIT),
    ).toBe('Admin point credit')
  })

  it('returns point debit labels', () => {
    expect(
      getTransactionName('POINT', PointTxType.WITHDRAWAL_ESCROW, LedgerDirection.DEBIT),
    ).toBe('Withdraw requested')
    expect(
      getTransactionName('POINT', PointTxType.AGENT_POINT_TRANSFER, LedgerDirection.DEBIT),
    ).toBe('Point transfer sent')
  })

  it('returns coin and trading coin labels', () => {
    expect(getTransactionName('COIN', CoinTxType.GIFT_SEND, LedgerDirection.DEBIT)).toBe(
      'Gift sent',
    )
    expect(
      getTransactionName('TRADING_COIN', CoinTxType.TRADING_TRANSFER_OUT, LedgerDirection.DEBIT),
    ).toBe('Coins sent')
    expect(
      getTransactionName('TRADING_COIN', CoinTxType.TRADING_TOPUP, LedgerDirection.CREDIT),
    ).toBe('Topup')
  })
})

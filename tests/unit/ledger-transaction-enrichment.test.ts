import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CoinTxType, LedgerDirection, PointTxType } from '@prisma/client'

const userFindMany = vi.fn()
const storeItemFindMany = vi.fn()
const agencyHostHistoryFindFirst = vi.fn()

vi.mock('../../src/config/database', () => ({
  prismaRead: {
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    storeItem: { findMany: (...a: unknown[]) => storeItemFindMany(...a) },
    agencyHostHistory: {
      findFirst: (...a: unknown[]) => agencyHostHistoryFindFirst(...a),
    },
  },
}))

import { buildCounterpartyDetailsMap } from '../../src/utils/ledger-transaction-enrichment'

beforeEach(() => {
  vi.clearAllMocks()
  userFindMany.mockResolvedValue([])
  storeItemFindMany.mockResolvedValue([])
  agencyHostHistoryFindFirst.mockResolvedValue(null)
})

describe('buildCounterpartyDetailsMap', () => {
  it('maps user counterparty name and publicId for gift receive', async () => {
    userFindMany.mockResolvedValue([
      {
        id: 'fan-1',
        username: 'fan1',
        firstName: 'Fan',
        lastName: 'One',
        avatarUrl: null,
        publicId: 34216590n,
      },
    ])

    const map = await buildCounterpartyDetailsMap(
      [
        {
          id: 'entry-1',
          direction: LedgerDirection.CREDIT,
          txType: PointTxType.GIFT_RECEIVE,
          amount: 1000n,
          refId: 'gift-1',
          counterpartyId: 'fan-1',
          metadata: null,
          createdAt: new Date(),
        },
      ],
      'POINT',
      'host-1',
    )

    expect(map.get('entry-1')).toEqual({
      userId: 'fan-1',
      name: 'Fan One',
      publicId: '34216590',
      avatarUrl: null,
    })
  })

  it('maps admin metadata for coin adjustment credits', async () => {
    userFindMany.mockResolvedValue([
      {
        id: 'admin-1',
        username: 'admin',
        firstName: null,
        lastName: null,
        avatarUrl: null,
        publicId: 99n,
      },
    ])

    const map = await buildCounterpartyDetailsMap(
      [
        {
          id: 'entry-2',
          direction: LedgerDirection.CREDIT,
          txType: CoinTxType.ADJUSTMENT,
          amount: 5000n,
          refId: null,
          counterpartyId: null,
          metadata: { adminUserId: 'admin-1', source: 'admin_wallet_credit' },
          createdAt: new Date(),
        },
      ],
      'TRADING_COIN',
      'agent-1',
    )

    expect(map.get('entry-2')).toEqual({
      addedByAdmin: {
        adminUserId: 'admin-1',
        name: 'admin',
        publicId: '99',
      },
    })
  })

  it('maps store item and vip membership metadata', async () => {
    storeItemFindMany.mockResolvedValue([
      { id: 'item-1', name: 'Golden Frame', coinCost: 25000 },
    ])

    const storeMap = await buildCounterpartyDetailsMap(
      [
        {
          id: 'entry-3',
          direction: LedgerDirection.DEBIT,
          txType: CoinTxType.STORE_ITEM_PURCHASE,
          amount: 25000n,
          refId: null,
          counterpartyId: null,
          metadata: { storeItemId: 'item-1' },
          createdAt: new Date(),
        },
      ],
      'COIN',
      'user-1',
    )

    expect(storeMap.get('entry-3')).toEqual({
      storeItemName: 'Golden Frame',
      price: '25000',
    })

    const vipMap = await buildCounterpartyDetailsMap(
      [
        {
          id: 'entry-4',
          direction: LedgerDirection.DEBIT,
          txType: CoinTxType.VIP_MEMBERSHIP_PURCHASE,
          amount: 100000n,
          refId: null,
          counterpartyId: null,
          metadata: { tier: 'GOLD', periodDays: 30 },
          createdAt: new Date(),
        },
      ],
      'COIN',
      'user-1',
    )

    expect(vipMap.get('entry-4')).toEqual({ membershipType: 'GOLD' })
  })
})

import { describe, expect, it } from 'vitest'
import {
  assignHostCreditsToGiftRows,
  isGiftRelatedAgencyCommission,
  mapAgencyCommissionToGiftRows,
  type GiftRowForAgency,
  type HostGiftCredit,
} from './gift-agency-commission'

const t0 = new Date('2026-08-26T00:00:00.000Z')

function gift(partial: Partial<GiftRowForAgency> & Pick<GiftRowForAgency, 'id'>): GiftRowForAgency {
  return {
    senderUserId: 'sender-a',
    receiverUserId: 'host-a',
    pointsAwarded: 6000,
    createdAt: t0,
    ...partial,
  }
}

function host(partial: Partial<HostGiftCredit> & Pick<HostGiftCredit, 'id'>): HostGiftCredit {
  return {
    refId: null,
    amount: 6000n,
    createdAt: t0,
    counterpartyId: 'sender-a',
    wallet: { userId: 'host-a' },
    ...partial,
  }
}

describe('isGiftRelatedAgencyCommission (SQL predicate)', () => {
  it('includes tagged message / live / lucky gift commission', () => {
    expect(isGiftRelatedAgencyCommission({ hostTxType: 'GIFT_RECEIVE', refId: 'gift-tx' })).toBe(
      true,
    )
    expect(isGiftRelatedAgencyCommission({ hostTxType: 'LIVESTREAM_GIFT', refId: 'gift-tx' })).toBe(
      true,
    )
  })

  it('does not pull minute video-call, subscription, or guardian into the gift bucket', () => {
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: 'VIDEO_CALL',
        refId: 'session-id',
      }),
    ).toBe(false)
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: 'SUBSCRIPTION',
        refId: 'sub-id',
      }),
    ).toBe(false)
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: 'GUARDIAN_PURCHASE',
        refId: 'guardian-id',
      }),
    ).toBe(false)
  })

  it('includes untagged live-server commission whose refId is a GIFT_RECEIVE host ledger id', () => {
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: null,
        refId: 'host-ledger-1',
        linkedHostTxType: 'GIFT_RECEIVE',
        linkedHostDirection: 'CREDIT',
      }),
    ).toBe(true)
  })

  it('includes untagged lucky-legacy commission whose refId is a gift_transactions.id', () => {
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: '',
        refId: 'gift-tx-lucky',
        linkedIsGiftTransaction: true,
      }),
    ).toBe(true)
  })

  it('excludes untagged minute video-call commission (refId = VIDEO_CALL host ledger id)', () => {
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: null,
        refId: 'vc-host-ledger',
        linkedHostTxType: 'VIDEO_CALL',
        linkedHostDirection: 'CREDIT',
        linkedIsGiftTransaction: false,
      }),
    ).toBe(false)
  })

  it('does not double-count: tagged rows are not also required to match the untagged branch', () => {
    expect(
      isGiftRelatedAgencyCommission({
        hostTxType: 'GIFT_RECEIVE',
        refId: 'gift-tx',
        linkedHostTxType: 'GIFT_RECEIVE',
        linkedIsGiftTransaction: true,
      }),
    ).toBe(true)
  })
})

describe('mapAgencyCommissionToGiftRows', () => {
  it('if both gift-id and host-ledger commission rows exist they add (write path must only mint one)', () => {
    const giftTx = 'gift-tx-1'
    const hostId = 'host-ledger-1'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: giftTx })],
      [host({ id: hostId, refId: giftTx })],
      [host({ id: hostId, refId: giftTx })],
      [
        { refId: giftTx, amount: 240n },
        { refId: hostId, amount: 240n },
      ],
    )
    expect(map.get(giftTx)).toBe(480n)
  })

  it('new writes typically only have commission on the gift id (not also on host ledger id)', () => {
    const giftTx = 'gift-tx-new'
    const hostId = 'host-new'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: giftTx })],
      [host({ id: hostId, refId: giftTx })],
      [host({ id: hostId, refId: giftTx })],
      [{ refId: giftTx, amount: 240n }],
    )
    expect(map.get(giftTx)).toBe(240n)
  })

  it('attributes legacy live/VC commission whose refId is the host ledger id', () => {
    const giftTx = 'gift-tx-legacy'
    const hostId = 'host-legacy'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: giftTx })],
      [],
      [host({ id: hostId, refId: 'catalog-gift-id' })],
      [{ refId: hostId, amount: 240n }],
    )
    expect(map.get(giftTx)).toBe(240n)
  })

  it('attributes lucky-legacy commission on gift_transactions.id without a host refId', () => {
    const giftTx = 'lucky-tx'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: giftTx, pointsAwarded: 400 })],
      [],
      [],
      [{ refId: giftTx, amount: 16n }],
    )
    expect(map.get(giftTx)).toBe(16n)
  })

  it('does not steal a host already claimed by gift-tx refId (no cross-gift double match)', () => {
    const g1 = 'gift-1'
    const g2 = 'gift-2'
    const host1 = 'host-1'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: g1 }), gift({ id: g2, createdAt: new Date(t0.getTime() + 1000) })],
      [host({ id: host1, refId: g1 })],
      [host({ id: host1, refId: g1 })],
      [{ refId: host1, amount: 240n }],
    )
    expect(map.get(g1)).toBe(240n)
    expect(map.get(g2)).toBeUndefined()
  })

  it('picks the nearer unused host when two same-amount gifts land within 15s', () => {
    const g1 = 'gift-near-1'
    const g2 = 'gift-near-2'
    const h1 = 'host-near-1'
    const h2 = 'host-near-2'
    const t1 = t0
    const t2 = new Date(t0.getTime() + 2000)
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: g1, createdAt: t1 }), gift({ id: g2, createdAt: t2 })],
      [],
      [host({ id: h1, createdAt: t1 }), host({ id: h2, createdAt: t2 })],
      [
        { refId: h1, amount: 100n },
        { refId: h2, amount: 200n },
      ],
    )
    expect(map.get(g1)).toBe(100n)
    expect(map.get(g2)).toBe(200n)
  })

  it('ignores hosts outside the 15s window', () => {
    const giftTx = 'gift-far'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: giftTx, createdAt: t0 })],
      [],
      [host({ id: 'host-far', createdAt: new Date(t0.getTime() + 20_000) })],
      [{ refId: 'host-far', amount: 240n }],
    )
    expect(map.get(giftTx)).toBeUndefined()
  })

  it('ignores VIDEO_CALL host credits that are not in the gift host lists', () => {
    const giftTx = 'gift-vc-isolation'
    const map = mapAgencyCommissionToGiftRows(
      [gift({ id: giftTx })],
      [],
      [],
      [{ refId: 'vc-host-ledger', amount: 999n }],
    )
    expect(map.size).toBe(0)
  })

  it('returns empty for no gifts', () => {
    expect(mapAgencyCommissionToGiftRows([], [], [], [{ refId: 'x', amount: 1n }]).size).toBe(0)
  })
})

describe('assignHostCreditsToGiftRows', () => {
  it('prefers host.refId = gift id over near-match', () => {
    const giftTx = 'gift-pref'
    const byRefHost = 'host-by-ref'
    const nearHost = 'host-near'
    const assigned = assignHostCreditsToGiftRows(
      [gift({ id: giftTx })],
      [host({ id: byRefHost, refId: giftTx })],
      [host({ id: nearHost, refId: 'catalog-id' }), host({ id: byRefHost, refId: giftTx })],
    )
    expect(assigned.get(byRefHost)).toBe(giftTx)
    expect(assigned.has(nearHost)).toBe(false)
  })
})

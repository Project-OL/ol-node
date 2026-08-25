/**
 * Gift P&L agency matching (message gifts + live/VC gifts).
 * Pure helpers — used by platform-profit aggregates and unit tests.
 *
 * New writes: AGENT_COMMISSION.refId = gift_transactions.id and
 * metadata.hostTxType is GIFT_RECEIVE or LIVESTREAM_GIFT.
 * Legacy live-server: refId = host ledger id (or gift tx id for lucky), no hostTxType.
 */

export const GIFT_AGENCY_NEAR_MS = 15_000

export const GIFT_PNL_HOST_TX_TYPES = ['GIFT_RECEIVE', 'LIVESTREAM_GIFT'] as const

export type GiftPnlHostTxType = (typeof GIFT_PNL_HOST_TX_TYPES)[number]

export type GiftRowForAgency = {
  id: string
  senderUserId: string
  receiverUserId: string
  pointsAwarded: number
  createdAt: Date
}

export type HostGiftCredit = {
  id: string
  refId: string | null
  amount: bigint
  createdAt: Date
  counterpartyId: string | null
  wallet: { userId: string }
}

export function isGiftPnlHostTxType(
  hostTxType: string | null | undefined,
): hostTxType is GiftPnlHostTxType {
  return hostTxType === 'GIFT_RECEIVE' || hostTxType === 'LIVESTREAM_GIFT'
}

/**
 * Mirrors `sumGiftRelatedAgencyCommission` SQL: tagged gift hostTxType, or
 * untagged rows linked to a gift host credit / gift_transactions.id.
 * Tagged VIDEO_CALL / SUBSCRIPTION / GUARDIAN never match.
 */
export function isGiftRelatedAgencyCommission(params: {
  hostTxType?: string | null
  refId?: string | null
  /** Point-ledger tx type when `refId` is a host ledger id. */
  linkedHostTxType?: string | null
  linkedHostDirection?: string | null
  linkedIsGiftTransaction?: boolean
}): boolean {
  if (isGiftPnlHostTxType(params.hostTxType)) return true
  if ((params.hostTxType ?? '') !== '') return false
  if (!params.refId) return false
  if (
    isGiftPnlHostTxType(params.linkedHostTxType) &&
    (params.linkedHostDirection ?? 'CREDIT') === 'CREDIT'
  ) {
    return true
  }
  return params.linkedIsGiftTransaction === true
}

/** Host ledger id → gift_transactions.id. byRef (new writes) wins over ±15s near-match (legacy). */
export function assignHostCreditsToGiftRows(
  gifts: GiftRowForAgency[],
  byRef: HostGiftCredit[],
  near: HostGiftCredit[],
): Map<string, string> {
  const giftIds = new Set(gifts.map((g) => g.id))
  const hostToGift = new Map<string, string>()
  for (const h of byRef) {
    if (h.refId && giftIds.has(h.refId) && !hostToGift.has(h.id)) {
      hostToGift.set(h.id, h.refId)
    }
  }
  const usedHosts = new Set(hostToGift.keys())
  const claimedGifts = new Set(hostToGift.values())
  for (const g of gifts) {
    if (claimedGifts.has(g.id) || g.pointsAwarded <= 0) continue
    const amount = BigInt(g.pointsAwarded)
    const matches = near.filter(
      (h) =>
        !usedHosts.has(h.id) &&
        h.wallet.userId === g.receiverUserId &&
        h.counterpartyId === g.senderUserId &&
        h.amount === amount &&
        Math.abs(h.createdAt.getTime() - g.createdAt.getTime()) <= GIFT_AGENCY_NEAR_MS,
    )
    matches.sort(
      (a, b) =>
        Math.abs(a.createdAt.getTime() - g.createdAt.getTime()) -
        Math.abs(b.createdAt.getTime() - g.createdAt.getTime()),
    )
    const pick = matches[0]
    if (!pick) continue
    hostToGift.set(pick.id, g.id)
    usedHosts.add(pick.id)
    claimedGifts.add(g.id)
  }
  return hostToGift
}

export function sumCommissionsByGiftId(
  giftIds: string[],
  hostToGift: Map<string, string>,
  commissions: Array<{ refId: string | null; amount: bigint }>,
): Map<string, bigint> {
  const map = new Map<string, bigint>()
  const giftIdSet = new Set(giftIds)
  for (const c of commissions) {
    if (!c.refId) continue
    const giftId = giftIdSet.has(c.refId) ? c.refId : hostToGift.get(c.refId)
    if (!giftId) continue
    map.set(giftId, (map.get(giftId) ?? 0n) + c.amount)
  }
  return map
}

/** Attribute AGENT_COMMISSION rows to gift_transactions without double-counting. */
export function mapAgencyCommissionToGiftRows(
  gifts: GiftRowForAgency[],
  hostsByGiftRef: HostGiftCredit[],
  nearHosts: HostGiftCredit[],
  commissions: Array<{ refId: string | null; amount: bigint }>,
): Map<string, bigint> {
  const hostToGift = assignHostCreditsToGiftRows(gifts, hostsByGiftRef, nearHosts)
  return sumCommissionsByGiftId(
    gifts.map((g) => g.id),
    hostToGift,
    commissions,
  )
}

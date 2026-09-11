import { normalizeAdminTags } from '../models/admin-user-tags.schemas'
import { isCoinsellerByTradingBalance } from './coinseller'

/** Derived labels merged into public `adminTags` at read time (not persisted). */
export const DERIVED_ADMIN_TAGS = {
  AGENCY: 'agency',
  COINSELLER: 'coinseller',
  GIFT_COLLECTION: 'gift collection',
  VIP_DIAMOND: 'VIP Diamond',
  SVIP: 'SVIP',
} as const

/** @deprecated Coinseller is derived from TRADING_COIN balance; kept for call-site compatibility. */
export const ADMIN_MANAGED_TAGS = {
  COINSELLER: DERIVED_ADMIN_TAGS.COINSELLER,
} as const

/** Normalize tag text the same way the Flutter badge matcher does (`coin seller` / `coin_seller` / `coinseller`). */
export function normalizeCoinsellerTagKey(tag: string): string {
  return tag.trim().toLowerCase().replace(/[_\s]+/g, '')
}

export function isCoinsellerAdminTag(tag: string): boolean {
  return normalizeCoinsellerTagKey(tag) === 'coinseller'
}

export function hasCoinsellerAdminTag(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some(isCoinsellerAdminTag)
}

const RICH_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'] as const

export function defaultRichDisplayName(tier: number): string {
  return `RICH ${RICH_ROMAN[tier - 1] ?? String(tier)}`
}

/**
 * Public `adminTags` = derived status labels + stored admin labels.
 * Stored tags are unchanged on PUT `/admin/users/:id/tags`; this merge is GET-only.
 *
 * `coinseller` is derived when the user is an agency owner with TRADING_COIN balance
 * at/above `COINSELLER_MIN_TRADING_BALANCE`. Stored coinseller spellings are stripped
 * so the badge tracks balance, not free-text tags.
 */
export function composePublicAdminTags(input: {
  stored?: string[] | null
  isAgency?: boolean
  /** Agency owner TRADING_COIN balance (ignored unless `isAgency`). */
  tradingBalance?: bigint | number | null
  isFullGallery?: boolean
  vipMembership?: { isActive?: boolean; tier?: string | null } | null
  richTier?: { tier?: number | null; displayName?: string | null } | null
}): string[] {
  const derived: string[] = []
  if (input.isAgency) {
    derived.push(DERIVED_ADMIN_TAGS.AGENCY)
    if (isCoinsellerByTradingBalance(input.tradingBalance)) {
      derived.push(DERIVED_ADMIN_TAGS.COINSELLER)
    }
  }
  if (input.isFullGallery) derived.push(DERIVED_ADMIN_TAGS.GIFT_COLLECTION)
  if (input.vipMembership?.isActive) {
    const tier = input.vipMembership.tier?.toUpperCase()
    if (tier === 'DIAMOND') derived.push(DERIVED_ADMIN_TAGS.VIP_DIAMOND)
    else if (tier === 'SVIP') derived.push(DERIVED_ADMIN_TAGS.SVIP)
  }
  const richTier = input.richTier?.tier ?? 0
  if (richTier > 0) {
    const name = input.richTier?.displayName?.trim()
    derived.push(name ? name : defaultRichDisplayName(richTier))
  }
  const storedWithoutCoinseller = (input.stored ?? []).filter((t) => !isCoinsellerAdminTag(t))
  return normalizeAdminTags([...derived, ...storedWithoutCoinseller])
}

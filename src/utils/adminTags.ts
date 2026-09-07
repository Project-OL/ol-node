import { normalizeAdminTags } from '../models/admin-user-tags.schemas'

/** Derived labels merged into public `adminTags` at read time (not persisted). */
export const DERIVED_ADMIN_TAGS = {
  AGENCY: 'agency',
  GIFT_COLLECTION: 'gift collection',
  VIP_DIAMOND: 'VIP Diamond',
  SVIP: 'SVIP',
} as const

/**
 * Tags an admin applies by hand via `PUT /admin/users/:id/tags`. They are never derived,
 * so being an agency no longer implies being a coin seller — the two are separate facts.
 *
 * Kept here only to pin the canonical spelling in one place. The app's badge matcher
 * (`user_profile_bottom_sheet.dart` `_buildBadgeForTag`) lowercases and trims before
 * comparing, and accepts `coin seller` / `coin_seller` / `coinseller` for this badge, so
 * an admin typing any of those still renders correctly.
 */
export const ADMIN_MANAGED_TAGS = {
  COINSELLER: 'coinseller',
} as const

const RICH_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'] as const

export function defaultRichDisplayName(tier: number): string {
  return `RICH ${RICH_ROMAN[tier - 1] ?? String(tier)}`
}

/**
 * Public `adminTags` = derived status labels + stored admin labels.
 * Stored tags are unchanged on PUT `/admin/users/:id/tags`; this merge is GET-only.
 */
export function composePublicAdminTags(input: {
  stored?: string[] | null
  isAgency?: boolean
  isFullGallery?: boolean
  vipMembership?: { isActive?: boolean; tier?: string | null } | null
  richTier?: { tier?: number | null; displayName?: string | null } | null
}): string[] {
  const derived: string[] = []
  // Approved agencies are tagged `agency` automatically (isAgency mirrors `user.isAgent`,
  // set only by createAgencyFromApplication). `coinseller` is deliberately NOT derived here:
  // it is an admin-applied tag, because an agency is not automatically a coin seller.
  if (input.isAgency) derived.push(DERIVED_ADMIN_TAGS.AGENCY)
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
  return normalizeAdminTags([...derived, ...(input.stored ?? [])])
}

import type { ActiveGuardianProfileDto } from '../models/profile.types'
import type { GalleryCompletionDto } from '../models/me.types'
import type { ActiveStoreItemsMap } from '../models/store.types'

export type UserCard = {
  /** Same as `userId` (UUID); included for picker UIs that expect `id`. */
  id: string
  userId: string
  username: string
  publicId: string
  /** Visible ID with rare/VIP overlay — same rule as `GET /users/me`. */
  displayPublicId: string
  /** True when `users.is_agent` (owns an agency row). See **`agencyTag`** for host vs agent. */
  isAgency: boolean
  name?: string
  displayName: string
  avatarUrl: string | null
  /** Profile bio (`users.bio`); included on `GET /users/search`. */
  bio?: string | null
  country?: string | null
  gender: string | null
  age: number | null
  livestreamLevel: number
  wealthLevel: number
  /** Monthly Rich (Elite) tier; badge gated by VIP. Amount fields are decimal strings. */
  richTier?: {
    /** Rich level 0–10 (same as `tier`). */
    level: number
    tier: number
    displayName: string | null
    badgeVisible: boolean
    /** Current-month progress coins (carryover + recharge); same as `amount`. */
    amount: string
    currentMonthRechargeCoins: string
    currentMonthCarryoverCoins: string
    currentMonthProgressCoins: string
    nextTierThreshold: string | null
    nextTierLackingCoins: string | null
  }
  subscriberCount: number
  isFollowing: boolean
  isFollowedBy: boolean
  isFriend: boolean
  /** True when the authenticated user has blocked this profile (e.g. search). */
  blockedByMe?: boolean
  /** True when this profile has blocked the authenticated user (e.g. search). */
  userBlockedMe?: boolean
  isSuperHost?: boolean
  activeGuardian?: ActiveGuardianProfileDto | null
  activeStoreItems?: ActiveStoreItemsMap
  galleryCompletion?: GalleryCompletionDto
  /** Agency badge: optional `agencyPublicId` is the agent’s default public id (decimal string). */
  agencyTag?: {
    isAgent: boolean
    isHost: boolean
    agencyPublicId?: string
  }
  /** Face registration indexed in Rekognition, or agency KYC `face_verified`. */
  faceVerified?: boolean
  /** Platform-admin labels (e.g. VIP, risk). */
  adminTags?: string[]
  /** Paid VIP membership (Diamond/SVIP); cosmetic flags mirror `isActive`. */
  vipMembership?: {
    isActive: boolean
    tier?: string
    expiresAt?: string
    vipExclusiveProfileCard: boolean
    vipDistinguishedLogo: boolean
    vipExclusiveMessageBackground: boolean
    vipSpecialEntryEffect: boolean
    vipPreventBeingKicked: boolean
    vipLiveTranslationEnabled: boolean
  }
}

export type UserCardWithVisit = UserCard & { visitedAt: Date }

export type PaginatedResult<T> = {
  items: T[]
  nextCursor: string | null
  total: number
}

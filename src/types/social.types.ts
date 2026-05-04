import type { ActiveGuardianProfileDto } from '../models/profile.types'
import type { GalleryCompletionDto } from '../models/me.types'
import type { ActiveStoreItemsMap } from '../models/store.types'

export type UserCard = {
  /** Same as `userId` (UUID); included for picker UIs that expect `id`. */
  id: string
  userId: string
  username: string
  publicId: string
  name?: string
  displayName: string
  avatarUrl: string | null
  country?: string | null
  gender: string | null
  age: number | null
  livestreamLevel: number
  wealthLevel: number
  /** Monthly Rich (Elite) tier; badge gated by VIP. */
  richTier?: {
    tier: number
    displayName: string | null
    badgeVisible: boolean
  }
  subscriberCount: number
  isFollowing: boolean
  isFollowedBy: boolean
  isFriend: boolean
  /** True when the authenticated user has blocked this profile (e.g. search). */
  blockedByMe?: boolean
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


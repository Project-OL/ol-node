import type { MeGender } from '../utils/profileDisplay'
import type { ActiveGuardianProfileDto } from './profile.types'
import type { ActiveStoreItemsMap } from './store.types'

/** Monthly Rich (Elite) tier snapshot for GET /users/me. */
export interface RichTierMeDto {
  tier: number
  displayName: string | null
  evaluatedFromYear: number
  evaluatedFromMonth: number
  currentMonthRechargeCoins: string
  currentMonthCarryoverCoins: string
  currentMonthProgressCoins: string
  nextTierThreshold: string | null
  nextTierLackingCoins: string | null
  badgeVisible: boolean
}

/** Current UTC month global gift gallery completion for this user as host. */
export interface GalleryCompletionDto {
  isFullGallery: boolean
  receivedItems: number
  totalItems: number
  monthEndAt: string
  secondsRemaining: number
}

export interface MeProfileCache {
  userId: string
  publicId: string
  /** Publicly displayed numeric ID: active rare ID when present, otherwise default/base ID. */
  displayPublicId: string
  name: string
  email: string
  avatarUrl: string | null
  country: string | null
  bio: string | null
  /** Calendar date in UTC, `YYYY-MM-DD`, or `null` if unset. */
  dateOfBirth: string | null
  gender: MeGender | null
  canChangeUsername: boolean
  usernameNextChangeAt: string | null
}

export interface MeResponseDto extends MeProfileCache {
  galleryCompletion: GalleryCompletionDto
  /** Caller's current livestream level. */
  livestreamLevel: number
  /** Caller's current wealth level. */
  wealthLevel: number
  /** Caller's coin balance (serialised as string to avoid BigInt issues). */
  coinsBalance: string
  /** Caller's point balance (serialised as string to avoid BigInt issues). */
  pointsBalance: string
  /** Whether the caller currently has an active VIP subscription. */
  isVipActive: boolean
  /** ISO timestamp when the last VIP period started, or null if never had VIP. */
  lastVipStartedAt: string | null
  /** ISO timestamp when the last VIP period expires/expired, or null if never had VIP. */
  lastVipExpiresAt: string | null
  /** Whether the profile user currently has active super-host status. */
  isSuperHost: boolean
  /** Current highest active guardian summary for this profile. */
  activeGuardian: ActiveGuardianProfileDto | null
  /** Active store cosmetics and current rare ID. */
  activeStoreItems: ActiveStoreItemsMap
  /** Monthly Rich tier progress (UTC month); BigInt-like fields as strings. */
  richTier: RichTierMeDto
  /** Agency (agent/host) overlay; Phase 1 — commission logic not yet wired. */
  agency: {
    role: 'AGENT' | 'HOST' | 'NONE'
    asAgent?: {
      agencyPublicId: string
      displayName: string
      avatarUrl: string | null
      totalHostsCount: number
      currentLevel: string
      payrollEnabled: boolean
      paused: boolean
    }
    asHost?: {
      agencyPublicId: string
      agencyDisplayName: string
      avatarUrl: string | null
      joinedAt: string
      pendingLeaveApplication?: { id: string; autoApproveAt: string }
    }
  }
  /** Paid Diamond/SVIP membership (separate from VIP public ID / `isVipActive`). */
  vipMembership: {
    isActive: boolean
    tier?: string
    expiresAt?: string
    daysRemaining: number
    dailyClaimAvailable: boolean
    lastClaimedAt?: string
    vipExclusiveProfileCard: boolean
    vipDistinguishedLogo: boolean
    vipExclusiveMessageBackground: boolean
    vipSpecialEntryEffect: boolean
    vipPreventBeingKicked: boolean
    vipLiveTranslationEnabled: boolean
  }
  /** One-time verified live selfie (CompareFaces vs indexed face); async worker. */
  livePhoto: {
    verified: boolean
    imageUrl: string | null
    verifiedAt: string | null
  }
}

export interface PatchMeResponseDto {
  user: MeResponseDto
  accessToken: string
}

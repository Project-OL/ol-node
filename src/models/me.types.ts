import type { MeGender } from '../utils/profileDisplay'
import type { ActiveGuardianProfileDto } from './profile.types'
import type { ActiveStoreItemsMap } from './store.types'

/** Monthly Rich (Elite) tier snapshot for GET /users/me. */
export interface RichTierMeDto {
  /** Rich level 0–10 (alias of `tier` for profile UIs). */
  level: number
  tier: number
  displayName: string | null
  evaluatedFromYear: number
  evaluatedFromMonth: number
  /** Progress coins this UTC month (carryover + recharge); alias of `currentMonthProgressCoins`. */
  amount: string
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
  /** ISO timestamp of last display-name change; drives monthly free-change eligibility. */
  usernameUpdatedAt: string | null
  canChangeUsername: boolean
  usernameNextChangeAt: string | null
  /** Platform-admin labels plus derived status tags (coinseller, gift collection, VIP, rich tier). */
  adminTags: string[]
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
      /** Live owner first + last (`formatUserName`); empty if both missing. */
      displayName: string
      /** Same as `displayName`. */
      name: string
      avatarUrl: string | null
      totalHostsCount: number
      currentLevel: string
      payrollEnabled: boolean
      /** Admin must grant this before the agent accept-toggle can be turned on. */
      payrollPrivilegeGranted: boolean
      paused: boolean
    }
    asHost?: {
      agencyPublicId: string
      /** Live agency-owner first + last (`formatUserName`); empty if both missing. */
      agencyDisplayName: string
      /** Same as `agencyDisplayName`. */
      name: string
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
  /** Face registration indexed in Rekognition, or agency KYC `face_verified`. */
  faceVerified: boolean
  /**
   * Face profile status: `INDEXED` / `PENDING_INDEX` / `FAILED` / `REVOKED` / `DUPLICATE_FACE`,
   * or `NONE` when the user has never submitted a face. Additive — login sessions stay valid
   * when this is `REVOKED`; send the user to face registration (`faceCanReRegister`).
   */
  faceStatus: string
  /** True when the caller may start `POST /face-registration/session` (revoked or failed profile). */
  faceCanReRegister: boolean
  /**
   * Global video-call availability: `true` = willing to receive calls right now.
   * Default `true` when the user has never configured call settings.
   */
  acceptVideoCalls: boolean
}

export interface PatchMeResponseDto {
  user: MeResponseDto
  accessToken: string
}

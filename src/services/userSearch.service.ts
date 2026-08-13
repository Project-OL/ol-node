import { userRepository } from '../repositories/user.repository'
import { walletLevelService } from './user-level.service'
import { userSubscriberRepository } from '../repositories/userSubscriber.repository'
import type { UserCard } from '../types/social.types'
import { AppError } from '../middlewares/errorHandler'
import { followRepository } from '../repositories/follow.repository'
import { superHostService } from './super-host.service'
import { guardianService } from './guardian.service'
import { giftGalleryService } from './gift-gallery.service'
import { blockRepository } from '../repositories/block.repository'
import { storeService } from './store.service'
import { richTierService } from './rich-tier.service'
import { vipMembershipService } from './vip-membership.service'
import { prismaRead } from '../config/database'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { presenceService } from './presence.service'
import { videoCallSettingsService } from './video-call.service'
import { buildUserDisplayName, formatUserName } from '../utils/user-display'
import { cacheRedisService } from './cacheRedis.service'
import { RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { singleflight } from '../utils/singleflight'
import { composePublicAdminTags } from '../utils/adminTags'

type SearchCardShared = Pick<
  UserCard,
  | 'livestreamLevel'
  | 'wealthLevel'
  | 'richTier'
  | 'subscriberCount'
  | 'isSuperHost'
  | 'activeGuardian'
  | 'activeStoreItems'
  | 'galleryCompletion'
  | 'vipMembership'
  | 'faceVerified'
  | 'acceptVideoCalls'
  | 'agencyTag'
>

function isSearchCardShared(value: SearchCardShared | null): value is SearchCardShared {
  return value != null && typeof value.subscriberCount === 'number'
}

async function loadSearchCardShared(user: {
  id: string
  isAgent: boolean
  currentAgencyId: string | null
}): Promise<SearchCardShared> {
  const key = RedisKeys.userSearchCard(user.id)
  const cached = await cacheRedisService.get<SearchCardShared>(key)
  if (isSearchCardShared(cached)) return cached

  return singleflight(`search:card:${user.id}`, async () => {
    const again = await cacheRedisService.get<SearchCardShared>(key)
    if (isSearchCardShared(again)) return again

    const agencyLookupId = user.isAgent ? user.id : (user.currentAgencyId ?? null)
    const [
      levels,
      subscriberCounts,
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      galleryCompletion,
      richTier,
      vipMembership,
      faceVerified,
      acceptVideoCalls,
      agencyRow,
    ] = await Promise.all([
      walletLevelService.getDisplayLevelsForUsers([user.id]),
      userSubscriberRepository.countSubscribersForCreators([user.id]),
      superHostService.isSuperHost(user.id),
      guardianService.getActiveGuardianSummary(user.id),
      storeService.getActiveItemsForUser(user.id),
      giftGalleryService.getCompletionSummaryForUser(user.id),
      richTierService.getRichTierCardFields(user.id),
      vipMembershipService.getActiveMembershipSummary(user.id),
      faceVerificationRepository.isVerifiedForUser(user.id),
      videoCallSettingsService.getAcceptVideoCalls(user.id),
      agencyLookupId
        ? prismaRead.agency.findUnique({
            where: { userId: agencyLookupId },
            select: { defaultPublicId: true },
          })
        : Promise.resolve(null),
    ])
    const level = levels.get(user.id)
    const agencyTag: SearchCardShared['agencyTag'] =
      user.isAgent && agencyRow
        ? {
            isAgent: true,
            isHost: false,
            agencyPublicId: agencyRow.defaultPublicId.toString(),
          }
        : user.currentAgencyId
          ? {
              isAgent: false,
              isHost: true,
              agencyPublicId: agencyRow?.defaultPublicId.toString(),
            }
          : { isAgent: false, isHost: false }

    const shared: SearchCardShared = {
      livestreamLevel: level?.livestreamLevel ?? 0,
      wealthLevel: level?.wealthLevel ?? 0,
      richTier,
      subscriberCount: subscriberCounts.get(user.id) ?? 0,
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      galleryCompletion,
      vipMembership,
      faceVerified,
      acceptVideoCalls,
      agencyTag,
    }
    void cacheRedisService.set(key, shared, env.REDIS_TTL_USER_SEARCH_CARD)
    return shared
  })
}

export type ResolvedPublicIdentity = {
  userId: string
  username: string
  name: string
  /** Base `users.public_id` (decimal string). */
  publicId: string
  /** Shown ID: rare/VIP overlay when set — same rule as `GET /users/me`. */
  displayPublicId: string
  isAgency: boolean
  avatarUrl: string | null
  isOnline: boolean
  lastActiveAt: string | null
  lastOnlineSeconds: number | null
  lastOnlineLabel: string | null
}

export const userSearchService = {
  /**
   * Resolve a user by **any** externally visible numeric id: `public_id`, `default_public_id`,
   * or `current_vip_public_id` (`userRepository.findByPublicId`).
   */
  async resolvePublicIdentity(
    publicId: string,
    viewerId?: string,
  ): Promise<ResolvedPublicIdentity | null> {
    const numericId = Number(publicId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
    }
    const user = await userRepository.findByPublicId(numericId)
    if (!user) return null

    const presence = viewerId
      ? await presenceService.getPublicPresenceForUser(viewerId, user.id)
      : {
          isOnline: false,
          lastActiveAt: null,
          lastOnlineSeconds: null,
          lastOnlineLabel: null,
        }

    return {
      userId: user.id,
      username: user.username ?? '',
      name: formatUserName(user),
      publicId: String(user.publicId),
      displayPublicId: String(user.currentVipPublicId ?? user.defaultPublicId ?? user.publicId),
      isAgency: Boolean(user.isAgent),
      avatarUrl: user.avatarUrl ?? null,
      isOnline: presence.isOnline,
      lastActiveAt: presence.lastActiveAt,
      lastOnlineSeconds: presence.lastOnlineSeconds,
      lastOnlineLabel: presence.lastOnlineLabel,
    }
  },

  async searchByPublicId(publicId: string, requesterId: string): Promise<UserCard | null> {
    const numericId = Number(publicId)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new AppError(400, 'Invalid public ID', 'INVALID_PUBLIC_ID')
    }
    const user = await userRepository.findByPublicId(numericId)
    if (!user) {
      return null
    }

    const [shared, isFollowing, isFollowedBy, blockedByMe, userBlockedMe] = await Promise.all([
      loadSearchCardShared(user),
      followRepository.existsFollow(requesterId, user.id),
      followRepository.existsFollow(user.id, requesterId),
      blockRepository.isBlocked(requesterId, user.id),
      blockRepository.isBlocked(user.id, requesterId),
    ])
    const isFriend = isFollowing && isFollowedBy

    const displayName = buildUserDisplayName(user)

    const displayPublicId = String(user.currentVipPublicId ?? user.defaultPublicId ?? user.publicId)

    const age =
      user.dateOfBirth != null
        ? (() => {
            const today = new Date()
            const dob = user.dateOfBirth as Date
            let years = today.getFullYear() - dob.getFullYear()
            const m = today.getMonth() - dob.getMonth()
            if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
              years--
            }
            return years >= 0 ? years : null
          })()
        : null

    return {
      id: user.id,
      userId: user.id,
      username: user.username,
      publicId: String(user.publicId),
      displayPublicId,
      isAgency: Boolean(user.isAgent),
      name: formatUserName(user),
      displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio ?? null,
      country: user.country ?? null,
      gender: user.gender,
      age,
      livestreamLevel: shared.livestreamLevel,
      wealthLevel: shared.wealthLevel,
      richTier: shared.richTier,
      subscriberCount: shared.subscriberCount,
      isFollowing,
      isFollowedBy,
      isFriend,
      blockedByMe,
      userBlockedMe,
      isSuperHost: shared.isSuperHost,
      activeGuardian: shared.activeGuardian,
      activeStoreItems: shared.activeStoreItems,
      galleryCompletion: shared.galleryCompletion,
      vipMembership: shared.vipMembership,
      faceVerified: shared.faceVerified,
      acceptVideoCalls: shared.acceptVideoCalls,
      agencyTag: shared.agencyTag,
      adminTags: composePublicAdminTags({
        stored: user.adminTags ?? [],
        isAgency: Boolean(user.isAgent),
        isFullGallery: shared.galleryCompletion.isFullGallery,
        vipMembership: shared.vipMembership,
        richTier: shared.richTier,
      }),
    }
  },
}

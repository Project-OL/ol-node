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

    const fullName =
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : (user.firstName ?? user.lastName)
    const displayName = fullName && fullName.trim().length > 0 ? fullName : user.username

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
      name: displayName,
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

    const levels = await walletLevelService.getDisplayLevelsForUsers([user.id])
    const level = levels.get(user.id)
    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators([user.id])
    const subscriberCount = subscriberCounts.get(user.id) ?? 0

    const [
      isFollowing,
      isFollowedBy,
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      galleryCompletion,
      blockedByMe,
      userBlockedMe,
      richTier,
      vipMembership,
      faceVerified,
    ] = await Promise.all([
      followRepository.existsFollow(requesterId, user.id),
      followRepository.existsFollow(user.id, requesterId),
      superHostService.isSuperHost(user.id),
      guardianService.getActiveGuardianSummary(user.id),
      storeService.getActiveItemsForUser(user.id),
      giftGalleryService.getCompletionSummaryForUser(user.id),
      blockRepository.isBlocked(requesterId, user.id),
      blockRepository.isBlocked(user.id, requesterId),
      richTierService.getRichTierCardFields(user.id),
      vipMembershipService.getActiveMembershipSummary(user.id),
      faceVerificationRepository.isVerifiedForUser(user.id),
    ])
    const isFriend = isFollowing && isFollowedBy

    let agencyTag: { isAgent: boolean; isHost: boolean; agencyPublicId?: string } | undefined
    const agentRow = await prismaRead.agency.findUnique({
      where: { userId: user.id },
      select: { defaultPublicId: true },
    })
    if (user.isAgent && agentRow) {
      agencyTag = {
        isAgent: true,
        isHost: false,
        agencyPublicId: agentRow.defaultPublicId.toString(),
      }
    } else if (user.currentAgencyId) {
      const ag = await prismaRead.agency.findUnique({
        where: { userId: user.currentAgencyId },
        select: { defaultPublicId: true },
      })
      agencyTag = {
        isAgent: false,
        isHost: true,
        agencyPublicId: ag?.defaultPublicId.toString(),
      }
    } else {
      agencyTag = { isAgent: false, isHost: false }
    }

    const fullName =
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : (user.firstName ?? user.lastName)
    const displayName = fullName && fullName.trim().length > 0 ? fullName : user.username

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
      name: displayName,
      displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio ?? null,
      country: user.country ?? null,
      gender: user.gender,
      age,
      livestreamLevel: level?.livestreamLevel ?? 0,
      wealthLevel: level?.wealthLevel ?? 0,
      richTier,
      subscriberCount,
      isFollowing,
      isFollowedBy,
      isFriend,
      blockedByMe,
      userBlockedMe,
      isSuperHost,
      activeGuardian,
      activeStoreItems,
      galleryCompletion,
      vipMembership,
      faceVerified,
      agencyTag,
      adminTags: user.adminTags ?? [],
    }
  },
}

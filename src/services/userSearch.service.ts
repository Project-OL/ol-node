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

export const userSearchService = {
  async searchByPublicId(
    publicId: string,
    requesterId: string,
  ): Promise<UserCard | null> {
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
    const subscriberCounts = await userSubscriberRepository.countSubscribersForCreators([
      user.id,
    ])
    const subscriberCount = subscriberCounts.get(user.id) ?? 0

    const [isFollowing, isFollowedBy, isSuperHost, activeGuardian, galleryCompletion, blockedByMe] =
      await Promise.all([
        followRepository.existsFollow(requesterId, user.id),
        followRepository.existsFollow(user.id, requesterId),
        superHostService.isSuperHost(user.id),
        guardianService.getActiveGuardianSummary(user.id),
        giftGalleryService.getCompletionSummaryForUser(user.id),
        blockRepository.isBlocked(requesterId, user.id),
      ])
    const isFriend = isFollowing && isFollowedBy

    const fullName =
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.firstName ?? user.lastName
    const displayName =
      fullName && fullName.trim().length > 0 ? fullName : user.username

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
      name: displayName,
      displayName,
      avatarUrl: user.avatarUrl,
      country: user.country ?? null,
      gender: user.gender,
      age,
      livestreamLevel: level?.livestreamLevel ?? 0,
      wealthLevel: level?.wealthLevel ?? 0,
      subscriberCount,
      isFollowing,
      isFollowedBy,
      isFriend,
      blockedByMe,
      isSuperHost,
      activeGuardian,
      galleryCompletion,
    }
  },
}


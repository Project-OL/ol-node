import { vipMembershipService } from './vip-membership.service'
import {
  livestreamRewardService,
  type LivestreamRewardStatusDto,
} from './livestream-reward.service'
import { royalHostRewardService, type RoyalHostRewardStatusDto } from './royal-host-reward.service'
import {
  normalHostRewardService,
  type NormalHostRewardStatusDto,
} from './normal-host-reward.service'

export type VipRewardDto = {
  type: 'VIP_DAILY'
  title: string
  coinAmount: string
  eligible: boolean
  claimedToday: boolean
}

export type RewardsListDto = {
  vipReward: VipRewardDto
  livestreamReward: LivestreamRewardStatusDto & { type: 'LIVESTREAM_STREAK' }
  royalHostReward: RoyalHostRewardStatusDto & { type: 'ROYAL_HOST_WEEKLY' }
  normalHostReward: NormalHostRewardStatusDto & { type: 'NORMAL_HOST_DAILY' }
}

export const rewardService = {
  async listRewards(userId: string): Promise<RewardsListDto> {
    const [membership, config, livestreamReward, royalHostReward, normalHostReward] =
      await Promise.all([
        vipMembershipService.getMembership(userId),
        vipMembershipService.getPublicConfig(),
        livestreamRewardService.getStatus(userId),
        royalHostRewardService.getStatus(userId),
        normalHostRewardService.getStatus(userId),
      ])

    return {
      vipReward: {
        type: 'VIP_DAILY',
        title: 'VIP Daily Reward',
        coinAmount: config.dailyGrantCoins,
        eligible: membership.isActive,
        claimedToday: membership.isActive && !membership.dailyClaimAvailable,
      },
      livestreamReward: { type: 'LIVESTREAM_STREAK', ...livestreamReward },
      royalHostReward: { type: 'ROYAL_HOST_WEEKLY', ...royalHostReward },
      normalHostReward: { type: 'NORMAL_HOST_DAILY', ...normalHostReward },
    }
  },
}

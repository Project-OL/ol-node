import { vipMembershipService } from './vip-membership.service'
import {
  livestreamRewardService,
  type LivestreamRewardStatusDto,
} from './livestream-reward.service'
import { royalHostRewardService, type RoyalHostRewardStatusDto } from './royal-host-reward.service'

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
}

export const rewardService = {
  async listRewards(userId: string): Promise<RewardsListDto> {
    const [membership, config, livestreamReward, royalHostReward] = await Promise.all([
      vipMembershipService.getMembership(userId),
      vipMembershipService.getPublicConfig(),
      livestreamRewardService.getStatus(userId),
      royalHostRewardService.getStatus(userId),
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
    }
  },
}

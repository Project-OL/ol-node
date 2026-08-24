import { vipMembershipService } from './vip-membership.service'
import {
  livestreamRewardService,
  type LivestreamRewardStatusDto,
} from './livestream-reward.service'

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
}

export const rewardService = {
  async listRewards(userId: string): Promise<RewardsListDto> {
    const [membership, config, livestreamReward] = await Promise.all([
      vipMembershipService.getMembership(userId),
      vipMembershipService.getPublicConfig(),
      livestreamRewardService.getStatus(userId),
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
    }
  },
}

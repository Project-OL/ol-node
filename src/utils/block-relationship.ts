import type { Prisma } from '@prisma/client'
import { blockRepository } from '../repositories/block.repository'
import { AppError } from '../middlewares/errorHandler'

/** True when either user has blocked the other. */
export async function isBlockedEitherWay(userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return false
  const [aBlockedB, bBlockedA] = await Promise.all([
    blockRepository.isBlocked(userA, userB),
    blockRepository.isBlocked(userB, userA),
  ])
  return aBlockedB || bBlockedA
}

/** Throws USER_BLOCKED / YOU_ARE_BLOCKED — same codes as messaging. */
export async function assertNotBlockedEitherWay(userA: string, userB: string): Promise<void> {
  if (userA === userB) return
  if (await blockRepository.isBlocked(userB, userA)) {
    throw new AppError(403, 'User has blocked you', 'USER_BLOCKED')
  }
  if (await blockRepository.isBlocked(userA, userB)) {
    throw new AppError(403, 'You have blocked this user', 'YOU_ARE_BLOCKED')
  }
}

/** Prisma User filter: hide users with any block relationship with viewerId. */
export function userNotBlockedWithFilter(viewerId: string): Prisma.UserWhereInput {
  return {
    NOT: {
      OR: [
        { blockedBy: { some: { blockerId: viewerId } } },
        { blockedUsers: { some: { blockedId: viewerId } } },
      ],
    },
  }
}

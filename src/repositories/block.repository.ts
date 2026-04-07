import type { BlockList } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type BlockWithUser = BlockList & {
  blocked: {
    id: string
    username: string
    defaultPublicId: string
    avatarUrl: string | null
  }
}

export async function blockUser(
  blockerId: string,
  blockedId: string,
): Promise<BlockList> {
  return prisma.blockList.create({
    data: { blockerId, blockedId },
  })
}

export async function unblockUser(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await prisma.blockList.deleteMany({
    where: { blockerId, blockedId },
  })
}

export async function bulkUnblock(
  blockerId: string,
  blockedIds: string[],
): Promise<{ count: number }> {
  const result = await prisma.blockList.deleteMany({
    where: { blockerId, blockedId: { in: blockedIds } },
  })
  return { count: result.count }
}

export async function isBlocked(
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const r = await prismaRead.blockList.findUnique({
    where: {
      blockerId_blockedId: { blockerId, blockedId },
    },
  })
  return r != null
}

export async function findBlock(
  blockerId: string,
  blockedId: string,
): Promise<BlockList | null> {
  return prismaRead.blockList.findUnique({
    where: {
      blockerId_blockedId: { blockerId, blockedId },
    },
  })
}

export async function getBlockList(
  blockerId: string,
  search?: string,
  cursor?: string,
  limit = 20,
): Promise<{ blocks: BlockWithUser[]; nextCursor: string | null }> {
  const searchNum = search && /^\d+$/.test(search) ? BigInt(search) : null
  const blocks = await prismaRead.blockList.findMany({
    where: {
      blockerId,
      ...(search
        ? {
            blocked: {
              OR: [
                { username: { contains: search, mode: 'insensitive' } },
                ...(searchNum !== null ? [{ defaultPublicId: searchNum }] : []),
              ],
            },
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: {
      blocked: {
        select: {
          id: true,
          username: true,
          defaultPublicId: true,
          avatarUrl: true,
        },
      },
    },
  })
  const hasMore = blocks.length > limit
  const page = hasMore ? blocks.slice(0, limit) : blocks
  const nextCursor = hasMore ? page[page.length - 1]?.id ?? null : null
  return {
    blocks: page.map((b) => ({
      ...b,
      blocked: {
        ...b.blocked,
        defaultPublicId: String(b.blocked.defaultPublicId),
      },
    })) as BlockWithUser[],
    nextCursor,
  }
}

export const blockRepository = {
  blockUser,
  unblockUser,
  bulkUnblock,
  isBlocked,
  findBlock,
  getBlockList,
}

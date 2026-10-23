import type { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

/**
 * F18: read a large user set page by page (id cursor) instead of one `findMany({ take: 50_000 })`,
 * which loaded everything at once and silently dropped every user past 50k.
 */
export async function* pagedUsers<S extends Prisma.UserSelect & { id: true }>(
  where: Prisma.UserWhereInput,
  select: S,
  pageSize = 5_000,
): AsyncGenerator<Prisma.UserGetPayload<{ select: S }>[]> {
  let cursor: string | undefined
  for (;;) {
    const page = (await prismaRead.user.findMany({
      where,
      select,
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })) as Prisma.UserGetPayload<{ select: S }>[]
    if (page.length === 0) return
    yield page
    if (page.length < pageSize) return
    cursor = (page[page.length - 1] as { id: string }).id
  }
}

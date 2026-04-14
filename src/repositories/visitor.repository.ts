import { prisma, prismaRead } from '../config/database'
import type { ProfileVisitor, User, UserLevel } from '@prisma/client'

export interface VisitorRow {
  visit: ProfileVisitor
  user: Pick<User, 'id' | 'publicId' | 'username' | 'firstName' | 'lastName' | 'avatarUrl' | 'country' | 'gender' | 'dateOfBirth'>
  level: UserLevel | null
}

export const visitorRepository = {
  async upsertVisitor(profileId: string, visitorId: string): Promise<{ isNew: boolean }> {
    const existing = await prismaRead.profileVisitor.findUnique({
      where: {
        profileId_visitorId: {
          profileId,
          visitorId,
        },
      },
    })
    if (!existing) {
      await prisma.profileVisitor.create({
        data: {
          profileId,
          visitorId,
        },
      })
      return { isNew: true }
    }

    await prisma.profileVisitor.update({
      where: {
        profileId_visitorId: {
          profileId,
          visitorId,
        },
      },
      data: {
        visitedAt: new Date(),
      },
    })
    return { isNew: false }
  },

  async trimVisitors(profileId: string): Promise<void> {
    const visitors = await prismaRead.profileVisitor.findMany({
      where: { profileId },
      orderBy: { visitedAt: 'desc' },
      skip: 50,
      take: 1,
    })
    if (visitors.length === 0) return
    const threshold = visitors[0]!.visitedAt
    await prisma.profileVisitor.deleteMany({
      where: {
        profileId,
        visitedAt: { lt: threshold },
      },
    })
  },

  async countVisitors(profileId: string): Promise<number> {
    return prismaRead.profileVisitor.count({ where: { profileId } })
  },

  async findVisitors(
    profileId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: VisitorRow[]; nextCursor: string | null; total: number }> {
    const where = { profileId }
    const rows = await prismaRead.profileVisitor.findMany({
      where,
      orderBy: { visitedAt: 'desc' },
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      take: limit,
      include: {
        visitor: {
          select: {
            id: true,
            publicId: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            country: true,
            gender: true,
            dateOfBirth: true,
            userLevel: true,
          },
        },
      },
    })

    const total = await prismaRead.profileVisitor.count({ where })

    const items: VisitorRow[] = rows.map((row) => ({
      visit: row,
      user: row.visitor,
      level: row.visitor.userLevel ?? null,
    }))
    const nextCursor = rows.length === limit ? rows[rows.length - 1]?.id ?? null : null
    return { items, nextCursor, total }
  },

  async findVisitHistory(
    visitorId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: VisitorRow[]; nextCursor: string | null; total: number }> {
    const where = { visitorId }
    const rows = await prismaRead.profileVisitor.findMany({
      where,
      orderBy: { visitedAt: 'desc' },
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      take: limit,
      include: {
        profile: {
          select: {
            id: true,
            publicId: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            country: true,
            gender: true,
            dateOfBirth: true,
            userLevel: true,
          },
        },
      },
    })

    const total = await prismaRead.profileVisitor.count({ where })

    const items: VisitorRow[] = rows.map((row) => ({
      visit: row,
      user: row.profile,
      level: row.profile.userLevel ?? null,
    }))
    const nextCursor = rows.length === limit ? rows[rows.length - 1]?.id ?? null : null
    return { items, nextCursor, total }
  },
}


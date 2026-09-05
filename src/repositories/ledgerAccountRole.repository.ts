import { LedgerAccountRoleType, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

const userSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
  isAgent: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect

export type LedgerAccountRoleRow = Prisma.LedgerAccountRoleGetPayload<{
  include: { user: { select: typeof userSelect } }
}>

export const ledgerAccountRoleRepository = {
  async listAll(includeInactive: boolean): Promise<LedgerAccountRoleRow[]> {
    return prismaRead.ledgerAccountRole.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: { user: { select: userSelect } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    })
  },

  /** Active role rows only — the hot path for house/customer bucketing. */
  async listActiveRoles(): Promise<{ userId: string; role: LedgerAccountRoleType }[]> {
    return prismaRead.ledgerAccountRole.findMany({
      where: { isActive: true },
      select: { userId: true, role: true },
    })
  },

  /** All roles held by a user (usually one; a TREASURY account can also be GAME_HOUSE). */
  async findAllByUserId(userId: string) {
    return prismaRead.ledgerAccountRole.findMany({ where: { userId } })
  },

  async findByUserIdAndRole(userId: string, role: LedgerAccountRoleType) {
    return prismaRead.ledgerAccountRole.findUnique({
      where: { userId_role: { userId, role } },
    })
  },

  /** Upserts one (user, role) row — does not touch any other role the same user holds. */
  async upsert(data: {
    userId: string
    role: LedgerAccountRoleType
    label?: string | null
    note?: string | null
    effectiveFrom?: Date
    createdByAdminId?: string | null
  }): Promise<LedgerAccountRoleRow> {
    return prisma.ledgerAccountRole.upsert({
      where: { userId_role: { userId: data.userId, role: data.role } },
      create: {
        userId: data.userId,
        role: data.role,
        label: data.label ?? null,
        note: data.note ?? null,
        isActive: true,
        ...(data.effectiveFrom ? { effectiveFrom: data.effectiveFrom } : {}),
        createdByAdminId: data.createdByAdminId ?? null,
      },
      update: {
        label: data.label ?? null,
        note: data.note ?? null,
        isActive: true,
        ...(data.effectiveFrom ? { effectiveFrom: data.effectiveFrom } : {}),
      },
      include: { user: { select: userSelect } },
    })
  },

  async deactivate(userId: string, role: LedgerAccountRoleType): Promise<void> {
    await prisma.ledgerAccountRole.update({
      where: { userId_role: { userId, role } },
      data: { isActive: false },
    })
  },
}

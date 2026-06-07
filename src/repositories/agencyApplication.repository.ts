import type { AgencyApplicationStatus, Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

export const agencyApplicationRepository = {
  /** @deprecated Instant join uses {@link createAcceptedApplication}. Retained for scripts / legacy tooling. */
  async createApplication(
    data: {
      agencyUserId: string
      hostUserId: string
      message?: string | null
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyHostApplication.create({
      data: {
        agencyUserId: data.agencyUserId,
        hostUserId: data.hostUserId,
        status: 'PENDING',
        message: data.message ?? undefined,
      },
    })
  },

  /** Audit row for instant join (`resolved_by` null = system auto-accept). */
  async createAcceptedApplication(
    data: {
      agencyUserId: string
      hostUserId: string
      message?: string | null
      resolvedAt: Date
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyHostApplication.create({
      data: {
        agencyUserId: data.agencyUserId,
        hostUserId: data.hostUserId,
        status: 'ACCEPTED',
        message: data.message ?? undefined,
        resolvedAt: data.resolvedAt,
        resolvedByUserId: null,
      },
    })
  },

  async getApplicationById(id: string) {
    return prismaRead.agencyHostApplication.findUnique({
      where: { id },
    })
  },

  async getPendingForHost(hostUserId: string) {
    return prismaRead.agencyHostApplication.findFirst({
      where: { hostUserId, status: 'PENDING' },
    })
  },

  /** @deprecated Agent join inbox removed — instant auto-join. */
  async listInbox(
    agencyUserId: string,
    params: {
      status?: AgencyApplicationStatus
      limit: number
      cursor?: string | null
    },
  ) {
    let cursor: { createdAt: Date; id: string } | null = null
    if (params.cursor) {
      const parts = params.cursor.split('|')
      if (parts.length === 2 && parts[0] && parts[1]) {
        cursor = { createdAt: new Date(parts[0]), id: parts[1] }
      }
    }

    const where: Prisma.AgencyHostApplicationWhereInput = {
      agencyUserId,
      ...(params.status ? { status: params.status } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              {
                createdAt: cursor.createdAt,
                id: { lt: cursor.id },
              },
            ],
          }
        : {}),
    }

    return prismaRead.agencyHostApplication.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.limit + 1,
    })
  },

  /** @deprecated Agent accept/reject removed — instant auto-join. */
  async updateStatus(
    params: {
      id: string
      status: AgencyApplicationStatus
      resolvedByUserId?: string | null
      resolvedAt?: Date | null
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agencyHostApplication.update({
      where: { id: params.id },
      data: {
        status: params.status,
        resolvedAt: params.resolvedAt ?? new Date(),
        resolvedByUserId: params.resolvedByUserId ?? undefined,
      },
    })
  },

  async deletePending(id: string, hostUserId: string, tx: Prisma.TransactionClient) {
    return tx.agencyHostApplication.deleteMany({
      where: { id, hostUserId, status: 'PENDING' },
    })
  },
}

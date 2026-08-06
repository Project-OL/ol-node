import type { AgencyAgentApplicationStatus, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export const agencyAgentApplicationRepository = {
  async findByUserId(userId: string) {
    return prismaRead.agencyAgentApplication.findUnique({
      where: { userId },
    })
  },

  async findById(id: string) {
    return prismaRead.agencyAgentApplication.findUnique({
      where: { id },
    })
  },

  async create(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.agencyAgentApplication.create({
      data: { userId },
    })
  },

  async updateStatus(
    id: string,
    data: {
      status: AgencyAgentApplicationStatus
      reviewedBy: string
      reviewedAt?: Date
      userNote?: string | null
      adminNote?: string | null
    },
  ) {
    const patch: Prisma.AgencyAgentApplicationUpdateInput = {
      status: data.status,
      reviewedBy: data.reviewedBy,
      reviewedAt: data.reviewedAt ?? new Date(),
    }
    if (data.userNote !== undefined) patch.userNote = data.userNote
    if (data.adminNote !== undefined) patch.adminNote = data.adminNote
    return prisma.agencyAgentApplication.update({
      where: { id },
      data: patch,
    })
  },

  async listByStatus(statuses?: AgencyAgentApplicationStatus[], skip = 0, take = 20) {
    const where: Prisma.AgencyAgentApplicationWhereInput = statuses?.length
      ? { status: { in: statuses } }
      : {}
    return prismaRead.agencyAgentApplication.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip,
      take,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            country: true,
            faceProfile: { select: { status: true, s3KeyReference: true } },
            avatarUrl: true,
          },
        },
        kyc: true,
      },
    })
  },

  async count(statuses?: AgencyAgentApplicationStatus[]) {
    const where: Prisma.AgencyAgentApplicationWhereInput = statuses?.length
      ? { status: { in: statuses } }
      : {}
    return prismaRead.agencyAgentApplication.count({ where })
  },
}

import type { MessageReport, ReportStatus, ReportContext, ReportReason, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import type { CreateReportInput } from '../models/messaging.schemas'

const reportUserSelect = {
  id: true,
  publicId: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
} as const

export async function createReport(
  data: CreateReportInput & { reporterId: string },
): Promise<MessageReport> {
  return prisma.messageReport.create({
    data: {
      reporterId: data.reporterId,
      reportedUserId: data.reportedUserId,
      conversationId: data.conversationId,
      messageId: data.messageId,
      reason: data.reason,
      additionalInfo: data.additionalInfo,
      evidenceS3Keys: data.evidenceS3Keys ?? [],
      context: data.context ?? 'CHAT',
      liveSessionId: data.liveSessionId,
      hostUserId: data.hostUserId,
    },
  })
}

export async function findRecentReport(
  reporterId: string,
  reportedUserId: string,
  withinHours: number,
): Promise<MessageReport | null> {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000)
  return prisma.messageReport.findFirst({
    where: {
      reporterId,
      reportedUserId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  })
}

async function findById(reportId: string) {
  return prismaRead.messageReport.findUnique({
    where: { id: reportId },
    include: {
      reporter: { select: reportUserSelect },
      reportedUser: { select: reportUserSelect },
      hostUser: { select: reportUserSelect },
      reviewedByAdmin: { select: { id: true, displayName: true, username: true } },
    },
  })
}

async function findManyForAdmin(filter: {
  status?: ReportStatus
  context?: ReportContext
  reason?: ReportReason
  reportedUserId?: string
  hostUserId?: string
  reporterId?: string
  skip: number
  take: number
}) {
  const where: Prisma.MessageReportWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.context ? { context: filter.context } : {}),
    ...(filter.reason ? { reason: filter.reason } : {}),
    ...(filter.reportedUserId ? { reportedUserId: filter.reportedUserId } : {}),
    ...(filter.hostUserId ? { hostUserId: filter.hostUserId } : {}),
    ...(filter.reporterId ? { reporterId: filter.reporterId } : {}),
  }
  const [reports, total] = await Promise.all([
    prismaRead.messageReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filter.skip,
      take: filter.take,
      include: {
        reporter: { select: reportUserSelect },
        reportedUser: { select: reportUserSelect },
        hostUser: { select: reportUserSelect },
      },
    }),
    prismaRead.messageReport.count({ where }),
  ])
  return { reports, total }
}

async function updateStatus(
  reportId: string,
  data: {
    status: ReportStatus
    reviewedByAdminId: string
    resolutionNote?: string
    escalatedTicketId?: bigint
  },
) {
  return prisma.messageReport.update({
    where: { id: reportId },
    data: { ...data, reviewedAt: new Date() },
  })
}

export const reportRepository = {
  createReport,
  findRecentReport,
  findById,
  findManyForAdmin,
  updateStatus,
}

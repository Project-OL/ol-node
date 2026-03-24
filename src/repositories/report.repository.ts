import type { MessageReport } from '@prisma/client'
import { prisma } from '../config/database'
import type { CreateReportInput } from '../models/messaging.schemas'

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

export const reportRepository = {
  createReport,
  findRecentReport,
}

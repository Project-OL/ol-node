import { reportRepository } from '../repositories/report.repository'
import { auditService } from './audit.service'
import { AppError } from '../middlewares/errorHandler'
import type { CreateReportInput } from '../models/messaging.schemas'
import type { MessageReport } from '@prisma/client'

export const reportService = {
  async createReport(reporterId: string, input: CreateReportInput): Promise<MessageReport> {
    if (reporterId === input.reportedUserId) {
      throw new AppError(400, 'Cannot report yourself', 'INVALID_REQUEST')
    }
    const recent = await reportRepository.findRecentReport(reporterId, input.reportedUserId, 24)
    if (recent) {
      throw new AppError(409, 'You have already reported this user recently', 'ALREADY_REPORTED')
    }
    const report = await reportRepository.createReport({ ...input, reporterId })
    await auditService.log({
      actionType: 'REPORT_USER',
      actionStatus: 'success',
      userId: reporterId,
      actionDetails: {
        reportedUserId: input.reportedUserId,
        reason: input.reason,
      },
    })
    return report
  },
}

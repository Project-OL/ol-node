import { reportRepository } from '../repositories/report.repository'
import { liveSessionRepository } from '../repositories/liveSession.repository'
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

    // Soft check only: the client-supplied live reference is informational for
    // CSA review — an unknown session must not block an abuse report.
    if (input.context === 'LIVE' && input.liveSessionId) {
      const session = await liveSessionRepository
        .findByIdOrRoomId(input.liveSessionId)
        .catch(() => null)
      if (!session) {
        console.warn('[report] LIVE report references unknown live session', {
          reporterId,
          liveSessionId: input.liveSessionId,
        })
      }
    }

    const report = await reportRepository.createReport({ ...input, reporterId })
    await auditService.log({
      actionType: 'REPORT_USER',
      actionStatus: 'success',
      userId: reporterId,
      actionDetails: {
        reportedUserId: input.reportedUserId,
        reason: input.reason,
        context: input.context ?? 'CHAT',
        ...(input.liveSessionId ? { liveSessionId: input.liveSessionId } : {}),
      },
    })
    return report
  },
}

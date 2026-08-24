import { reportRepository } from '../repositories/report.repository'
import { supportRepository } from '../repositories/support.repository'
import { supportAssignmentService } from './supportAssignment.service'
import { storageService } from './storage.service'
import { AppError } from '../middlewares/errorHandler'
import type { ReportStatus } from '@prisma/client'
import type { AdminReportListQuery } from '../models/support-admin.schemas'
import { formatUserName } from '../utils/user-display'
import type { AdminAuditRequestMeta } from '../utils/admin-audit'
import { auditService } from './audit.service'

interface AdminActor {
  id: string
  role: string
  request?: AdminAuditRequestMeta
}

function withName<
  T extends { firstName?: string | null; lastName?: string | null } | null | undefined,
>(u: T): T extends null | undefined ? T : T & { name: string } {
  if (u == null) return u as any
  return { ...u, name: formatUserName(u) } as any
}

function withEvidenceUrls<T extends { evidenceS3Keys: string[] }>(report: T) {
  return {
    ...report,
    evidenceUrls: report.evidenceS3Keys.map((key) => storageService.getCdnOrS3PublicUrl(key)),
  }
}

function mapReportUsers<
  T extends {
    evidenceS3Keys: string[]
    reporter?: { firstName?: string | null; lastName?: string | null } | null
    reportedUser?: { firstName?: string | null; lastName?: string | null } | null
    hostUser?: { firstName?: string | null; lastName?: string | null } | null
  },
>(report: T) {
  const withUrls = withEvidenceUrls(report)
  return {
    ...withUrls,
    reporter: withName(report.reporter),
    reportedUser: withName(report.reportedUser),
    hostUser: withName(report.hostUser),
  }
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, jsonValue) =>
      typeof jsonValue === 'bigint' ? jsonValue.toString() : jsonValue,
    ),
  ) as T
}

export const reportAdminService = {
  async listReports(query: AdminReportListQuery) {
    const skip = (query.page - 1) * query.limit
    const { reports, total } = await reportRepository.findManyForAdmin({
      status: query.status,
      context: query.context,
      reason: query.reason,
      reportedUserId: query.reportedUserId,
      hostUserId: query.hostUserId,
      reporterId: query.reporterId,
      skip,
      take: query.limit,
    })
    return toJsonSafe({
      reports: reports.map(mapReportUsers),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + reports.length < total,
      },
    })
  },

  async getReport(reportId: string) {
    const report = await reportRepository.findById(reportId)
    if (!report) throw new AppError(404, 'Report not found', 'REPORT_NOT_FOUND')
    return toJsonSafe(mapReportUsers(report))
  },

  /** First (and only) writer of ReportStatus beyond the PENDING default. */
  async reviewReport(
    actor: AdminActor,
    reportId: string,
    input: {
      status: Extract<ReportStatus, 'REVIEWED' | 'RESOLVED' | 'DISMISSED'>
      resolutionNote?: string
    },
  ) {
    const report = await reportRepository.findById(reportId)
    if (!report) throw new AppError(404, 'Report not found', 'REPORT_NOT_FOUND')
    if (report.status === 'RESOLVED' || report.status === 'DISMISSED') {
      throw new AppError(409, 'Report has already been finalized', 'REPORT_ALREADY_FINALIZED')
    }

    const updated = await reportRepository.updateStatus(reportId, {
      status: input.status,
      reviewedByAdminId: actor.id,
      resolutionNote: input.resolutionNote,
    })

    auditService.logAdmin({
      adminUserId: actor.id,
      targetUserId: report.reportedUserId,
      actionType: 'ADMIN_SUPPORT_REPORT_REVIEW',
      actionStatus: 'success',
      actionDetails: {
        reportId,
        status: input.status,
        reporterId: report.reporterId,
        reportedUserId: report.reportedUserId,
      },
      destination: `User report ${reportId}`,
      request: actor.request,
    })

    return toJsonSafe(mapReportUsers(updated))
  },

  /**
   * Escalate a user report into a support ticket (on behalf of the reporter)
   * so it enters the assigned CSA workflow. One escalation per report.
   */
  async escalateToTicket(actor: AdminActor, reportId: string) {
    const report = await reportRepository.findById(reportId)
    if (!report) throw new AppError(404, 'Report not found', 'REPORT_NOT_FOUND')
    if (report.escalatedTicketId) {
      throw new AppError(409, 'Report has already been escalated', 'REPORT_ALREADY_ESCALATED')
    }

    const descriptionParts = [
      `Escalated user report ${report.id} (${report.context}).`,
      `Reported user: ${report.reportedUser?.username ?? report.reportedUserId}.`,
      `Reason: ${report.reason}.`,
      report.additionalInfo ? `Details: ${report.additionalInfo}` : null,
      report.liveSessionId ? `Live session: ${report.liveSessionId}` : null,
      report.conversationId ? `Conversation: ${report.conversationId}` : null,
    ].filter(Boolean)

    const ticket = await supportRepository.createTicket({
      userId: report.reporterId,
      type: 'REPORT_COMPLAINTS',
      subType: 'USER_REPORT_ESCALATION',
      description: descriptionParts.join(' '),
      imageUrl: report.evidenceS3Keys[0]
        ? storageService.getCdnOrS3PublicUrl(report.evidenceS3Keys[0])
        : undefined,
    })
    await supportRepository.updateTicketStatus(ticket.id, 'OPEN')

    const updated = await reportRepository.updateStatus(reportId, {
      status: 'REVIEWED',
      reviewedByAdminId: actor.id,
      escalatedTicketId: ticket.id,
    })

    try {
      await supportAssignmentService.assignTicket(ticket.id)
    } catch (err) {
      console.warn('[report-admin] escalated ticket auto-assignment failed', {
        ticketId: ticket.id.toString(),
        err,
      })
    }

    auditService.logAdmin({
      adminUserId: actor.id,
      targetUserId: report.reporterId,
      actionType: 'ADMIN_SUPPORT_REPORT_ESCALATE',
      actionStatus: 'success',
      actionDetails: {
        reportId,
        ticketId: ticket.id.toString(),
        ticketPublicId: String(ticket.publicId),
        reporterId: report.reporterId,
        reportedUserId: report.reportedUserId,
      },
      destination: `User report ${reportId} → ticket ${ticket.publicId}`,
      request: actor.request,
    })

    return toJsonSafe({
      report: mapReportUsers(updated),
      ticket: { id: ticket.id.toString(), publicId: ticket.publicId },
    })
  },
}

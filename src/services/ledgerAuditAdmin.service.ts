import { AppError } from '../middlewares/errorHandler'
import { ledgerAuditRepository } from '../repositories/ledgerAudit.repository'
import { ledgerAuditService } from './ledgerAudit.service'
import type { LedgerAuditCategory, LedgerAuditSeverity, LedgerAuditStatus, Prisma } from '@prisma/client'
import { enqueueLedgerAuditRun } from '../queues/ledger-audit.queue'

export const ledgerAuditAdminService = {
  async listFlags(query: {
    page: number
    limit: number
    status?: LedgerAuditStatus
    category?: LedgerAuditCategory
    code?: string
    severity?: LedgerAuditSeverity
    from?: Date
    to?: Date
    q?: string
    qType: 'auto' | 'userId' | 'publicId' | 'displayId'
  }) {
    const where: Prisma.LedgerAuditFlagWhereInput = {}
    if (query.status) where.status = query.status
    else where.status = 'OPEN'
    if (query.category) where.category = query.category
    if (query.code) where.code = query.code
    if (query.severity) where.severity = query.severity
    if (query.from || query.to) {
      where.createdAt = {}
      if (query.from) where.createdAt.gte = query.from
      if (query.to) where.createdAt.lte = query.to
    }

    if (query.q?.trim()) {
      const userIds = await ledgerAuditRepository.resolveUserIdsByQuery({
        q: query.q,
        qType: query.qType,
      })
      if (userIds.length === 0) {
        return {
          page: query.page,
          limit: query.limit,
          total: 0,
          items: [] as ReturnType<typeof ledgerAuditService.serializeFlag>[],
        }
      }
      where.userId = { in: userIds }
    }

    const skip = (query.page - 1) * query.limit
    const { items, total } = await ledgerAuditRepository.listFlags({
      where,
      skip,
      take: query.limit,
    })

    return {
      page: query.page,
      limit: query.limit,
      total,
      items: items.map((f) => ledgerAuditService.serializeFlag(f)),
    }
  },

  async patchFlag(args: {
    id: string
    status: 'ACKNOWLEDGED' | 'DISMISSED' | 'OPEN'
    note?: string | null
    adminUserId: string
  }) {
    const existing = await ledgerAuditRepository.findFlagById(args.id)
    if (!existing) throw new AppError(404, 'Audit flag not found', 'LEDGER_AUDIT_FLAG_NOT_FOUND')

    const updated = await ledgerAuditRepository.updateFlagStatus({
      id: args.id,
      status: args.status,
      resolvedByAdminId: args.adminUserId,
      resolutionNote: args.note,
    })
    return ledgerAuditService.serializeFlag(updated)
  },

  async enqueueManualRun(adminUserId: string) {
    const jobId = await enqueueLedgerAuditRun({ triggeredByAdminId: adminUserId })
    return { ok: true as const, queued: true as const, jobId }
  },
}

import { redisClient, RedisKeys } from '../config/redis'
import { supportRepository } from '../repositories/support.repository'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { supportReplyTemplateRepository } from '../repositories/supportReplyTemplate.repository'
import { storageService } from './storage.service'
import { csaNotificationService } from './csaNotification.service'
import {
  notifySupportTicketMessage,
  notifySupportTicketStatusChanged,
} from './supportRealtime.service'
import { enqueueSupportTicketAutoclose } from '../queues/support-autoclose.queue'
import { AppError } from '../middlewares/errorHandler'
import type {
  SupportTicketStatus,
  SupportTicketType,
  SupportTicketPriority,
  SupportTicketResolution,
} from '@prisma/client'
import type { z } from 'zod'
import type {
  AdminTicketListQuery,
  AdminReplySchema,
  AdminTicketMessagesQuerySchema,
  AdminUploadUrlSchema,
} from '../models/support-admin.schemas'
import {
  buildTicketInitialSubmission,
  resolveSupportTypeLabels,
} from '../config/support-types.config'
import {
  formatSupportReviewWindowLabel,
  supportConfigService,
  supportContestEndsAt,
} from './supportConfig.service'
import { formatUserName } from '../utils/user-display'
import type { AdminAuditRequestMeta } from '../utils/admin-audit'
import { auditService } from './audit.service'

const PRESIGN_TTL_SEC = 600

interface AdminActor {
  id: string
  role: string
  request?: AdminAuditRequestMeta
}

function logTicketActivity(
  actor: AdminActor,
  ticket: { id: bigint; publicId: string; userId: string },
  actionType: string,
  extra?: Record<string, unknown>,
) {
  const ticketId = ticket.id.toString()
  const ticketPublicId = String(ticket.publicId)
  auditService.logAdmin({
    adminUserId: actor.id,
    targetUserId: ticket.userId,
    actionType,
    actionStatus: 'success',
    actionDetails: { ticketId, ticketPublicId, ...extra },
    destination: `Support ticket ${ticketPublicId}`,
    request: actor.request,
  })
}

/**
 * Externally-meaningful 4-stage lifecycle derived from status + assignment.
 * AWAITING_REPLY stays a live DB status ("user's turn ended, CS action
 * needed") but renders as assigned/open depending on ownership.
 */
export function deriveStage(ticket: {
  status: SupportTicketStatus
  assignedAdminId: string | null
}): 'open' | 'assigned' | 'pending_review' | 'closed' {
  if (ticket.status === 'CLOSED') return 'closed'
  if (ticket.status === 'PENDING_REVIEW') return 'pending_review'
  if (ticket.assignedAdminId) return 'assigned'
  return 'open'
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, jsonValue) =>
      typeof jsonValue === 'bigint' ? jsonValue.toString() : jsonValue,
    ),
  ) as T
}

function withName<
  T extends { firstName?: string | null; lastName?: string | null } | null | undefined,
>(u: T): T extends null | undefined ? T : T & { name: string } {
  if (u == null) return u as any
  return { ...u, name: formatUserName(u) } as any
}

async function invalidateUserCaches(userId: string, ticketId: bigint): Promise<void> {
  await Promise.all([
    redisClient.del(RedisKeys.supportTicketList(userId)),
    redisClient.del(RedisKeys.supportTicketDetail(ticketId)),
  ])
}

function isSuperAdmin(actor: AdminActor): boolean {
  return actor.role === 'SUPER_ADMIN'
}

async function findTicketOrThrow(ticketId: bigint) {
  const ticket = await supportRepository.findTicketByIdForAdmin(ticketId)
  if (!ticket) throw new AppError(404, 'Ticket not found', 'TICKET_NOT_FOUND')
  return ticket
}

/** Assignee may act; SUPER_ADMIN may act on any ticket. */
function assertCanAct(actor: AdminActor, ticket: { assignedAdminId: string | null }) {
  if (isSuperAdmin(actor)) return
  if (ticket.assignedAdminId !== actor.id) {
    throw new AppError(403, 'Ticket is not assigned to you', 'TICKET_NOT_ASSIGNED_TO_YOU')
  }
}

type AdminTicketEnrichInput = {
  type: SupportTicketType
  subType: string
  description: string
  imageUrl?: string | null
  refType?: string | null
  refId?: string | null
  createdAt: Date
  status: SupportTicketStatus
  assignedAdminId: string | null
  resolvedAt?: Date | null
  user?: { firstName?: string | null; lastName?: string | null } | null
}

export async function enrichAdminTicket<T extends AdminTicketEnrichInput>(ticket: T) {
  const { user, ...rest } = ticket
  const { typeLabel, subTypeLabel } = resolveSupportTypeLabels(ticket.type, ticket.subType)
  const pendingReviewUntil =
    ticket.status === 'PENDING_REVIEW'
      ? await supportContestEndsAt(ticket.resolvedAt ?? null)
      : null
  const daysSinceReviewed =
    ticket.resolvedAt != null
      ? Math.floor((Date.now() - ticket.resolvedAt.getTime()) / 86_400_000)
      : null
  return {
    ...rest,
    ...(user !== undefined ? { user: withName(user) } : {}),
    stage: deriveStage(ticket),
    typeLabel,
    subTypeLabel,
    initialSubmission: buildTicketInitialSubmission(ticket),
    ...(pendingReviewUntil ? { pendingReviewUntil } : {}),
    ...(daysSinceReviewed != null ? { daysSinceReviewed } : {}),
  }
}

async function ticketDto<T extends AdminTicketEnrichInput>(ticket: T) {
  return enrichAdminTicket(ticket)
}

export const supportAdminService = {
  async listTickets(actor: AdminActor, query: AdminTicketListQuery) {
    const scope = query.assignedTo ?? (isSuperAdmin(actor) ? 'all' : 'me')

    let assignedAdminId: string | undefined
    let unassigned = false
    if (scope === 'me') {
      assignedAdminId = actor.id
    } else if (scope === 'unassigned') {
      unassigned = true
    } else if (scope !== 'all') {
      if (!isSuperAdmin(actor)) {
        throw new AppError(403, 'Only SUPER_ADMIN can view other admins’ queues', 'ADMIN_FORBIDDEN')
      }
      assignedAdminId = scope
    } else if (!isSuperAdmin(actor)) {
      throw new AppError(403, 'Only SUPER_ADMIN can view the global queue', 'ADMIN_FORBIDDEN')
    }

    const skip = (query.page - 1) * query.limit
    const { tickets, total } = await supportRepository.findAdminTickets({
      status: query.status as SupportTicketStatus | undefined,
      priority: query.priority as SupportTicketPriority | undefined,
      type: query.type as SupportTicketType | undefined,
      assignedAdminId,
      unassigned,
      minDaysSinceReviewed: query.minDaysSinceReviewed,
      maxDaysSinceReviewed: query.maxDaysSinceReviewed,
      skip,
      take: query.limit,
    })

    return toJsonSafe({
      tickets: await Promise.all(tickets.map((t) => ticketDto(t))),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        hasMore: skip + tickets.length < total,
      },
    })
  },

  async getTicketDetail(
    _actor: AdminActor,
    ticketId: bigint,
    messageQuery: z.infer<typeof AdminTicketMessagesQuerySchema>,
  ) {
    const ticket = await findTicketOrThrow(ticketId)

    const [messages, notes] = await Promise.all([
      supportRepository.findMessages(ticketId, {
        cursor: messageQuery.cursor,
        take: messageQuery.limit,
      }),
      supportRepository.findNotes(ticketId),
    ])

    const latestMessage = messages[0]
    if (latestMessage) {
      await supportRepository.updateReadPointer(ticketId, 'SUPPORT', latestMessage.id)
    }

    return toJsonSafe({
      ticket: await ticketDto(ticket),
      messages: [...messages].reverse().map((m) => ({
        ...m,
        sender: withName(m.sender),
      })),
      notes,
      hasMore: messages.length === messageQuery.limit,
      nextCursor:
        messages.length === messageQuery.limit ? String(messages[messages.length - 1]!.id) : null,
    })
  },

  async reply(actor: AdminActor, ticketId: bigint, input: z.infer<typeof AdminReplySchema>) {
    const ticket = await findTicketOrThrow(ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Ticket is closed and no longer accepts messages', 'TICKET_CLOSED')
    }
    assertCanAct(actor, ticket)

    const message = await supportRepository.createMessage({
      ticketId,
      senderType: 'SUPPORT',
      content: input.content,
      imageUrl: input.imageUrl,
    })

    await supportRepository.updateTicketStatus(ticketId, 'ASSIGNED', {
      ...(ticket.firstResponseAt ? {} : { firstResponseAt: new Date() }),
      // A SUPER_ADMIN replying to an unassigned ticket implicitly claims it.
      ...(ticket.assignedAdminId ? {} : { assignedAdminId: actor.id, assignedAt: new Date() }),
    })
    await supportRepository.updateReadPointer(ticketId, 'SUPPORT', message.id)
    await invalidateUserCaches(ticket.userId, ticketId)

    const assignedAdminId = ticket.assignedAdminId ?? actor.id
    void notifySupportTicketMessage({
      ticketId,
      ticketPublicId: ticket.publicId,
      ownerUserId: ticket.userId,
      assignedAdminId,
      message: {
        id: message.id,
        publicId: message.publicId,
        senderType: message.senderType,
        senderUserId: message.senderUserId,
        content: message.content,
        imageUrl: message.imageUrl,
        isAutoReply: message.isAutoReply,
        createdAt: message.createdAt,
      },
    }).catch((err) => {
      console.warn('[support-admin] realtime notify failed', { ticketId: ticketId.toString(), err })
    })

    logTicketActivity(actor, ticket, 'ADMIN_SUPPORT_TICKET_REPLY', {
      hasImage: Boolean(input.imageUrl),
    })

    return toJsonSafe({
      ...message,
      sender: withName(message.sender),
    })
  },

  async resolve(
    actor: AdminActor,
    ticketId: bigint,
    input: { resolution: SupportTicketResolution; note: string },
  ) {
    const ticket = await findTicketOrThrow(ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Ticket is already closed', 'TICKET_ALREADY_CLOSED')
    }
    if (ticket.status === 'PENDING_REVIEW') {
      throw new AppError(409, 'Ticket is already pending review', 'TICKET_ALREADY_PENDING_REVIEW')
    }
    assertCanAct(actor, ticket)

    const resolvedAt = new Date()
    const label = input.resolution === 'RESOLVED' ? 'resolved' : 'rejected'
    const windowMs = await supportConfigService.getReviewWindowMs()
    const windowLabel = formatSupportReviewWindowLabel(windowMs)
    const closingContent = `${input.note.trim()}\n\n(This ticket was marked ${label}. It will close automatically in ${windowLabel} unless you reply.)`

    const closingMessage = await supportRepository.createMessage({
      ticketId,
      senderType: 'SUPPORT',
      content: closingContent,
    })

    const updated = await supportRepository.updateTicketStatus(ticketId, 'PENDING_REVIEW', {
      resolution: input.resolution,
      resolvedAt,
      ...(ticket.firstResponseAt ? {} : { firstResponseAt: resolvedAt }),
      ...(ticket.assignedAdminId ? {} : { assignedAdminId: actor.id, assignedAt: resolvedAt }),
    })

    await invalidateUserCaches(ticket.userId, ticketId)

    void notifySupportTicketMessage({
      ticketId,
      ticketPublicId: ticket.publicId,
      ownerUserId: ticket.userId,
      assignedAdminId: ticket.assignedAdminId ?? actor.id,
      message: {
        id: closingMessage.id,
        publicId: closingMessage.publicId,
        senderType: closingMessage.senderType,
        senderUserId: closingMessage.senderUserId,
        content: closingMessage.content,
        imageUrl: closingMessage.imageUrl,
        isAutoReply: closingMessage.isAutoReply,
        createdAt: closingMessage.createdAt,
      },
    }).catch((err) => {
      console.warn('[support-admin] resolve realtime notify failed', {
        ticketId: ticketId.toString(),
        err,
      })
    })

    void notifySupportTicketStatusChanged({
      ticketId,
      ticketPublicId: ticket.publicId,
      status: 'PENDING_REVIEW',
      resolution: input.resolution,
      assignedAdminId: ticket.assignedAdminId ?? actor.id,
    }).catch((err) => {
      console.warn('[support-admin] status-changed notify failed', {
        ticketId: ticketId.toString(),
        err,
      })
    })

    try {
      await enqueueSupportTicketAutoclose(ticketId, resolvedAt)
    } catch (err) {
      console.warn('[support-admin] autoclose enqueue failed (ticket stays PENDING_REVIEW)', {
        ticketId: ticketId.toString(),
        err,
      })
    }

    logTicketActivity(
      actor,
      ticket,
      input.resolution === 'REJECTED'
        ? 'ADMIN_SUPPORT_TICKET_REJECT'
        : 'ADMIN_SUPPORT_TICKET_RESOLVE',
      { resolution: input.resolution },
    )

    return toJsonSafe(await ticketDto(updated))
  },

  /**
   * Applies a reply template's content as the resolve note to each ticket in
   * turn (same effect as `resolve`, incl. PENDING_REVIEW + autoclose). Ticket
   * failures (closed, not assigned to this actor, etc.) are collected instead
   * of aborting the whole batch.
   */
  async bulkResolveWithTemplate(
    actor: AdminActor,
    ticketIds: bigint[],
    templateId: string,
    resolution: SupportTicketResolution,
  ) {
    const template = await supportReplyTemplateRepository.findById(templateId)
    if (!template) {
      throw new AppError(404, 'Reply template not found', 'REPLY_TEMPLATE_NOT_FOUND')
    }

    const results: Array<{ ticketId: string; ok: boolean; error?: string }> = []
    for (const id of ticketIds) {
      try {
        await this.resolve(actor, id, { resolution, note: template.content })
        results.push({ ticketId: id.toString(), ok: true })
      } catch (err) {
        results.push({
          ticketId: id.toString(),
          ok: false,
          error: err instanceof AppError ? (err.code ?? err.message) : 'FAILED',
        })
      }
    }

    return {
      templateId,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    }
  },

  async forceClose(actor: AdminActor, ticketId: bigint) {
    const ticket = await findTicketOrThrow(ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Ticket is already closed', 'TICKET_ALREADY_CLOSED')
    }
    assertCanAct(actor, ticket)

    const now = new Date()
    // Keep an existing resolve/reject outcome; otherwise treat force-close as RESOLVED
    // so it counts in CSA resolvedTotal and remains attributable for star ratings.
    const resolution = ticket.resolution ?? 'RESOLVED'
    const resolvedAt = ticket.resolvedAt ?? now

    await supportRepository.createMessage({
      ticketId,
      senderType: 'SUPPORT',
      content: 'This ticket has been closed by support. Please rate your experience (1–5 stars).',
    })

    const updated = await supportRepository.updateTicketStatus(ticketId, 'CLOSED', {
      closedAt: now,
      resolution,
      resolvedAt,
      ...(ticket.firstResponseAt ? {} : { firstResponseAt: now }),
      ...(ticket.assignedAdminId ? {} : { assignedAdminId: actor.id, assignedAt: now }),
    })
    await invalidateUserCaches(ticket.userId, ticketId)

    void notifySupportTicketStatusChanged({
      ticketId,
      ticketPublicId: ticket.publicId,
      status: 'CLOSED',
      resolution,
      assignedAdminId: ticket.assignedAdminId ?? actor.id,
    }).catch((err) => {
      console.warn('[support-admin] status-changed notify failed (forceClose)', {
        ticketId: ticketId.toString(),
        err,
      })
    })

    logTicketActivity(actor, ticket, 'ADMIN_SUPPORT_TICKET_CLOSE', { resolution })

    return toJsonSafe(await ticketDto(updated))
  },

  async assign(actor: AdminActor, ticketId: bigint, targetAdminId: string) {
    const ticket = await findTicketOrThrow(ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Cannot assign a closed ticket', 'TICKET_CLOSED')
    }
    // Freeze ownership through the review window so the resolving CSA keeps
    // star-rating credit (and rated CLOSED tickets stay with that assignee).
    if (ticket.status === 'PENDING_REVIEW') {
      throw new AppError(
        409,
        'Cannot reassign a ticket pending user review',
        'TICKET_PENDING_REVIEW_FROZEN',
      )
    }
    if (ticket.rating != null) {
      throw new AppError(409, 'Cannot reassign a rated ticket', 'TICKET_RATED_FROZEN')
    }
    // SUPER_ADMIN may move any ticket; a CSA may only hand off their own.
    if (!isSuperAdmin(actor) && ticket.assignedAdminId !== actor.id) {
      throw new AppError(403, 'Ticket is not assigned to you', 'TICKET_NOT_ASSIGNED_TO_YOU')
    }

    const target = await systemAdminRepository.findById(targetAdminId)
    if (!target || target.role !== 'CUSTOMER_SUPPORT' || target.status !== 'ACTIVE') {
      throw new AppError(404, 'Target is not an active customer support user', 'CSA_NOT_FOUND')
    }
    if (target.id === ticket.assignedAdminId) {
      throw new AppError(409, 'Ticket is already assigned to this admin', 'ALREADY_ASSIGNED')
    }

    const wasUnassigned = !ticket.assignedAdminId
    const updated = await supportRepository.assignTicket(ticketId, target.id, {
      setStatusAssigned:
        wasUnassigned && (ticket.status === 'OPEN' || ticket.status === 'AWAITING_REPLY'),
    })

    await csaNotificationService.notify(
      target.id,
      wasUnassigned ? 'TICKET_ASSIGNED' : 'TICKET_REASSIGNED',
      `Ticket ${ticket.publicId} (${ticket.type}/${ticket.subType}) assigned to you`,
      { ticketId },
    )

    logTicketActivity(actor, ticket, 'ADMIN_SUPPORT_TICKET_ASSIGN', {
      assignedAdminId: target.id,
      reassigned: !wasUnassigned,
    })

    return toJsonSafe(await ticketDto(updated))
  },

  async claim(actor: AdminActor, ticketId: bigint) {
    const ticket = await findTicketOrThrow(ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Cannot claim a closed ticket', 'TICKET_CLOSED')
    }
    if (ticket.assignedAdminId) {
      throw new AppError(409, 'Ticket is already assigned', 'ALREADY_ASSIGNED')
    }

    const updated = await supportRepository.assignTicket(ticketId, actor.id, {
      setStatusAssigned: ticket.status === 'OPEN' || ticket.status === 'AWAITING_REPLY',
    })
    logTicketActivity(actor, ticket, 'ADMIN_SUPPORT_TICKET_CLAIM', { assignedAdminId: actor.id })
    return toJsonSafe(await ticketDto(updated))
  },

  async setPriority(actor: AdminActor, ticketId: bigint, priority: SupportTicketPriority) {
    const ticket = await findTicketOrThrow(ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Cannot reprioritize a closed ticket', 'TICKET_CLOSED')
    }
    assertCanAct(actor, ticket)

    const updated = await supportRepository.updateTicketStatus(ticketId, ticket.status, {
      priority,
    })
    logTicketActivity(actor, ticket, 'ADMIN_SUPPORT_TICKET_PRIORITY', { priority })
    return toJsonSafe(await ticketDto(updated))
  },

  async addNote(actor: AdminActor, ticketId: bigint, content: string) {
    const ticket = await findTicketOrThrow(ticketId)
    const note = await supportRepository.createNote({ ticketId, adminId: actor.id, content })
    logTicketActivity(actor, ticket, 'ADMIN_SUPPORT_TICKET_NOTE', {
      noteId: note.id.toString(),
    })
    return toJsonSafe(note)
  },

  async listNotes(_actor: AdminActor, ticketId: bigint) {
    await findTicketOrThrow(ticketId)
    const notes = await supportRepository.findNotes(ticketId)
    return toJsonSafe({ notes })
  },

  async getUploadUrl(actor: AdminActor, input: z.infer<typeof AdminUploadUrlSchema>) {
    const ticket = await findTicketOrThrow(input.ticketId)
    if (ticket.status === 'CLOSED') {
      throw new AppError(409, 'Cannot upload to a closed ticket', 'TICKET_CLOSED')
    }
    assertCanAct(actor, ticket)

    const safeFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const key = `support/messages/${input.ticketId}/${Date.now()}_${safeFileName}`
    const uploadUrl = await storageService.getPresignedPutUrl(key, input.mimeType, PRESIGN_TTL_SEC)
    const publicUrl = storageService.getCdnOrS3PublicUrl(key)
    return { uploadUrl, publicUrl, key }
  },

  async myStats(actor: AdminActor) {
    return supportRepository.csaPerformance(actor.id)
  },
}

import type { FastifyRequest } from 'fastify'

export type AdminAuditRequestMeta = {
  ip?: string
  headers?: Record<string, string | undefined>
}

export function adminAuditMetaFromRequest(req: FastifyRequest): AdminAuditRequestMeta {
  return {
    ip: req.ip,
    headers: req.headers as Record<string, string | undefined>,
  }
}

export type AdminActivityDestination = {
  label: string
  targetUserId: string | null
  resourceType: string | null
  resourceId: string | null
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function readStr(details: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = details[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** Human-readable destination for admin activity list rows. */
export function resolveAdminActivityDestination(
  actionType: string,
  rawDetails: unknown,
): AdminActivityDestination {
  const details =
    rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
      ? (rawDetails as Record<string, unknown>)
      : {}

  const targetUserId =
    readStr(details, 'targetUserId', 'userId', 'hostUserId', 'recipientUserId') ??
    (typeof details.subscriberId === 'string' ? details.subscriberId : null)

  const postId = readStr(details, 'postId')
  const transferId = readStr(details, 'transferId', 'coinTradingTransferId')
  const ledgerEntryId = readStr(details, 'ledgerEntryId', 'originalLedgerEntryId')
  const giftTransactionId = readStr(details, 'giftTransactionId')
  const withdrawalId = readStr(details, 'withdrawalId')
  const deviceId = readStr(details, 'deviceId')
  const ticketId = readStr(details, 'ticketId', 'supportTicketId')
  const ticketPublicId = readStr(details, 'ticketPublicId')
  const reportId = readStr(details, 'reportId')
  const streamId = readStr(details, 'streamId', 'liveStreamId', 'roomId')
  const agencyId = readStr(details, 'agencyId', 'agencyUserId')

  if (actionType.startsWith('ADMIN_WALLET_') || actionType.startsWith('ADMIN_FREEZE_') || actionType.startsWith('ADMIN_UNFREEZE_')) {
    return {
      label: targetUserId ? `User wallet ${targetUserId}` : 'User wallet',
      targetUserId,
      resourceType: 'user',
      resourceId: targetUserId,
    }
  }
  if (actionType === 'ADMIN_SET_USER_LEVEL') {
    const levelType = readStr(details, 'levelType')
    const targetLevel = details.targetLevel
    return {
      label: `Level ${levelType ?? ''} → ${String(targetLevel ?? '?')}`.trim(),
      targetUserId,
      resourceType: 'user',
      resourceId: targetUserId,
    }
  }
  if (actionType.startsWith('ADMIN_TRANSACTION_REVERT')) {
    return {
      label: giftTransactionId
        ? `Gift ${giftTransactionId}`
        : transferId
          ? `Transfer ${transferId}`
          : ledgerEntryId
            ? `Ledger ${ledgerEntryId}`
            : withdrawalId
              ? `Withdrawal ${withdrawalId}`
              : 'Transaction revert',
      targetUserId,
      resourceType: transferId ? 'coin_trading_transfer' : ledgerEntryId ? 'ledger_entry' : null,
      resourceId: transferId ?? ledgerEntryId ?? giftTransactionId ?? withdrawalId,
    }
  }
  if (actionType.startsWith('ADMIN_POST')) {
    return {
      label: postId ? `Post ${postId}` : 'User posting',
      targetUserId,
      resourceType: postId ? 'post' : 'user',
      resourceId: postId ?? targetUserId,
    }
  }
  if (actionType === 'ADMIN_LIVE_PHOTO_REMOVED') {
    return {
      label: 'Live photo taken down',
      targetUserId,
      resourceType: 'live_photo',
      resourceId: targetUserId,
    }
  }
  if (actionType === 'ADMIN_LIVE_STREAM_STOP_REQUESTED') {
    return {
      label: streamId ? `Live stream ${streamId}` : 'Live stream',
      targetUserId,
      resourceType: 'live_stream',
      resourceId: streamId,
    }
  }
  if (actionType.startsWith('ADMIN_DEVICE_')) {
    return {
      label: deviceId ? `Device ${deviceId}` : 'Device ban',
      targetUserId,
      resourceType: 'device',
      resourceId: deviceId,
    }
  }
  if (actionType.startsWith('ADMIN_USER_RESTRICTION')) {
    const restrictionType = readStr(details, 'restrictionType', 'type')
    return {
      label: restrictionType ? `Restriction: ${restrictionType}` : 'User restriction',
      targetUserId,
      resourceType: 'user',
      resourceId: targetUserId,
    }
  }
  if (actionType === 'WITHDRAWAL_MANUAL_ASSIGN') {
    return {
      label: withdrawalId ? `Withdrawal ${withdrawalId}` : 'Withdrawal assignment',
      targetUserId,
      resourceType: 'withdrawal',
      resourceId: withdrawalId,
    }
  }
  if (actionType.startsWith('ADMIN_NOTIFICATION') || actionType.startsWith('ADMIN_SYSTEM_MESSAGE') || actionType === 'ADMIN_USER_WARNING') {
    return {
      label: targetUserId ? `Message to user ${targetUserId}` : 'Platform message',
      targetUserId,
      resourceType: targetUserId ? 'user' : null,
      resourceId: targetUserId,
    }
  }
  if (actionType.startsWith('ADMIN_PUSH_BROADCAST')) {
    return { label: 'Push broadcast', targetUserId: null, resourceType: null, resourceId: null }
  }
  if (actionType === 'ADMIN_LOGIN' || actionType === 'ADMIN_LOGOUT') {
    return { label: 'Admin session', targetUserId: null, resourceType: 'admin_session', resourceId: null }
  }
  if (actionType.startsWith('ADMIN_SUPPORT_TICKET')) {
    const display = ticketPublicId ?? ticketId
    return {
      label: display ? `Support ticket ${display}` : 'Support ticket',
      targetUserId,
      resourceType: 'support_ticket',
      resourceId: ticketId ?? ticketPublicId,
    }
  }
  if (actionType.startsWith('ADMIN_SUPPORT_REPORT')) {
    const ticketDisplay = ticketPublicId ?? ticketId
    const reportLabel = reportId ? `User report ${reportId}` : 'User report'
    return {
      label: ticketDisplay ? `${reportLabel} → ticket ${ticketDisplay}` : reportLabel,
      targetUserId,
      resourceType: ticketDisplay ? 'support_ticket' : 'user_report',
      resourceId: ticketId ?? ticketPublicId ?? reportId,
    }
  }
  if (ticketId) {
    const display = ticketPublicId ?? ticketId
    return {
      label: `Support ticket ${display}`,
      targetUserId,
      resourceType: 'support_ticket',
      resourceId: ticketId,
    }
  }
  if (agencyId && UUID_RE.test(agencyId)) {
    return {
      label: `Agency ${agencyId}`,
      targetUserId: agencyId,
      resourceType: 'agency',
      resourceId: agencyId,
    }
  }
  if (targetUserId) {
    return {
      label: `User ${targetUserId}`,
      targetUserId,
      resourceType: 'user',
      resourceId: targetUserId,
    }
  }

  return { label: actionType.replace(/_/g, ' ').toLowerCase(), targetUserId: null, resourceType: null, resourceId: null }
}

export const CSA_ACTIVITY_ACTION_TYPES = [
  'ADMIN_SUPPORT_TICKET_REPLY',
  'ADMIN_SUPPORT_TICKET_RESOLVE',
  'ADMIN_SUPPORT_TICKET_REJECT',
  'ADMIN_SUPPORT_TICKET_CLOSE',
  'ADMIN_SUPPORT_TICKET_ASSIGN',
  'ADMIN_SUPPORT_TICKET_CLAIM',
  'ADMIN_SUPPORT_TICKET_PRIORITY',
  'ADMIN_SUPPORT_TICKET_NOTE',
  'ADMIN_SUPPORT_REPORT_REVIEW',
  'ADMIN_SUPPORT_REPORT_ESCALATE',
] as const

export const ADMIN_ACTIVITY_ACTION_PREFIXES = ['ADMIN_', 'WITHDRAWAL_MANUAL_ASSIGN', 'face_profile_', 'face_duplicate_'] as const

export function isAdminActivityActionType(actionType: string): boolean {
  return ADMIN_ACTIVITY_ACTION_PREFIXES.some((p) =>
    p.endsWith('_') ? actionType.startsWith(p) : actionType === p || actionType.startsWith(p),
  )
}

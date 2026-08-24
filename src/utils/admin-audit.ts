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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
  const agencyId = readStr(details, 'agencyId', 'agencyUserId', 'sourceAgencyUserId')
  const giftId = readStr(details, 'giftId')
  const categoryId = readStr(details, 'categoryId', 'sectionId')
  const storeItemId = readStr(details, 'storeItemId', 'itemId')
  const bannerId = readStr(details, 'bannerId')
  const customGiftRequestId = readStr(details, 'customGiftRequestId', 'requestId')
  const settingKey = readStr(details, 'settingKey')

  if (
    actionType.startsWith('ADMIN_WALLET_') ||
    actionType.startsWith('ADMIN_FREEZE_') ||
    actionType.startsWith('ADMIN_UNFREEZE_')
  ) {
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
  if (actionType === 'ADMIN_DEVICE_LOGOUT_ALL') {
    return {
      label: 'Logout all devices',
      targetUserId,
      resourceType: 'user',
      resourceId: targetUserId,
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
  if (
    actionType === 'WITHDRAWAL_MANUAL_ASSIGN' ||
    actionType === 'WITHDRAWAL_REVERSED' ||
    actionType.startsWith('WITHDRAWAL_PLATFORM_') ||
    actionType.startsWith('WITHDRAWAL_DISPUTE_')
  ) {
    return {
      label: withdrawalId ? `Withdrawal ${withdrawalId}` : 'Withdrawal',
      targetUserId,
      resourceType: 'withdrawal',
      resourceId: withdrawalId,
    }
  }
  if (actionType.startsWith('ADMIN_AGENCY_')) {
    return {
      label: agencyId ? `Agency ${agencyId}` : 'Agency',
      targetUserId: agencyId ?? targetUserId,
      resourceType: 'agency',
      resourceId: agencyId ?? targetUserId,
    }
  }
  if (actionType.startsWith('ADMIN_GIFT_GALLERY_')) {
    return {
      label: categoryId ? `Gift gallery ${categoryId}` : 'Gift gallery',
      targetUserId: null,
      resourceType: 'gift_gallery',
      resourceId: categoryId,
    }
  }
  if (actionType.startsWith('ADMIN_GIFT_CATEGORY_')) {
    return {
      label: categoryId ? `Gift category ${categoryId}` : 'Gift category',
      targetUserId: null,
      resourceType: 'gift_category',
      resourceId: categoryId,
    }
  }
  if (actionType.startsWith('ADMIN_GIFT_')) {
    return {
      label: giftId ? `Gift ${giftId}` : 'Gift catalog',
      targetUserId: null,
      resourceType: 'gift',
      resourceId: giftId,
    }
  }
  if (actionType.startsWith('ADMIN_STORE_ITEM_')) {
    return {
      label: storeItemId ? `Store item ${storeItemId}` : 'Store item',
      targetUserId: null,
      resourceType: 'store_item',
      resourceId: storeItemId,
    }
  }
  if (actionType.startsWith('ADMIN_BANNER_')) {
    return {
      label: bannerId ? `Banner ${bannerId}` : 'Banner',
      targetUserId: null,
      resourceType: 'banner',
      resourceId: bannerId,
    }
  }
  if (actionType.startsWith('ADMIN_CUSTOM_GIFT_')) {
    return {
      label: customGiftRequestId ? `Custom gift ${customGiftRequestId}` : 'Custom gift',
      targetUserId,
      resourceType: customGiftRequestId ? 'custom_gift_request' : 'custom_gift_config',
      resourceId: customGiftRequestId,
    }
  }
  if (actionType.startsWith('ADMIN_SYSTEM_SETTINGS_')) {
    if (settingKey === 'account-deletion') {
      return {
        label: 'Account deletion windows',
        targetUserId: null,
        resourceType: 'account_deletion',
        resourceId: 'config',
      }
    }
    return {
      label: settingKey ? `Settings: ${settingKey}` : 'System settings',
      targetUserId: null,
      resourceType: 'system_settings',
      resourceId: settingKey,
    }
  }
  if (actionType === 'ADMIN_ACCOUNT_DELETION_CANCELLED') {
    const deletionId = readStr(details, 'deletionId')
    return {
      label: deletionId ? `Account deletion ${deletionId}` : 'Account deletion request',
      targetUserId,
      resourceType: 'account_deletion',
      resourceId: deletionId,
    }
  }
  if (
    actionType === 'ADMIN_USER_UPDATED' ||
    actionType === 'ADMIN_USER_STATUS_CHANGED' ||
    actionType === 'ADMIN_USER_TAGS_UPDATED' ||
    actionType === 'ADMIN_PASSWORD_RESET' ||
    actionType === 'ADMIN_AVATAR_REMOVED' ||
    actionType === 'ADMIN_BIO_REMOVED' ||
    actionType === 'ADMIN_IDENTITY_RESET'
  ) {
    return {
      label: targetUserId ? `User ${targetUserId}` : 'User',
      targetUserId,
      resourceType: 'user',
      resourceId: targetUserId,
    }
  }
  if (
    actionType.startsWith('ADMIN_NOTIFICATION') ||
    actionType.startsWith('ADMIN_SYSTEM_MESSAGE') ||
    actionType === 'ADMIN_USER_WARNING'
  ) {
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
    return {
      label: 'Admin session',
      targetUserId: null,
      resourceType: 'admin_session',
      resourceId: null,
    }
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

  return {
    label: actionType.replace(/_/g, ' ').toLowerCase(),
    targetUserId: null,
    resourceType: null,
    resourceId: null,
  }
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

/** Shown in the activity-type dropdown before the first log of that type exists. */
export const SEEDED_ADMIN_ACTIVITY_ACTION_TYPES = [
  ...CSA_ACTIVITY_ACTION_TYPES,
  'ADMIN_USER_UPDATED',
  'ADMIN_USER_STATUS_CHANGED',
  'ADMIN_USER_TAGS_UPDATED',
  'ADMIN_PASSWORD_RESET',
  'ADMIN_AVATAR_REMOVED',
  'ADMIN_BIO_REMOVED',
  'ADMIN_IDENTITY_RESET',
  'ADMIN_POSTING_SUSPENDED',
  'ADMIN_POSTING_BANNED',
  'ADMIN_POSTING_RESTORED',
  'ADMIN_POST_DELETED',
  'ADMIN_DEVICE_BANNED',
  'ADMIN_DEVICE_UNBANNED',
  'ADMIN_DEVICE_LOGOUT_ALL',
  'ADMIN_USER_RESTRICTION_APPLIED',
  'ADMIN_USER_RESTRICTION_CLEARED',
  'ADMIN_LIVE_STREAM_STOP_REQUESTED',
  'ADMIN_HOST_STREAM_SUSPENSION_CLEARED',
  'ADMIN_LIVE_PHOTO_REMOVED',
  'ADMIN_AGENCY_APPROVED',
  'ADMIN_AGENCY_REJECTED',
  'ADMIN_AGENCY_COMMISSION_TIER_SET',
  'ADMIN_AGENCY_PAYROLL_PRIVILEGE_SET',
  'ADMIN_AGENCY_HOST_ADDED',
  'ADMIN_AGENCY_HOSTS_TRANSFERRED',
  'ADMIN_AGENCY_HOST_REMOVED',
  'ADMIN_AGENCY_SUSPENDED',
  'ADMIN_AGENCY_UNPAUSED',
  'ADMIN_AGENCY_BANNED',
  'ADMIN_AGENCY_DELETED',
  'ADMIN_AGENCY_UNBARRED',
  'WITHDRAWAL_MANUAL_ASSIGN',
  'WITHDRAWAL_REVERSED',
  'WITHDRAWAL_PLATFORM_PAID_PROOF',
  'WITHDRAWAL_DISPUTE_RESOLVED_AGENT',
  'WITHDRAWAL_DISPUTE_RESOLVED_HOST',
  'ADMIN_SYSTEM_MESSAGE',
  'ADMIN_NOTIFICATION_MESSAGE',
  'ADMIN_NOTIFICATION_BROADCAST',
  'ADMIN_PUSH_BROADCAST',
  'ADMIN_USER_WARNING',
  'ADMIN_GIFT_CREATED',
  'ADMIN_GIFT_UPDATED',
  'ADMIN_GIFT_DISABLED',
  'ADMIN_GIFT_ENABLED',
  'ADMIN_GIFT_DELETED',
  'ADMIN_GIFT_CATEGORY_CREATED',
  'ADMIN_GIFT_CATEGORY_UPDATED',
  'ADMIN_GIFT_CATEGORY_REORDERED',
  'ADMIN_GIFT_CATEGORY_DELETED',
  'ADMIN_GIFT_GALLERY_CREATED',
  'ADMIN_GIFT_GALLERY_UPDATED',
  'ADMIN_GIFT_GALLERY_REORDERED',
  'ADMIN_GIFT_GALLERY_DELETED',
  'ADMIN_GIFT_GALLERY_GIFTS_ADDED',
  'ADMIN_GIFT_GALLERY_GIFTS_REMOVED',
  'ADMIN_STORE_ITEM_CREATED',
  'ADMIN_STORE_ITEM_UPDATED',
  'ADMIN_STORE_ITEM_DISABLED',
  'ADMIN_STORE_ITEM_ENABLED',
  'ADMIN_STORE_ITEM_DELETED',
  'ADMIN_BANNER_CREATED',
  'ADMIN_BANNER_UPDATED',
  'ADMIN_BANNER_STOPPED',
  'ADMIN_BANNER_DELETED',
  'ADMIN_CUSTOM_GIFT_CONFIG_UPDATED',
  'ADMIN_CUSTOM_GIFT_COMPLETED',
  'ADMIN_CUSTOM_GIFT_FAILED',
  'ADMIN_SYSTEM_SETTINGS_UPDATED',
  'ADMIN_ACCOUNT_DELETION_CANCELLED',
] as const

export const ADMIN_ACTIVITY_ACTION_PREFIXES = [
  'ADMIN_',
  'WITHDRAWAL_MANUAL_ASSIGN',
  'WITHDRAWAL_REVERSED',
  'WITHDRAWAL_PLATFORM_',
  'WITHDRAWAL_DISPUTE_',
  'face_profile_',
  'face_duplicate_',
] as const

export function catalogActiveToggleActionType(
  prefix: 'ADMIN_GIFT' | 'ADMIN_STORE_ITEM',
  patch: { isActive?: boolean },
): `${typeof prefix}_DISABLED` | `${typeof prefix}_ENABLED` | `${typeof prefix}_UPDATED` {
  const keys = Object.keys(patch)
  if (keys.length === 1 && patch.isActive === false) return `${prefix}_DISABLED`
  if (keys.length === 1 && patch.isActive === true) return `${prefix}_ENABLED`
  return `${prefix}_UPDATED`
}

export function isAdminActivityActionType(actionType: string): boolean {
  return ADMIN_ACTIVITY_ACTION_PREFIXES.some((p) =>
    p.endsWith('_') ? actionType.startsWith(p) : actionType === p || actionType.startsWith(p),
  )
}

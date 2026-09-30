import { prismaRead } from '../config/database'
import { platformMessagingService } from './platformMessaging.service'
import { pushNotificationService } from './pushNotification.service'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { COUNTERPARTY_USER_SELECT } from '../utils/ledger-transaction-enrichment'
import { buildUserDisplayName } from '../utils/user-display'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'agency-host-leave-notifier' })

/**
 * System message + push telling an agency owner a host applied to leave their agency, or left
 * it at once (immediate exit, no application).
 *
 * Never throws — a failed notification must not roll back, or appear to fail, a leave
 * application that is already committed. Callers await this after their transaction commits,
 * mirroring `agencyHostJoinNotifier`'s contract.
 *
 * Each `clientMessageId` is stable per event, so a retried call dedupes instead of sending a
 * second copy.
 */
export const agencyHostLeaveNotifier = {
  async notifyLeaveApplied(params: {
    agencyUserId: string
    hostUserId: string
    applicationId: string
    autoApproveAt: Date
    reason?: string | null
  }): Promise<void> {
    try {
      const host = await prismaRead.user.findUnique({
        where: { id: params.hostUserId },
        select: COUNTERPARTY_USER_SELECT,
      })
      if (!host) return

      const displayName = buildUserDisplayName(host)
      const reason = params.reason?.trim()
      const deadline = params.autoApproveAt.toISOString().slice(0, 10)
      const content = [
        `${displayName} has applied to leave your agency.`,
        reason ? `Reason: ${reason}` : null,
        `Please review it before ${deadline} (UTC), or it will be approved automatically.`,
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 4000)
      const metadata: PlatformMessageMetadata = {
        category: 'system',
        counterparty: {
          userId: host.id,
          displayName,
          publicId: host.publicId.toString(),
          avatarUrl: host.avatarUrl,
        },
      }

      const sent = await platformMessagingService.sendPlatformMessage({
        targetUserId: params.agencyUserId,
        type: 'SYSTEM',
        content,
        metadata,
        clientMessageId: `agency-host-leave-applied:${params.applicationId}`,
      })

      if (sent.created) {
        await pushNotificationService.sendToUser(
          params.agencyUserId,
          {
            title: 'Host applied to leave your agency',
            body: `${displayName} has applied to leave your agency.`,
            data: {
              type: 'AGENCY_HOST_LEAVE_APPLIED',
              hostUserId: params.hostUserId,
              applicationId: params.applicationId,
            },
          },
          { source: 'TRANSACTION' },
        )
      }
    } catch (err) {
      log.warn(
        {
          err,
          agencyUserId: params.agencyUserId,
          hostUserId: params.hostUserId,
          applicationId: params.applicationId,
        },
        'agency host leave-application notification failed',
      )
    }
  },

  /**
   * Host exited at once with no leave application (joined < 24h ago, or not face-verified).
   *
   * `clientMessageId` is keyed on the membership's `joinedAt`, not just the pair: a host may
   * rejoin after the cooldown and leave again, and that second exit must still notify.
   */
  async notifyHostLeft(params: {
    agencyUserId: string
    hostUserId: string
    joinedAt: Date
  }): Promise<void> {
    try {
      const host = await prismaRead.user.findUnique({
        where: { id: params.hostUserId },
        select: COUNTERPARTY_USER_SELECT,
      })
      if (!host) return

      const displayName = buildUserDisplayName(host)
      const content = `${displayName} left your agency.`
      const metadata: PlatformMessageMetadata = {
        category: 'system',
        counterparty: {
          userId: host.id,
          displayName,
          publicId: host.publicId.toString(),
          avatarUrl: host.avatarUrl,
        },
      }

      const sent = await platformMessagingService.sendPlatformMessage({
        targetUserId: params.agencyUserId,
        type: 'SYSTEM',
        content,
        metadata,
        clientMessageId: `agency-host-left:${params.agencyUserId}:${params.hostUserId}:${params.joinedAt.getTime()}`,
      })

      if (sent.created) {
        await pushNotificationService.sendToUser(
          params.agencyUserId,
          {
            title: 'Host left your agency',
            body: content,
            data: { type: 'AGENCY_HOST_LEFT', hostUserId: params.hostUserId },
          },
          { source: 'TRANSACTION' },
        )
      }
    } catch (err) {
      log.warn(
        { err, agencyUserId: params.agencyUserId, hostUserId: params.hostUserId },
        'agency host left notification failed',
      )
    }
  },
}

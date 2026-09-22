import { prismaRead } from '../config/database'
import { platformMessagingService } from './platformMessaging.service'
import { pushNotificationService } from './pushNotification.service'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { COUNTERPARTY_USER_SELECT } from '../utils/ledger-transaction-enrichment'
import { buildUserDisplayName } from '../utils/user-display'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'agency-host-join-notifier' })

/**
 * System message + push telling an agency owner a host just joined their agency.
 *
 * Never throws — a failed notification must not roll back, or appear to fail, a join that is
 * already committed. Callers await this after their transaction commits, mirroring
 * `agencyApplicationNotifier`'s contract.
 *
 * `clientMessageId` is derived from the (agencyUserId, hostUserId) pair, so a retried call
 * (e.g. an admin re-add after a race) dedupes instead of sending a second copy.
 */
export const agencyHostJoinNotifier = {
  async notifyHostJoined(params: { agencyUserId: string; hostUserId: string }): Promise<void> {
    try {
      const host = await prismaRead.user.findUnique({
        where: { id: params.hostUserId },
        select: COUNTERPARTY_USER_SELECT,
      })
      if (!host) return

      const displayName = buildUserDisplayName(host)
      const content = `${displayName} joined your agency.`
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
        clientMessageId: `agency-host-joined:${params.agencyUserId}:${params.hostUserId}`,
      })

      if (sent.created) {
        await pushNotificationService.sendToUser(
          params.agencyUserId,
          {
            title: 'New host joined your agency',
            body: content,
            data: { type: 'AGENCY_HOST_JOINED', hostUserId: params.hostUserId },
          },
          { source: 'TRANSACTION' },
        )
      }
    } catch (err) {
      log.warn(
        { err, agencyUserId: params.agencyUserId, hostUserId: params.hostUserId },
        'agency host join notification failed',
      )
    }
  },
}

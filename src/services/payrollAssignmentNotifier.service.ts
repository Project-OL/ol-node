import { platformMessagingService } from './platformMessaging.service'
import { pushNotificationService } from './pushNotification.service'
import type { PlatformMessageMetadata } from '../models/platform-message.schemas'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'payroll-assignment-notifier' })

/**
 * System message + push telling an agency a payroll (withdrawal) was assigned to them to
 * process.
 *
 * Never throws — a failed notification must not roll back, or appear to fail, an assignment
 * that is already committed. Callers await this after `assignToAgency`'s transaction commits,
 * mirroring `agencyApplicationNotifier` / `agencyHostJoinNotifier`'s contract.
 *
 * `clientMessageId` is derived from the assignment id, so a retried notify (e.g. an SLA
 * reassign racing the original call) dedupes instead of sending a second copy.
 */
export const payrollAssignmentNotifier = {
  async notifyAgencyOfAssignment(params: {
    agencyUserId: string
    assignmentId: string
    withdrawalId: string
    amountPoints: bigint
  }): Promise<void> {
    try {
      const content = `A payroll of ${params.amountPoints.toString()} points has been assigned to you for processing.`
      const metadata: PlatformMessageMetadata = {
        category: 'system',
        withdrawalId: params.withdrawalId,
        amount: params.amountPoints.toString(),
      }

      const sent = await platformMessagingService.sendPlatformMessage({
        targetUserId: params.agencyUserId,
        type: 'SYSTEM',
        content,
        metadata,
        clientMessageId: `payroll-assigned:${params.assignmentId}`,
      })

      if (sent.created) {
        await pushNotificationService.sendToUser(
          params.agencyUserId,
          {
            title: 'Payroll assigned to you',
            body: content,
            data: {
              type: 'PAYROLL_ASSIGNED',
              withdrawalId: params.withdrawalId,
              assignmentId: params.assignmentId,
            },
          },
          { source: 'TRANSACTION' },
        )
      }
    } catch (err) {
      log.warn(
        { err, agencyUserId: params.agencyUserId, assignmentId: params.assignmentId },
        'payroll assignment notification failed',
      )
    }
  },
}

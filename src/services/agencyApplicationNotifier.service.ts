import { platformMessagingService } from './platformMessaging.service'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'agency-application-notifier' })

const APPROVED_MESSAGE =
  'Your agency application has been approved. You now have access to your agency dashboard, ' +
  'and you can start inviting hosts.'

const REJECTED_MESSAGE = 'Your agency application was not approved.'

/**
 * System message telling an applicant their agency application was approved or rejected.
 *
 * Lives in its own module because both decision paths are in different services
 * (`agency.service.createAgencyFromApplication` approves, `agencyAdmin.service.rejectApplication`
 * rejects) and the wording should not drift between them.
 *
 * Never throws. A failed message must not roll back — or appear to fail — a decision that is
 * already committed, so callers can await this without a try/catch of their own. The approve
 * path in particular runs this *after* its transaction commits, for exactly that reason.
 *
 * `clientMessageId` is derived from the application id, so a retried decision reuses the same
 * id and `sendMessageWithOutbox` dedupes instead of sending a second copy.
 */
export const agencyApplicationNotifier = {
  async notifyDecision(params: {
    applicantUserId: string
    applicationId: string
    decision: 'APPROVED' | 'REJECTED'
    /** Admin-authored note shown to the applicant. Only used on rejection. */
    userNote?: string | null
  }): Promise<void> {
    const isApproved = params.decision === 'APPROVED'
    const note = params.userNote?.trim()

    const content = isApproved
      ? APPROVED_MESSAGE
      : note
        ? `${REJECTED_MESSAGE} ${note}`
        : REJECTED_MESSAGE

    try {
      await platformMessagingService.sendPlatformMessage({
        targetUserId: params.applicantUserId,
        type: 'SYSTEM',
        content,
        metadata: { category: 'system' },
        clientMessageId: `agency-application-${params.decision.toLowerCase()}:${params.applicationId}`,
      })
    } catch (err) {
      log.warn(
        {
          err,
          applicantUserId: params.applicantUserId,
          applicationId: params.applicationId,
          decision: params.decision,
        },
        'agency application decision system message failed',
      )
    }
  },
}

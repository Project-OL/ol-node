import { env } from '../config/env'
import { auditService } from './audit.service'
import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import { detectOtpTarget } from './otp-delivery.service'
import { msg91Provider } from './providers/msg91.provider'
import { sesProvider } from './providers/ses.provider'
import { rootLogger } from '../utils/rootLogger'

const noticeLog = rootLogger.child({ module: 'account-deletion-notice' })

export type AccountDeletionNoticeChannel = 'email' | 'whatsapp' | 'sms'

export type AccountDeletionNoticeResult = {
  sent: boolean
  channels: AccountDeletionNoticeChannel[]
  skipped: string[]
  errors: string[]
}

function formatDeletionAt(deletionAt: Date): string {
  return deletionAt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

function pickEmail(identifiers: Array<{ provider: string; identifier: string; isPrimary: boolean; isVerified: boolean }>): string | null {
  const emails = identifiers.filter((i) => i.provider === 'email')
  const preferred =
    emails.find((i) => i.isVerified && i.isPrimary) ??
    emails.find((i) => i.isVerified) ??
    emails.find((i) => i.isPrimary) ??
    emails[0]
  if (preferred) return preferred.identifier

  const googleish = identifiers.find((i) => i.provider === 'google' && i.identifier.includes('@'))
  return googleish?.identifier ?? null
}

function pickPhone(identifiers: Array<{ provider: string; identifier: string; isPrimary: boolean; isVerified: boolean }>): string | null {
  const phones = identifiers.filter((i) => i.provider === 'phone')
  const preferred =
    phones.find((i) => i.isVerified && i.isPrimary) ??
    phones.find((i) => i.isVerified) ??
    phones.find((i) => i.isPrimary) ??
    phones[0]
  return preferred?.identifier ?? null
}

function buildEmailBody(deletionAtLabel: string): { subject: string; text: string; html: string } {
  const subject = 'Your OffooLive account will be deleted in 30 minutes'
  const text = `Your OffooLive account is scheduled for permanent deletion at ${deletionAtLabel}.

If you still want to keep this account, open the app and cancel the deletion request before that time (if your grace period has not expired).

If you did not request this, contact support immediately.`
  const html = `
<!doctype html>
<html>
  <body>
    <p>Your OffooLive account is scheduled for permanent deletion at <strong>${deletionAtLabel}</strong>.</p>
    <p>If you still want to keep this account, open the app and cancel the deletion request before that time (if your grace period has not expired).</p>
    <p>If you did not request this, contact support immediately.</p>
  </body>
</html>`.trim()
  return { subject, text, html }
}

export const accountDeletionNoticeService = {
  async sendUpcomingDeletionNotice(params: {
    userId: string
    deletionAt: Date
  }): Promise<AccountDeletionNoticeResult> {
    const identifiers = await authIdentifierRepository.findByUserId(params.userId)
    const email = pickEmail(identifiers)
    const phoneRaw = pickPhone(identifiers)
    const deletionAtLabel = formatDeletionAt(params.deletionAt)
    const channels: AccountDeletionNoticeChannel[] = []
    const skipped: string[] = []
    const errors: string[] = []

    if (email) {
      const body = buildEmailBody(deletionAtLabel)
      const result = await sesProvider.sendTransactionalEmail({
        email,
        subject: body.subject,
        text: body.text,
        html: body.html,
      })
      if (result.success) {
        channels.push('email')
        auditService.log({
          userId: params.userId,
          actionType: 'ACCOUNT_DELETION_REMINDER_SENT',
          actionStatus: 'success',
          actionDetails: {
            channel: 'email',
            deletionAt: params.deletionAt.toISOString(),
            messageId: result.providerMessageId,
          },
        })
      } else {
        errors.push(`email: ${result.error ?? 'failed'}`)
        noticeLog.warn(
          { userId: params.userId, error: result.error },
          'Account deletion reminder email failed',
        )
      }
    } else {
      skipped.push('email')
    }

    let phoneE164: string | null = null
    if (phoneRaw) {
      try {
        const target = detectOtpTarget(phoneRaw)
        if (target.type === 'phone') phoneE164 = target.providerPhone
      } catch {
        skipped.push('phone_invalid')
      }
    } else {
      skipped.push('phone')
    }

    if (phoneE164) {
      const waTemplate = env.MSG91_WHATSAPP_ACCOUNT_DELETION_TEMPLATE_ID?.trim()
      const smsTemplate = env.MSG91_SMS_ACCOUNT_DELETION_TEMPLATE_ID?.trim()
      let phoneSent = false

      if (waTemplate && env.MSG91_AUTH_KEY && env.MSG91_WHATSAPP_SENDER) {
        const wa = await msg91Provider.sendWhatsappTemplate({
          phone: phoneE164,
          templateName: waTemplate,
          bodyValues: [deletionAtLabel],
        })
        if (wa.success) {
          channels.push('whatsapp')
          phoneSent = true
          auditService.log({
            userId: params.userId,
            actionType: 'ACCOUNT_DELETION_REMINDER_SENT',
            actionStatus: 'success',
            actionDetails: {
              channel: 'whatsapp',
              deletionAt: params.deletionAt.toISOString(),
              messageId: wa.providerMessageId,
            },
          })
        } else {
          errors.push(`whatsapp: ${wa.error ?? 'failed'}`)
          noticeLog.warn(
            { userId: params.userId, error: wa.error },
            'Account deletion reminder WhatsApp failed; trying SMS fallback',
          )
        }
      } else {
        skipped.push('whatsapp_unconfigured')
      }

      if (!phoneSent) {
        if (smsTemplate && env.MSG91_AUTH_KEY && env.MSG91_SENDER_ID) {
          const sms = await msg91Provider.sendSmsTemplate({
            phone: phoneE164,
            templateId: smsTemplate,
            templateVariables: { var: deletionAtLabel },
          })
          if (sms.success) {
            channels.push('sms')
            auditService.log({
              userId: params.userId,
              actionType: 'ACCOUNT_DELETION_REMINDER_SENT',
              actionStatus: 'success',
              actionDetails: {
                channel: 'sms',
                deletionAt: params.deletionAt.toISOString(),
                messageId: sms.providerMessageId,
                fallbackFrom: waTemplate ? 'whatsapp' : undefined,
              },
            })
          } else {
            errors.push(`sms: ${sms.error ?? 'failed'}`)
            noticeLog.warn(
              { userId: params.userId, error: sms.error },
              'Account deletion reminder SMS failed',
            )
          }
        } else {
          skipped.push('sms_unconfigured')
        }
      }
    }

    return {
      sent: channels.length > 0,
      channels,
      skipped,
      errors,
    }
  },
}

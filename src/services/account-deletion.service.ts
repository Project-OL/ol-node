/**
 * Account Deletion & Deactivation: schedule (admin-configured grace + delete windows),
 * cancel, status, 30-minute reminder, and deletion job.
 */

import { RedisKeys } from '../config/redis'
import { accountDeletionRepository } from '../repositories/account-deletion.repository'
import { userRepository } from '../repositories/user.repository'
import { sessionService } from './session.service'
import { securityPasswordService } from './security-password.service'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { meService } from './me.service'
import { accountDeletionConfigService } from './accountDeletionConfig.service'
import { accountDeletionNoticeService } from './account-deletion-notice.service'
import { platformMessagingService } from './platformMessaging.service'
import { AppError } from '../middlewares/errorHandler'
import { rootLogger } from '../utils/rootLogger'

const DELETION_STATUS_CACHE_TTL = 3600
const REMINDER_LEAD_MS = 30 * 60 * 1000
const log = rootLogger.child({ module: 'account-deletion' })

const LOGIN_CANCEL_SYSTEM_MESSAGE =
  'Your account deletion was cancelled because you logged in before the deletion period ended. Your account remains active.'

export const accountDeletionService = {
  async scheduleDeletion(
    userId: string,
    securityPassword: string,
    reason?: string,
    ipAddress?: string,
  ): Promise<{
    success: boolean
    message: string
    scheduledAt: Date
    deactivationUntil: Date
    deletionAt: Date
    daysUntilDeletion: number
    daysGracePeriod: number
    status: string
  }> {
    await securityPasswordService.verifyCurrentPassword(userId, securityPassword)

    const existing = await accountDeletionRepository.findByUserId(userId)
    if (existing && existing.isDeleted) {
      throw new AppError(409, 'Account already deleted', 'ACCOUNT_ALREADY_DELETED')
    }
    if (existing && !existing.isCancelled) {
      throw new AppError(409, 'Deletion already scheduled', 'DELETION_ALREADY_SCHEDULED')
    }

    const { gracePeriodDays, deletionPeriodDays } = await accountDeletionConfigService.getPeriods()
    const now = new Date()
    const deactivationUntil = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000)
    const deletionAt = new Date(now.getTime() + deletionPeriodDays * 24 * 60 * 60 * 1000)

    await accountDeletionRepository.upsertSchedule({
      userId,
      scheduledAt: now,
      deactivationUntil,
      deletionAt,
      reason: reason ?? undefined,
      ipAddress: ipAddress ?? undefined,
    })

    await userRepository.update(userId, { status: 'deactivating' })
    await sessionService.revokeAllSessions(userId)
    await invalidateUserCaches(userId)

    await auditService.log({
      userId,
      actionType: 'ACCOUNT_DELETION_SCHEDULED',
      actionStatus: 'success',
      actionDetails: {
        scheduledAt: now.toISOString(),
        deactivationUntil: deactivationUntil.toISOString(),
        deletionAt: deletionAt.toISOString(),
        gracePeriodDays,
        deletionPeriodDays,
        reason: reason ?? undefined,
        ipAddress: ipAddress ?? undefined,
      },
    })

    return {
      success: true,
      message: 'Account scheduled for deletion',
      scheduledAt: now,
      deactivationUntil,
      deletionAt,
      daysUntilDeletion: deletionPeriodDays,
      daysGracePeriod: gracePeriodDays,
      status: 'deactivating',
    }
  },

  async getDeletionStatus(userId: string): Promise<{
    isScheduledForDeletion: boolean
    scheduledAt?: Date
    deactivationUntil?: Date
    deletionAt?: Date
    daysRemaining?: number
    daysUntilCancel?: number
    canReactivate?: boolean
    reason?: string
  }> {
    const cacheKey = RedisKeys.userDeletionStatus(userId)
    const cached = await cacheService.get(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          isScheduledForDeletion: boolean
          scheduledAt?: string
          deactivationUntil?: string
          deletionAt?: string
          daysRemaining?: number
          daysUntilCancel?: number
          canReactivate?: boolean
          reason?: string
        }
        return {
          ...parsed,
          scheduledAt: parsed.scheduledAt ? new Date(parsed.scheduledAt) : undefined,
          deactivationUntil: parsed.deactivationUntil
            ? new Date(parsed.deactivationUntil)
            : undefined,
          deletionAt: parsed.deletionAt ? new Date(parsed.deletionAt) : undefined,
        }
      } catch {
        // invalid cache, fall through
      }
    }

    const deletion = await accountDeletionRepository.findByUserId(userId)
    if (!deletion || deletion.isCancelled || deletion.isDeleted) {
      return { isScheduledForDeletion: false }
    }

    const now = new Date()
    const daysRemaining = Math.ceil(
      (deletion.deletionAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    )
    const daysUntilCancel = Math.ceil(
      (deletion.deactivationUntil.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    )
    const canReactivate = deletion.deactivationUntil > now

    const result = {
      isScheduledForDeletion: true,
      scheduledAt: deletion.scheduledAt,
      deactivationUntil: deletion.deactivationUntil,
      deletionAt: deletion.deletionAt,
      daysRemaining,
      daysUntilCancel,
      canReactivate,
      reason: deletion.reason ?? undefined,
    }

    await cacheService.set(
      cacheKey,
      JSON.stringify({
        ...result,
        scheduledAt: result.scheduledAt.toISOString(),
        deactivationUntil: result.deactivationUntil.toISOString(),
        deletionAt: result.deletionAt.toISOString(),
      }),
      DELETION_STATUS_CACHE_TTL,
    )

    return result
  },

  async cancelDeletion(
    userId: string,
    securityPassword: string,
  ): Promise<{
    success: boolean
    message: string
    status: string
    cancelledAt: Date
  }> {
    await securityPasswordService.verifyCurrentPassword(userId, securityPassword)

    const deletion = await accountDeletionRepository.findByUserId(userId)
    if (!deletion || deletion.isCancelled || deletion.isDeleted) {
      throw new AppError(400, 'No deletion scheduled', 'NOT_SCHEDULED_FOR_DELETION')
    }

    const now = new Date()
    if (deletion.deactivationUntil < now) {
      throw new AppError(
        400,
        'Grace period expired. Account cannot be reactivated.',
        'DELETION_WINDOW_EXPIRED',
      )
    }

    return cancelScheduledDeletion(deletion.id, userId, now, 'user')
  },

  async cancelDeletionByAdmin(deletionId: string, _adminUserId: string): Promise<{
    success: boolean
    message: string
    status: string
    cancelledAt: Date
    userId: string
  }> {
    const deletion = await accountDeletionRepository.findByIdWithUser(deletionId)
    if (!deletion) {
      throw new AppError(404, 'Account deletion request not found', 'ACCOUNT_DELETION_NOT_FOUND')
    }
    if (deletion.isDeleted) {
      throw new AppError(400, 'Account already deleted', 'ACCOUNT_ALREADY_DELETED')
    }
    if (deletion.isCancelled) {
      throw new AppError(409, 'Deletion already cancelled', 'DELETION_ALREADY_CANCELLED')
    }

    const now = new Date()
    const result = await cancelScheduledDeletion(deletion.id, deletion.userId, now, 'admin')
    return { ...result, userId: deletion.userId }
  },

  /**
   * Login while a deletion is still scheduled: cancel it, keep the account active,
   * and notify the user in the SYSTEM inbox. Returns true when a schedule was cancelled.
   */
  async cancelIfScheduledOnLogin(userId: string): Promise<boolean> {
    const deletion = await accountDeletionRepository.findByUserId(userId)
    if (!deletion || deletion.isCancelled || deletion.isDeleted) return false

    const now = new Date()
    await cancelScheduledDeletion(deletion.id, userId, now, 'login')

    try {
      await platformMessagingService.sendPlatformMessage({
        targetUserId: userId,
        type: 'SYSTEM',
        content: LOGIN_CANCEL_SYSTEM_MESSAGE,
        metadata: { category: 'system' },
        clientMessageId: `account-deletion-cancel-login:${deletion.id}`,
      })
    } catch (err) {
      log.warn({ err, userId, deletionId: deletion.id }, 'login-cancel system message failed')
    }

    return true
  },

  async runReminderJob(): Promise<{
    notifiedCount: number
    skippedCount: number
    errors: Array<{ userId: string; error: string }>
  }> {
    const now = new Date()
    const windowEnd = new Date(now.getTime() + REMINDER_LEAD_MS)
    const due = await accountDeletionRepository.findDueForReminder(now, windowEnd)
    const errors: Array<{ userId: string; error: string }> = []
    let notifiedCount = 0
    let skippedCount = 0

    for (const deletion of due) {
      try {
        const claimed = await accountDeletionRepository.claimReminder(deletion.id, now)
        if (!claimed) continue
        const result = await accountDeletionNoticeService.sendUpcomingDeletionNotice({
          userId: deletion.userId,
          deletionAt: deletion.deletionAt,
        })
        if (result.sent) {
          notifiedCount += 1
        } else {
          skippedCount += 1
        }
      } catch (err) {
        errors.push({
          userId: deletion.userId,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return { notifiedCount, skippedCount, errors }
  },

  async runDeletionJob(): Promise<{
    deletedCount: number
    errors: Array<{ userId: string; error: string }>
  }> {
    const now = new Date()
    const accountsToDelete = await accountDeletionRepository.findForDeletion(now)
    const errors: Array<{ userId: string; error: string }> = []

    // Process in parallel chunks to avoid sequential bottleneck (previously one-by-one)
    // while still bounding concurrency to prevent overwhelming the DB connection pool.
    const CHUNK_SIZE = 10
    for (let i = 0; i < accountsToDelete.length; i += CHUNK_SIZE) {
      const chunk = accountsToDelete.slice(i, i + CHUNK_SIZE)
      await Promise.all(
        chunk.map(async (deletion) => {
          try {
            await userRepository.deleteAccountPermanently(deletion.userId, deletion.id)
            await meService.invalidateUserCaches(deletion.userId)
          } catch (err) {
            errors.push({
              userId: deletion.userId,
              error: err instanceof Error ? err.message : 'Unknown error',
            })
          }
        }),
      )
    }

    await auditService.log({
      userId: 'system',
      actionType: 'ACCOUNT_DELETION_JOB_COMPLETED',
      actionStatus: errors.length === 0 ? 'success' : 'failed',
      actionDetails: {
        deletedCount: accountsToDelete.length,
        errorCount: errors.length,
        partial: errors.length > 0,
        timestamp: now.toISOString(),
      },
    })

    return {
      deletedCount: accountsToDelete.length - errors.length,
      errors,
    }
  },
}

async function cancelScheduledDeletion(
  deletionId: string,
  userId: string,
  now: Date,
  actor: 'user' | 'admin' | 'login',
): Promise<{
  success: boolean
  message: string
  status: string
  cancelledAt: Date
}> {
  await accountDeletionRepository.update(deletionId, {
    isCancelled: true,
    cancelledAt: now,
  })
  await userRepository.update(userId, { status: 'active' })
  await invalidateUserCaches(userId)

  if (actor === 'user' || actor === 'login') {
    await auditService.log({
      userId,
      actionType: 'ACCOUNT_DELETION_CANCELLED',
      actionStatus: 'success',
      actionDetails: { cancelledAt: now.toISOString(), cancelledBy: actor },
    })
  }

  return {
    success: true,
    message: 'Account deletion cancelled successfully',
    status: 'active',
    cancelledAt: now,
  }
}

async function invalidateUserCaches(userId: string): Promise<void> {
  await meService.invalidateUserCaches(userId)
  await cacheService.delete(RedisKeys.userDeletionStatus(userId))
  await cacheService.delete(RedisKeys.userAuthIdentifiers(userId))
  await cacheService.delete(RedisKeys.userDevices(userId))
  await cacheService.delete(RedisKeys.userSessions(userId))
}

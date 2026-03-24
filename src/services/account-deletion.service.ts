/**
 * Account Deletion & Deactivation: schedule (30-day grace, 45-day delete), cancel, status, and daily job.
 */

import { RedisKeys } from '../config/redis'
import { accountDeletionRepository } from '../repositories/account-deletion.repository'
import { userRepository } from '../repositories/user.repository'
import { sessionService } from './session.service'
import { securityPasswordService } from './security-password.service'
import { cacheService } from './cache.service'
import { auditService } from './audit.service'
import { AppError } from '../middlewares/errorHandler'

const GRACE_DAYS = 30
const DELETION_DAYS = 45
const DELETION_STATUS_CACHE_TTL = 3600

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
    if (existing && !existing.isCancelled) {
      throw new AppError(409, 'Deletion already scheduled', 'DELETION_ALREADY_SCHEDULED')
    }

    const now = new Date()
    const deactivationUntil = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000)
    const deletionAt = new Date(now.getTime() + DELETION_DAYS * 24 * 60 * 60 * 1000)

    await accountDeletionRepository.create({
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
      daysUntilDeletion: DELETION_DAYS,
      daysGracePeriod: GRACE_DAYS,
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
          deactivationUntil: parsed.deactivationUntil ? new Date(parsed.deactivationUntil) : undefined,
          deletionAt: parsed.deletionAt ? new Date(parsed.deletionAt) : undefined,
        }
      } catch {
        // invalid cache, fall through
      }
    }

    const deletion = await accountDeletionRepository.findByUserId(userId)
    if (!deletion || deletion.isCancelled) {
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
    if (!deletion || deletion.isCancelled) {
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

    await accountDeletionRepository.update(deletion.id, {
      isCancelled: true,
      cancelledAt: now,
    })
    await userRepository.update(userId, { status: 'active' })
    await invalidateUserCaches(userId)

    await auditService.log({
      userId,
      actionType: 'ACCOUNT_DELETION_CANCELLED',
      actionStatus: 'success',
      actionDetails: { cancelledAt: now.toISOString() },
    })

    return {
      success: true,
      message: 'Account deletion cancelled successfully',
      status: 'active',
      cancelledAt: now,
    }
  },

  async runDeletionJob(): Promise<{
    deletedCount: number
    errors: Array<{ userId: string; error: string }>
  }> {
    const now = new Date()
    const accountsToDelete = await accountDeletionRepository.findForDeletion(now)
    const errors: Array<{ userId: string; error: string }> = []

    for (const deletion of accountsToDelete) {
      try {
        await userRepository.deleteAccountPermanently(deletion.userId, deletion.id)
      } catch (err) {
        errors.push({
          userId: deletion.userId,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
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

async function invalidateUserCaches(userId: string): Promise<void> {
  await cacheService.delete(RedisKeys.userDeletionStatus(userId))
  await cacheService.delete(RedisKeys.userAuthIdentifiers(userId))
  await cacheService.delete(RedisKeys.userDevices(userId))
  await cacheService.delete(RedisKeys.userSessions(userId))
}

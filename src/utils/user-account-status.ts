import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'

type AuthUserRow = {
  id: string
  status: string
  suspendedUntil?: Date | null
}

/**
 * Auto-reactivates expired timed suspensions; throws when login/API auth must be blocked
 * (banned / suspended / deleted). Scheduled deletion is not blocked — login cancels it.
 */
export async function ensureUserMayAuthenticate(user: AuthUserRow): Promise<void> {
  if (user.status === 'suspended' && user.suspendedUntil && user.suspendedUntil <= new Date()) {
    await userRepository.update(user.id, { status: 'active', suspendedUntil: null })
    return
  }

  if (user.status === 'deleted') {
    throw new AppError(403, 'Account has been permanently deleted.', 'ACCOUNT_DELETED')
  }
  if (user.status === 'banned') {
    throw new AppError(403, 'Account banned', 'ACCOUNT_BANNED')
  }
  if (user.status === 'suspended') {
    throw new AppError(403, 'Account suspended', 'ACCOUNT_SUSPENDED', {
      ...(user.suspendedUntil != null && {
        suspendedUntil: user.suspendedUntil.toISOString(),
      }),
    })
  }
}

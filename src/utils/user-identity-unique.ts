import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import { formatUserName } from './user-display'

export const USERNAME_TAKEN = 'USERNAME_TAKEN'
export const USERNAME_TAKEN_MESSAGE = 'Username is already taken'

function throwUsernameTaken(): never {
  throw new AppError(409, USERNAME_TAKEN_MESSAGE, USERNAME_TAKEN)
}

async function isHandleTaken(username: string, excludeUserId?: string): Promise<boolean> {
  const hit = await userRepository.findOtherByUsernameInsensitive(username, excludeUserId)
  return Boolean(hit)
}

async function isDisplayNameTaken(
  firstName: string,
  lastName: string | null | undefined,
  excludeUserId?: string,
): Promise<boolean> {
  const hit = await userRepository.findOtherByDisplayNameInsensitive(
    firstName,
    lastName,
    excludeUserId,
  )
  return Boolean(hit)
}

/** True when another non-deleted user already uses this string as handle or as first+last. *//
export async function isIdentityTaken(
  username: string,
  excludeUserId?: string,
): Promise<boolean> {
  const value = username.trim()
  if (!value) return false
  if (await isHandleTaken(value, excludeUserId)) return true

  const space = value.indexOf(' ')
  if (space === -1) {
    return isDisplayNameTaken(value, null, excludeUserId)
  }
  return isDisplayNameTaken(value.slice(0, space), value.slice(space + 1), excludeUserId)
}

/** Handle (`users.username`) must be unique among non-deleted users. */
export async function assertUsernameAvailable(
  username: string,
  excludeUserId?: string,
): Promise<void> {
  if (await isIdentityTaken(username, excludeUserId)) throwUsernameTaken()
}

/**
 * Display name (`first_name` + `last_name`) must be unique among non-deleted users.
 * Same person (excludeUserId) may keep their current name.
 */
export async function assertDisplayNameAvailable(
  firstName: string,
  lastName: string | null | undefined,
  excludeUserId?: string,
): Promise<void> {
  const first = firstName.trim()
  if (!first) return
  const last = lastName?.trim() ? lastName.trim() : null
  if (await isDisplayNameTaken(first, last, excludeUserId)) throwUsernameTaken()

  const asHandle = formatUserName({ firstName: first, lastName: last })
  if (asHandle.length > 0 && (await isHandleTaken(asHandle, excludeUserId))) {
    throwUsernameTaken()
  }
}

/**
 * Signup / OAuth auto-handles: if the derived username is taken, suffix until unique.
 * User-chosen names should use {@link assertUsernameAvailable} instead (409).
 */
export async function allocateUniqueUsername(preferred: string): Promise<string> {
  const base = preferred.trim().slice(0, 240) || 'user'
  if (!(await isIdentityTaken(base))) return base

  for (let i = 2; i <= 50; i += 1) {
    const candidate = `${base}_${i}`.slice(0, 255)
    if (!(await isIdentityTaken(candidate))) return candidate
  }

  const fallback = `${base}_${Date.now().toString(36)}`.slice(0, 255)
  if (await isIdentityTaken(fallback)) throwUsernameTaken()
  return fallback
}

import { authPasswordRepository } from '../repositories/auth-password.repository'
import { passwordSchema } from '../models/schemas'
import { hashAsync, compareAsync } from '../utils/bcrypt-async'

/**
 * Password hashing (bcrypt), verification, strength validation, and DB updates.
 * Uses worker thread when available so event loop isn't blocked.
 */
export const passwordService = {
  /** Hash a plain password for storage. */
  hash(plain: string): Promise<string> {
    return hashAsync(plain)
  },

  /** Compare plain password with stored hash. */
  compare(plain: string, hash: string): Promise<boolean> {
    return compareAsync(plain, hash)
  },

  /** Validate password against policy (length, complexity). Returns ok or error message. */
  validateStrength(password: string): { ok: true } | { ok: false; error: string } {
    const result = passwordSchema.safeParse(password)
    if (result.success) return { ok: true }
    const msg = result.error.errors[0]?.message ?? 'Invalid password'
    return { ok: false, error: msg }
  },

  /** Set or replace password for user (upsert AuthPassword). */
  async setPassword(userId: string, newPassword: string): Promise<void> {
    const hash = await hashAsync(newPassword)
    await authPasswordRepository.update(userId, hash)
  },

  /** Create password record for user (e.g. first-time set). */
  async createPassword(userId: string, password: string): Promise<void> {
    const hash = await hashAsync(password)
    await authPasswordRepository.update(userId, hash, [])
  },

  /** Verify current password and update to new one; returns false if current is wrong. */
  async verifyAndUpdate(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const existing = await authPasswordRepository.findByUserId(userId)
    if (!existing) return false
    const match = await compareAsync(currentPassword, existing.passwordHash)
    if (!match) return false
    const hash = await hashAsync(newPassword)
    await authPasswordRepository.update(userId, hash, [existing.passwordHash])
    return true
  },

  /** Check if user has an AuthPassword record. */
  async hasPassword(userId: string): Promise<boolean> {
    const row = await authPasswordRepository.findByUserId(userId)
    return !!row
  },
}

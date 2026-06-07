/**
 * Single service for provider (email, phone, Google, Facebook, Apple) bind/unbind
 * and validation. Used by auth-v2 (email/phone bind after OTP) and oauth (social bind/unbind).
 */

import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import { cacheService } from './cache.service'
import { AppError } from '../middlewares/errorHandler'
import { emailSchema, phoneSchema } from '../models/schemas'
import type { AuthProvider } from '../models/types'

const SOCIAL_PROVIDERS: AuthProvider[] = ['google', 'facebook', 'apple']

export const providerService = {
  /**
   * Validate identifier format for email or phone. Throws AppError if invalid.
   */
  validateProvider(provider: AuthProvider, identifier: string): void {
    if (provider === 'email') {
      const r = emailSchema.safeParse(identifier)
      if (!r.success)
        throw new AppError(400, 'Invalid email format', 'INVALID_EMAIL', { field: 'identifier' })
    } else if (provider === 'phone') {
      const r = phoneSchema.safeParse(identifier)
      if (!r.success)
        throw new AppError(400, 'Invalid phone format (E.164)', 'INVALID_PHONE', {
          field: 'identifier',
        })
    }
  },

  /**
   * Bind provider to user: validate uniqueness, create auth identifier, invalidate cache.
   * Caller is responsible for audit logging.
   */
  async bindProvider(
    userId: string,
    provider: AuthProvider,
    identifier: string,
    options?: { isVerified?: boolean; isPrimary?: boolean },
  ): Promise<void> {
    const existing = await authIdentifierRepository.findByProviderAndIdentifier(
      provider,
      identifier,
    )
    if (existing) {
      if (existing.userId === userId) {
        if (provider === 'email')
          throw new AppError(400, 'Email already bound to current user', 'EMAIL_ALREADY_BOUND')
        if (provider === 'phone')
          throw new AppError(400, 'Phone already bound to current user', 'PHONE_ALREADY_BOUND')
        throw new AppError(400, `${provider} already linked to this account`, 'ALREADY_BOUND')
      }
      if (provider === 'email')
        throw new AppError(400, 'Email already in use by another user', 'EMAIL_TAKEN')
      if (provider === 'phone') throw new AppError(400, 'Phone already in use', 'PHONE_TAKEN')
      throw new AppError(
        400,
        `${provider} account already linked to another user`,
        'PROVIDER_LINKED',
      )
    }
    const ids = await authIdentifierRepository.findByUserId(userId)
    if (ids.some((a) => a.provider === provider)) {
      throw new AppError(400, `User already has ${provider} linked`, 'ALREADY_BOUND')
    }
    await authIdentifierRepository.create({
      userId,
      provider,
      identifier,
      isVerified: options?.isVerified ?? true,
      verifiedAt: options?.isVerified ? new Date() : undefined,
      isPrimary: options?.isPrimary ?? false,
    })
    await cacheService.invalidateUserAuthIdentifiers(userId)
  },

  /**
   * Unbind social provider (Google, Facebook, Apple). Email/phone cannot be unbound.
   * User must retain at least one auth method. Caller is responsible for audit logging.
   */
  async unbindProvider(userId: string, provider: AuthProvider): Promise<void> {
    if (!SOCIAL_PROVIDERS.includes(provider)) {
      throw new AppError(
        400,
        'Email and phone cannot be unbound; use modify instead',
        'INVALID_REQUEST',
      )
    }
    const ids = await authIdentifierRepository.findByUserId(userId)
    const toRemove = ids.find((a) => a.provider === provider)
    if (!toRemove) throw new AppError(400, `${provider} not bound to current user`, 'NOT_BOUND')
    const remaining = ids.filter((a) => a.provider !== provider)
    const hasEmailOrPhone = remaining.some((a) => a.provider === 'email' || a.provider === 'phone')
    if (!hasEmailOrPhone && remaining.length === 0) {
      throw new AppError(
        400,
        'Cannot unbind - user must have at least one auth method',
        'LAST_METHOD',
      )
    }
    await authIdentifierRepository.deleteByUserIdAndProvider(userId, provider)
    await cacheService.invalidateUserAuthIdentifiers(userId)
  },
}

import { prisma, prismaRead } from '../config/database'
import type { AuthProvider } from '../models/types'
import { normalizeAuthIdentifier, normalizeIdentifierGuess } from '../utils/auth-identifier'

/**
 * Every identifier that reaches the DB goes through `normalizeAuthIdentifier` here, so emails are
 * stored and looked up lower-case regardless of how the caller spelt them. Callers still normalise
 * at their own boundary when they derive Redis/OTP keys from the raw value.
 */
export const authIdentifierRepository = {
  async findByProviderAndIdentifier(provider: AuthProvider, identifier: string) {
    return prismaRead.authIdentifier.findUnique({
      where: {
        provider_identifier: {
          provider,
          identifier: normalizeAuthIdentifier(provider, identifier),
        },
      },
      include: { user: true },
    })
  },

  /**
   * Password-login lookup: credential row + full user + password hash in one round-trip.
   * Reads the primary so a just-changed password is never compared against a stale replica hash.
   */
  async findForLoginWithPassword(provider: AuthProvider, identifier: string) {
    return prisma.authIdentifier.findUnique({
      where: {
        provider_identifier: {
          provider,
          identifier: normalizeAuthIdentifier(provider, identifier),
        },
      },
      include: { user: { include: { authPassword: true } } },
    })
  },

  async findByIdentifier(identifier: string) {
    return prismaRead.authIdentifier.findFirst({
      where: { identifier: normalizeIdentifierGuess(identifier) },
      include: { user: true },
    })
  },

  async findById(id: string) {
    return prismaRead.authIdentifier.findUnique({
      where: { id },
      include: { user: true },
    })
  },

  async findByUserId(userId: string) {
    return prismaRead.authIdentifier.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })
  },

  async create(data: {
    userId: string
    provider: AuthProvider
    identifier: string
    isVerified?: boolean
    verifiedAt?: Date | null
    isPrimary?: boolean
  }) {
    return prisma.authIdentifier.create({
      data: {
        userId: data.userId,
        provider: data.provider,
        identifier: normalizeAuthIdentifier(data.provider, data.identifier),
        isVerified: data.isVerified ?? false,
        verifiedAt: data.verifiedAt ?? undefined,
        isPrimary: data.isPrimary ?? false,
      },
    })
  },

  async updateVerified(userId: string, provider: AuthProvider) {
    return prisma.authIdentifier.updateMany({
      where: { userId, provider },
      data: { isVerified: true, verifiedAt: new Date() },
    })
  },

  async updateIdentifier(
    userId: string,
    provider: AuthProvider,
    newIdentifier: string,
    version: number,
  ) {
    const updated = await prisma.authIdentifier.updateMany({
      where: { userId, provider, version },
      data: {
        identifier: normalizeAuthIdentifier(provider, newIdentifier),
        version: { increment: 1 },
        isVerified: true,
        verifiedAt: new Date(),
      },
    })
    return updated.count > 0
  },

  async deleteByUserIdAndProvider(userId: string, provider: AuthProvider) {
    return prisma.authIdentifier.deleteMany({
      where: { userId, provider },
    })
  },
}

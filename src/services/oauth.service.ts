/**
 * OAuth token verification (Google, Facebook, Apple) and link/unlink to user.
 */

import * as admin from 'firebase-admin'
import axios from 'axios'
import { env } from '../config/env'
import { prisma } from '../config/database'
import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import { publicIdService } from '../services/public-id.service'
import { userPublicIdService } from '../services/user-public-id.service'
import { sessionService } from '../services/session.service'
import { auditService } from '../services/audit.service'
import { providerService } from '../services/provider.service'
import { AppError } from '../middlewares/errorHandler'
import type { AuthProvider } from '../models/types'
import { displayNameFromUser } from '../utils/profileDisplay'

export interface OAuthUserInfo {
  email: string | null
  providerId: string
  provider: 'google' | 'facebook' | 'apple'
}

function getFirebaseAuth(): admin.auth.Auth {
  if (!admin.apps.length) {
    if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
      throw new AppError(503, 'OAuth not configured', 'OAUTH_NOT_CONFIGURED')
    }
    const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    })
  }
  return admin.auth()
}

/** Verify Google ID token via Firebase; returns email and provider id. */
export async function verifyGoogleToken(idToken: string): Promise<OAuthUserInfo> {
  try {
    const auth = getFirebaseAuth()
    const decoded = await auth.verifyIdToken(idToken) as { uid: string; email?: string }
    const email = decoded.email ?? null
    return { email, providerId: decoded.uid, provider: 'google' }
  } catch {
    throw new AppError(401, 'Invalid Google token', 'INVALID_OAUTH_TOKEN')
  }
}

/** Verify Facebook access token via Graph API; returns id and optional email. */
export async function verifyFacebookToken(accessToken: string): Promise<OAuthUserInfo> {
  try {
    const res = await axios.get<{ id?: string; email?: string }>(
      `https://graph.facebook.com/me?fields=id,email&access_token=${encodeURIComponent(accessToken)}`,
      { timeout: 5000 },
    )
    const id = res.data?.id
    const email = res.data?.email ?? null
    if (!id) throw new AppError(401, 'Invalid Facebook token', 'INVALID_OAUTH_TOKEN')
    return { email, providerId: id, provider: 'facebook' }
  } catch {
    throw new AppError(401, 'Invalid Facebook token', 'INVALID_OAUTH_TOKEN')
  }
}

/** Verify Apple identity token via Firebase; returns sub/uid and optional email. */
export async function verifyAppleToken(identityToken: string): Promise<OAuthUserInfo> {
  try {
    const auth = getFirebaseAuth()
    const decoded = await auth.verifyIdToken(identityToken) as { uid: string; sub?: string; email?: string }
    const email = decoded.email ?? null
    return { email, providerId: decoded.sub ?? decoded.uid, provider: 'apple' }
  } catch {
    throw new AppError(401, 'Invalid Apple token', 'INVALID_OAUTH_TOKEN')
  }
}

/**
 * OAuth login/signup and provider bind/unlink. Invalidates user auth identifiers cache on bind/unbind.
 */
export const oauthService = {
  /**
   * Login with existing linked account or signup new user; create session and audit.
   * @throws ACCOUNT_SUSPENDED | EMAIL_LINKED (if email taken by another user)
   */
  async loginOrSignup(
    provider: 'google' | 'facebook' | 'apple',
    userInfo: OAuthUserInfo,
    deviceName: string,
    deviceId: string,
    ipAddress: string,
    userAgent?: string | null,
  ) {
    const identifier = userInfo.email ?? userInfo.providerId
    const existing = await authIdentifierRepository.findByProviderAndIdentifier(provider, identifier)
    if (existing) {
      const user = existing.user
      if (user.status === 'deactivating') {
        throw new AppError(
          403,
          'Account scheduled for deletion. You can reactivate it in account settings.',
          'ACCOUNT_DEACTIVATING',
          { canReactivate: true },
        )
      }
      if (user.status === 'deleted') {
        throw new AppError(403, 'Account has been permanently deleted.', 'ACCOUNT_DELETED')
      }
      if (user.status === 'suspended') throw new AppError(403, 'Account suspended', 'ACCOUNT_SUSPENDED')
      const tokens = await sessionService.createSession({
        userId: user.id,
        publicId: Number(user.publicId),
        passwordSet: user.passwordSet,
        deviceName,
        deviceId,
        ipAddress,
        userAgent,
        loginType: provider,
        displayName: displayNameFromUser(user),
        avatarUrl: user.avatarUrl,
      })
      await auditService.log({
        userId: user.id,
        actionType: 'login',
        actionStatus: 'success',
        actionDetails: { method: 'oauth', provider },
        ipAddress,
        userAgent: userAgent ?? undefined,
        deviceId,
      })
      return {
        userId: user.id,
        publicId: Number(user.publicId),
        status: user.status,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        passwordSet: user.passwordSet,
        sessionId: tokens.sessionId,
        ...(user.status === 'new' && { nextStep: 'complete_profile' as const }),
      }
    }
    if (userInfo.email) {
      const emailTaken = await authIdentifierRepository.findByProviderAndIdentifier('email', userInfo.email)
      if (emailTaken && emailTaken.userId) throw new AppError(409, 'Email already linked to another account', 'EMAIL_LINKED')
    }
    const { publicId } = await publicIdService.getNextPublicId('')
    const username = userInfo.email ? userInfo.email.split('@')[0]! : `user_${userInfo.providerId.slice(0, 8)}`
    const user = await prisma.user.create({
      data: {
        username,
        publicId,
        defaultPublicId: publicId,
        status: 'new',
        passwordSet: false,
      },
    })
    void userPublicIdService.setOriginalPublicId(user.id, publicId).catch((err) => {
      console.error(`[public-id] Failed to store originalPublicId for ${user.id}`, err)
    })
    await prisma.authIdentifier.create({
      data: {
        userId: user.id,
        provider,
        identifier,
        isVerified: true,
        verifiedAt: new Date(),
        isPrimary: true,
      },
    })
    const tokens = await sessionService.createSession({
      userId: user.id,
      publicId: Number(publicId),
      passwordSet: false,
      deviceName,
      deviceId,
      ipAddress,
      userAgent,
      loginType: provider,
      displayName: displayNameFromUser(user),
      avatarUrl: user.avatarUrl,
    })
    await auditService.log({
      userId: user.id,
      actionType: 'login',
      actionStatus: 'success',
      actionDetails: { method: 'oauth', provider, isNewUser: true },
      ipAddress,
      userAgent: userAgent ?? undefined,
      deviceId,
    })
    return {
      userId: user.id,
      publicId: Number(publicId),
      status: 'new' as const,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      passwordSet: false,
      sessionId: tokens.sessionId,
      nextStep: 'complete_profile' as const,
    }
  },

  /** Link OAuth provider to user; invalidates user auth identifiers cache. */
  async bindProvider(userId: string, provider: AuthProvider, userInfo: OAuthUserInfo) {
    const identifier = userInfo.email ?? userInfo.providerId
    await providerService.bindProvider(userId, provider, identifier, { isVerified: true, isPrimary: false })
    await auditService.log({
      userId,
      actionType: 'provider_bind',
      actionStatus: 'success',
      actionDetails: { provider, identifier },
    })
    return { message: `${provider} account linked successfully`, provider, identifier }
  },

  /** Unlink provider; user must retain at least one auth method. Invalidates identifiers cache. */
  async unbindProvider(userId: string, provider: AuthProvider) {
    await providerService.unbindProvider(userId, provider)
    await auditService.log({
      userId,
      actionType: 'provider_unbind',
      actionStatus: 'success',
      actionDetails: { provider },
    })
    return { message: `${provider} account unlinked successfully` }
  },
}

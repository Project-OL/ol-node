/**
 * OAuth token verification (Google, Facebook, Apple) and link/unlink to user.
 */

import * as admin from 'firebase-admin'
import { OAuth2Client } from 'google-auth-library'
import axios from 'axios'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { prisma } from '../config/database'
import { authIdentifierRepository } from '../repositories/auth-identifier.repository'
import { publicIdService } from '../services/public-id.service'
import { userPublicIdService } from '../services/user-public-id.service'
import { sessionService } from '../services/session.service'
import { deviceService } from '../services/device.service'
import { auditService } from '../services/audit.service'
import { platformConversationsService } from '../services/platformConversations.service'
import { cacheService } from '../services/cache.service'
import { providerService } from '../services/provider.service'
import { AppError } from '../middlewares/errorHandler'
import type { AuthProvider } from '../models/types'
import { displayNameFromUser } from '../utils/profileDisplay'
import { ensureUserMayAuthenticate } from '../utils/user-account-status'

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

function googleIdTokenIss(idToken: string): string | null {
  try {
    const payload = jwt.decode(idToken) as { iss?: string } | null
    return typeof payload?.iss === 'string' ? payload.iss : null
  } catch {
    return null
  }
}

/**
 * Verify Google login token and return stable subject (`sub`) as providerId.
 * - Firebase Auth ID tokens (`iss` contains securetoken.google.com): Firebase Admin.
 * - Google Sign-In ID tokens (`iss` accounts.google.com): OAuth2 verify with configured client IDs as audience.
 */
export async function verifyGoogleToken(idToken: string): Promise<OAuthUserInfo> {
  const iss = googleIdTokenIss(idToken)
  if (!iss) throw new AppError(401, 'Invalid Google token', 'INVALID_OAUTH_TOKEN')

  if (iss.includes('securetoken.google.com')) {
    try {
      const auth = getFirebaseAuth()
      const decoded = await auth.verifyIdToken(idToken)
      const sub = decoded.sub ?? decoded.uid
      return { email: decoded.email ?? null, providerId: sub, provider: 'google' }
    } catch {
      throw new AppError(401, 'Invalid Google token', 'INVALID_OAUTH_TOKEN')
    }
  }

  if (iss === 'https://accounts.google.com' || iss === 'accounts.google.com') {
    const audience = [
      env.GOOGLE_OAUTH_WEB_CLIENT_ID,
      env.GOOGLE_OAUTH_ANDROID_CLIENT_ID,
      env.GOOGLE_OAUTH_IOS_CLIENT_ID,
    ].filter((x): x is string => Boolean(x))
    if (audience.length === 0) {
      throw new AppError(503, 'OAuth not configured', 'OAUTH_NOT_CONFIGURED')
    }
    try {
      const client = new OAuth2Client()
      const ticket = await client.verifyIdToken({ idToken, audience })
      const payload = ticket.getPayload()
      if (!payload?.sub) throw new AppError(401, 'Invalid Google token', 'INVALID_OAUTH_TOKEN')
      return { email: payload.email ?? null, providerId: payload.sub, provider: 'google' }
    } catch {
      throw new AppError(401, 'Invalid Google token', 'INVALID_OAUTH_TOKEN')
    }
  }

  throw new AppError(401, 'Invalid Google token', 'INVALID_OAUTH_TOKEN')
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
    const decoded = (await auth.verifyIdToken(identityToken)) as {
      uid: string
      sub?: string
      email?: string
    }
    const email = decoded.email ?? null
    return { email, providerId: decoded.sub ?? decoded.uid, provider: 'apple' }
  } catch {
    throw new AppError(401, 'Invalid Apple token', 'INVALID_OAUTH_TOKEN')
  }
}

async function findExistingOAuthAccount(
  provider: 'google' | 'facebook' | 'apple',
  userInfo: OAuthUserInfo,
) {
  let row = await authIdentifierRepository.findByProviderAndIdentifier(
    provider,
    userInfo.providerId,
  )
  if (row) return row
  if (userInfo.email) {
    row = await authIdentifierRepository.findByProviderAndIdentifier(provider, userInfo.email)
  }
  return row ?? null
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
    const existing = await findExistingOAuthAccount(provider, userInfo)
    if (existing && existing.identifier !== userInfo.providerId) {
      await prisma.authIdentifier.update({
        where: { id: existing.id },
        data: { identifier: userInfo.providerId },
      })
      await cacheService.invalidateUserAuthIdentifiers(existing.userId)
    }
    if (existing) {
      const user = existing.user
      await ensureUserMayAuthenticate(user)
      await deviceService.linkAccountToDevice(deviceId, user.id)
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
        isSupport: user.isSupport ?? false,
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
      const emailTaken = await authIdentifierRepository.findByProviderAndIdentifier(
        'email',
        userInfo.email,
      )
      if (emailTaken && emailTaken.userId)
        throw new AppError(409, 'Email already linked to another account', 'EMAIL_LINKED')
    }
    const { publicId } = await publicIdService.getNextPublicId('')
    const username = userInfo.email
      ? userInfo.email.split('@')[0]!
      : `user_${userInfo.providerId.slice(0, 8)}`
    const user = await prisma.user.create({
      data: {
        username,
        publicId,
        defaultPublicId: publicId,
        status: 'new',
        passwordSet: false,
      },
    })
    void platformConversationsService.provisionForNewUser(user.id).catch((err) => {
      console.error(`[platform-inbox] provision failed for ${user.id}`, err)
    })
    void userPublicIdService.setOriginalPublicId(user.id, publicId).catch((err) => {
      console.error(`[public-id] Failed to store originalPublicId for ${user.id}`, err)
    })
    await prisma.authIdentifier.create({
      data: {
        userId: user.id,
        provider,
        identifier: userInfo.providerId,
        isVerified: true,
        verifiedAt: new Date(),
        isPrimary: true,
      },
    })
    await deviceService.linkAccountToDevice(deviceId, user.id)
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
      isSupport: false,
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
    const identifier = userInfo.providerId
    await providerService.bindProvider(userId, provider, identifier, {
      isVerified: true,
      isPrimary: false,
    })
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

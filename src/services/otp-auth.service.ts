/**
 * OTP for auth: signup, login, reset, bind, modify.
 * Uses HMAC-SHA256 for fast OTP storage/verify; static OTP in dev (STATIC_OTP_DEV) uses same path.
 */

import { createHmac, timingSafeEqual, randomInt } from 'crypto'
import { env } from '../config/env'
import { otpTokenRepository } from '../repositories/otp-token.repository'
import type { OtpPurpose } from '../models/types'

const OTP_VALIDITY_MS = 5 * 60 * 1000

function getOtpHmacSecret(): string {
  return env.JWT_ACCESS_SECRET
}

/** Hash OTP with HMAC-SHA256 (fast, constant-time compare). Never store plain OTP. */
function hashOtp(otp: string): string {
  return createHmac('sha256', getOtpHmacSecret()).update(otp).digest('hex')
}

/** Constant-time compare of OTP hash. */
function verifyOtpHash(plainOtp: string, storedHash: string): boolean {
  const computed = hashOtp(plainOtp)
  if (computed.length !== storedHash.length) return false
  try {
    return timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHash, 'hex'))
  } catch {
    return false
  }
}

/** Generate 5-digit OTP. */
function generateOtp(): string {
  return String(randomInt(10000, 99999))
}

export const otpAuthService = {
  async createAndStore(params: {
    targetIdentifier: string
    purpose: OtpPurpose
    userId?: string | null
  }): Promise<{ expiresAt: Date }> {
    const otp = env.STATIC_OTP_DEV ?? generateOtp()
    const otpHash = hashOtp(otp)
    const expiresAt = new Date(Date.now() + OTP_VALIDITY_MS)
    await otpTokenRepository.create({
      userId: params.userId ?? undefined,
      otpHash,
      otpPurpose: params.purpose,
      targetIdentifier: params.targetIdentifier,
      expiresAt,
    })
    return { expiresAt }
  },

  async verify(params: {
    targetIdentifier: string
    purpose: OtpPurpose
    otp: string
    userId?: string | null
  }): Promise<boolean> {
    const record = await otpTokenRepository.findValid(
      params.targetIdentifier,
      params.purpose,
      params.userId,
    )
    if (!record) return false
    const match = verifyOtpHash(params.otp, record.otpHash)
    if (!match) {
      await otpTokenRepository.incrementAttempt(record.id)
      return false
    }
    await otpTokenRepository.markUsed(record.id)
    return true
  },
}

import { redisClient, RedisKeys } from '../config/redis'
import { publishServerFrameToUser } from '../utils/ws-publisher'
import { meService } from './me.service'

/**
 * Post-commit after a face profile is marked REVOKED.
 * Login sessions stay valid — do not bump tokenVersion / revoke JWTs.
 * Bust /me caches and notify the connected app to re-register face.
 */
export async function afterFaceProfileRevoked(userId: string): Promise<void> {
  await meService.invalidateUserCaches(userId)
  await redisClient.del(RedisKeys.faceVerifyLastPass(userId)).catch(() => undefined)
  await publishServerFrameToUser(userId, {
    t: 'FACE_REGISTRATION',
    event: 'face.registration.revoked',
    sessionId: userId,
    detail: {
      canReRegister: true,
      sessionValid: true,
    },
  }).catch(() => undefined)
}

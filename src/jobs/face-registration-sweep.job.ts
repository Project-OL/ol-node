/**
 * Periodic self-healing sweep: auto-EXPIRE non-terminal face_registration_sessions
 * rows older than FACE_REGISTRATION_SESSION_STALE_MINUTES. Without this, a client that
 * hangs mid-flow (the native liveness SDK never calling back, a worker outage while a
 * job is mid-flight) leaves the user stuck seeing PENDING_INDEX / canReRegister: false
 * indefinitely -- previously only fixable via the admin clear action. Complements, does
 * not replace, that admin tooling.
 */

import { env } from '../config/env'
import { faceRegistrationRepository } from '../repositories/faceRegistration.repository'

export async function runFaceRegistrationSweepJob(): Promise<void> {
  try {
    const count = await faceRegistrationRepository.expireStaleSessions(
      env.FACE_REGISTRATION_SESSION_STALE_MINUTES,
    )
    if (count > 0) {
      console.info(`[Face Registration Sweep] Auto-expired ${count} stale session(s)`)
    }
  } catch (err) {
    console.error('[Face Registration Sweep] Failed:', err)
  }
}

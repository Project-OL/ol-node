/**
 * Extension hooks for passive / heuristic anti-spoof layers (texture, replay, EXIF, depth).
 * Implementations can be registered later; default pipeline only uses AWS Face Liveness + DetectFaces.
 */
export type FaceRegistrationAntispoofFrame = {
  label: 'reference' | 'audit'
  index: number
  bytes: Uint8Array
}

export type FaceRegistrationAntispoofContext = {
  userId: string
  sessionId: string
  frames: FaceRegistrationAntispoofFrame[]
}

export type FaceRegistrationAntispoofHook = (
  ctx: FaceRegistrationAntispoofContext,
) => Promise<{ ok: true } | { ok: false; reason: string }>

/** Register additional checks here (sync/async). Empty = AWS-only trust boundary. */
export const faceRegistrationAntispoofHooks: FaceRegistrationAntispoofHook[] = []

export async function runFaceRegistrationAntispoofHooks(
  ctx: FaceRegistrationAntispoofContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const hook of faceRegistrationAntispoofHooks) {
    const r = await hook(ctx)
    if (!r.ok) return r
  }
  return { ok: true }
}

import { redisClient } from '../config/redis'

/**
 * Billable/effective live seconds: wall-clock minus camera-off / other uncounted time.
 * Shared with Live-server host-stats and admin live stop.
 */
export function computeEffectiveDurationSeconds(
  startedAt: Date,
  endedAt: Date,
  uncountedSeconds: number,
): number {
  const grossDurationSeconds = Math.max(
    0,
    Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
  )
  const uncountedSec = Math.max(0, Math.floor(Number(uncountedSeconds)) || 0)
  return Math.max(0, grossDurationSeconds - uncountedSec)
}

/**
 * Redis uncounted seconds for an active room (`streamId` / LiveKit room id).
 * Includes excess camera-off beyond a 60s grace when `stream:camera_off_at` is set.
 */
export async function readUncountedLiveSeconds(roomId: string, asOf: Date): Promise<number> {
  const uncountedRaw = await redisClient.get(`stream:uncounted_seconds:${roomId}`)
  const cameraOffAt = await redisClient.get(`stream:camera_off_at:${roomId}`)
  let uncountedSec = parseInt(uncountedRaw ?? '0', 10) || 0
  if (cameraOffAt) {
    const offSec = Math.floor((asOf.getTime() - Number(cameraOffAt)) / 1000)
    if (offSec > 60) uncountedSec += offSec - 60
  }
  return uncountedSec
}

/** Provisional effective seconds for an in-progress session (DB field is 0 until end). */
export async function provisionalEffectiveDurationSeconds(
  roomId: string,
  startedAt: Date,
  asOf: Date = new Date(),
): Promise<number> {
  const uncounted = await readUncountedLiveSeconds(roomId, asOf)
  return computeEffectiveDurationSeconds(startedAt, asOf, uncounted)
}

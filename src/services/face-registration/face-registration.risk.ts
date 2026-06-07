/**
 * Lightweight risk score (0–100) for adaptive liveness thresholds.
 * Extend with device intelligence / IP reputation without blocking this module.
 */
export type FaceRegistrationRiskInput = {
  sessionsLast24h: number
  failedLivenessLast24h: number
  supplementalVideoProvided: boolean
}

export function computeFaceRegistrationRiskScore(input: FaceRegistrationRiskInput): number {
  let score = 0
  score += Math.min(40, input.sessionsLast24h * 8)
  score += Math.min(35, input.failedLivenessLast24h * 10)
  if (!input.supplementalVideoProvided) {
    score += 5
  }
  return Math.min(100, Math.round(score * 10) / 10)
}

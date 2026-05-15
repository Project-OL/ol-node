/**
 * Human-readable UX hints for the mobile client. Amazon Face Liveness runs its own
 * challenge in the SDK UI; these steps are for coaching + audit only.
 */
export const FACE_REGISTRATION_CHALLENGE_TYPES = [
  "blink_twice",
  "turn_head_left",
  "turn_head_right",
  "smile",
  "open_mouth",
  "raise_eyebrows",
  "look_up",
  "look_down",
] as const;

export type FaceRegistrationChallengeType = (typeof FACE_REGISTRATION_CHALLENGE_TYPES)[number];

export type ChallengeStep = { type: FaceRegistrationChallengeType; order: number };

/** Fisher–Yates shuffle (in-place copy). */
export function shuffleChallengeTypes<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * Random ordered sequence of 2–3 distinct challenges (never a fixed template).
 */
export function buildRandomChallengeSequence(
  opts?: { minSteps?: number; maxSteps?: number; rng?: () => number },
): ChallengeStep[] {
  const rng = opts?.rng ?? Math.random;
  const min = opts?.minSteps ?? 2;
  const max = opts?.maxSteps ?? 3;
  const n = min + Math.floor(rng() * (max - min + 1));
  const picked = shuffleChallengeTypes(FACE_REGISTRATION_CHALLENGE_TYPES, rng).slice(0, n);
  return picked.map((type, idx) => ({ type, order: idx + 1 }));
}

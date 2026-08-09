/**
 * Canonical unordered DIRECT pair key: `minUuid:maxUuid` (lexicographic).
 * Must match SQL backfill: LEAST(user_id) || ':' || GREATEST(user_id).
 */
export function makeDirectPairKey(userAId: string, userBId: string): string {
  if (userAId === userBId) {
    throw new Error('directPairKey requires two distinct users')
  }
  return userAId < userBId ? `${userAId}:${userBId}` : `${userBId}:${userAId}`
}

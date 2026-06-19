import { FACE_QUALITY_RECOMMENDATIONS } from '../../constants/face-registration-errors'
import { userRepository } from '../../repositories/user.repository'
import { pickPrimaryAuth } from '../../utils/face-auth-mask'

export type MatchedUserSummary = {
  userId: string
  name: string
  displayPublicId: string | null
  authMethod: string
  authValue: string
}

export type DuplicateMatchDetails = {
  matchedUser: MatchedUserSummary | null
  matchedUserId: string | null
  matchSimilarity: number | null
  action: string
}

export async function buildMatchedUserSummary(
  matchedUserId: string | null | undefined,
): Promise<MatchedUserSummary | null> {
  if (!matchedUserId) return null
  const user = await userRepository.findById(matchedUserId)
  if (!user) return null

  const name =
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.username || 'Unknown'
  const displayPublicId = user.currentVipPublicId
    ? String(user.currentVipPublicId)
    : user.publicId
      ? String(user.publicId)
      : null
  const auth = pickPrimaryAuth(user.authIdentifiers ?? [])

  return {
    userId: matchedUserId,
    name,
    displayPublicId,
    authMethod: auth?.authMethod ?? 'other',
    authValue: auth?.authValue ?? '****',
  }
}

export async function buildDuplicateMatchDetails(input: {
  matchedUserId: string | null | undefined
  matchSimilarity?: number | null
}): Promise<DuplicateMatchDetails> {
  const matchedUser = await buildMatchedUserSummary(input.matchedUserId)
  return {
    matchedUser,
    matchedUserId: input.matchedUserId ?? null,
    matchSimilarity: input.matchSimilarity ?? null,
    action: FACE_QUALITY_RECOMMENDATIONS.FACE_DUPLICATE_IDENTITY ?? 'Contact support if you believe this is an error.',
  }
}

export function duplicateDetailsForAppError(details: DuplicateMatchDetails): Record<string, unknown> {
  return {
    matchedUser: details.matchedUser,
    matchedUserId: details.matchedUserId,
    matchSimilarity: details.matchSimilarity,
    action: details.action,
    failedChecks: ['DUPLICATE'],
  }
}

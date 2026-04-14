import type { ActiveGuardianProfileDto } from '../models/profile.types'
import type { GalleryCompletionDto } from '../models/me.types'

export type UserCard = {
  /** Same as `userId` (UUID); included for picker UIs that expect `id`. */
  id: string
  userId: string
  username: string
  publicId: string
  name?: string
  displayName: string
  avatarUrl: string | null
  country?: string | null
  gender: string | null
  age: number | null
  livestreamLevel: number
  wealthLevel: number
  subscriberCount: number
  isFollowing: boolean
  isFollowedBy: boolean
  isFriend: boolean
  isSuperHost?: boolean
  activeGuardian?: ActiveGuardianProfileDto | null
  galleryCompletion?: GalleryCompletionDto
}

export type UserCardWithVisit = UserCard & { visitedAt: Date }

export type PaginatedResult<T> = {
  items: T[]
  nextCursor: string | null
  total: number
}


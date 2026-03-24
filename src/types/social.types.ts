export type UserCard = {
  userId: string
  publicId: string
  displayName: string
  avatarUrl: string | null
  gender: string | null
  age: number | null
  livestreamLevel: number
  wealthLevel: number
  subscriberCount: number
  isFollowing: boolean
  isFollowedBy: boolean
  isFriend: boolean
}

export type UserCardWithVisit = UserCard & { visitedAt: Date }

export type PaginatedResult<T> = {
  items: T[]
  nextCursor: string | null
  total: number
}


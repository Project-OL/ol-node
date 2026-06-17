import { postRepository } from '../repositories/post.repository'
import type { PostAuthor, PostResponse, TaggedUser } from '../types/post.types'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

export type PostWithRelations = NonNullable<Awaited<ReturnType<typeof postRepository.findById>>>

function computeAge(dob: Date | null): number | null {
  if (!dob) return null
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age >= 0 ? age : null
}

function toTaggedUser(user: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
}): TaggedUser {
  const displayName = buildUserDisplayName(user)

  return {
    userId: user.id,
    displayName,
    name: displayName,
    publicId: String(user.publicId),
    displayPublicId: resolveDisplayPublicId(user),
    avatarUrl: user.avatarUrl,
  }
}

function toPostAuthor(user: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
  gender: string | null
  dateOfBirth: Date | null
  country?: string | null
}): PostAuthor {
  return {
    ...toTaggedUser(user),
    gender: user.gender,
    age: computeAge(user.dateOfBirth),
    country: user.country ?? null,
  }
}

export function assemblePostResponse(
  post: PostWithRelations,
  options: { isLiked: boolean },
): PostResponse {
  const author = toPostAuthor(post.user)
  const tags: TaggedUser[] = post.tags.map((tag) => toTaggedUser(tag.taggedUser))

  return {
    postId: post.id,
    mediaUrl: post.mediaUrl,
    mediaType: post.mediaType,
    thumbnailUrl: post.thumbnailUrl,
    caption: post.caption ?? null,
    visibility: post.visibility,
    likesCount: post.likesCount,
    isLiked: options.isLiked,
    tags,
    author,
    createdAt: post.createdAt,
    subscriberOnly: post.subscriberOnly,
  }
}

export function assembleLockedPostResponse(
  post: PostWithRelations,
  options: { isLiked: boolean },
): PostResponse {
  const author = toPostAuthor(post.user)
  return {
    postId: post.id,
    mediaUrl: '',
    mediaType: post.mediaType,
    thumbnailUrl: post.thumbnailUrl,
    caption: null,
    visibility: post.visibility,
    likesCount: post.likesCount,
    isLiked: options.isLiked,
    tags: [],
    author,
    createdAt: post.createdAt,
    subscriberOnly: post.subscriberOnly,
    locked: true,
    previewUrl: null,
  }
}

/** Full unlocked card — subscription feed and other pre-authorized paths. */
export function assembleUnlockedPostResponse(
  post: PostWithRelations,
  isLiked: boolean,
): PostResponse {
  return assemblePostResponse(post, { isLiked })
}

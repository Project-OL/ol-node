import { postRepository } from '../repositories/post.repository'
import type { PostAuthor, PostResponse, TaggedUser } from '../types/post.types'

export type PostWithRelations = NonNullable<
  Awaited<ReturnType<typeof postRepository.findById>>
>

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
  avatarUrl: string | null
}): TaggedUser {
  const fullName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : user.firstName ?? user.lastName
  const trimmed = fullName?.trim()
  const displayName = trimmed && trimmed.length > 0 ? trimmed : user.username

  return {
    userId: user.id,
    displayName,
    publicId: String(user.publicId),
    avatarUrl: user.avatarUrl,
  }
}

function toPostAuthor(user: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  avatarUrl: string | null
  gender: string | null
  dateOfBirth: Date | null
}): PostAuthor {
  return {
    ...toTaggedUser(user),
    gender: user.gender,
    age: computeAge(user.dateOfBirth),
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

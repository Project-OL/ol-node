import type { PostVisibility } from '@prisma/client'

export type TaggedUser = {
  userId: string
  displayName: string
  publicId: string
  avatarUrl: string | null
}

export type PostAuthor = TaggedUser & {
  gender: string | null
  age: number | null
  country: string | null
}

export type PostResponse = {
  postId: string
  mediaUrl: string
  mediaType: 'IMAGE' | 'VIDEO'
  thumbnailUrl: string | null
  caption: string | null
  visibility: PostVisibility
  likesCount: number
  isLiked: boolean
  tags: TaggedUser[]
  author: PostAuthor
  createdAt: Date
  subscriberOnly: boolean
  locked?: boolean
  previewUrl?: string | null
}

export type CreatePostDto = {
  mediaKey: string
  caption?: string
  visibility?: PostVisibility
  taggedUserIds?: string[]
  subscriberOnly?: boolean
}

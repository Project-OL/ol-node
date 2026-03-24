import type { PostVisibility } from '@prisma/client'

export type TaggedUser = {
  userId: string
  displayName: string
  publicId: string
  avatarUrl: string | null
}

export type PostAuthor = TaggedUser

export type PostResponse = {
  postId: string
  mediaUrl: string
  caption: string | null
  visibility: PostVisibility
  likesCount: number
  isLiked: boolean
  tags: TaggedUser[]
  author: PostAuthor
  createdAt: Date
}

export type CreatePostDto = {
  mediaKey: string
  caption?: string
  visibility?: PostVisibility
  taggedUserIds?: string[]
}


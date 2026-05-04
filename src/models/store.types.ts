import type { StoreItemCategory } from '@prisma/client'

export type ActiveStoreItemDto = {
  userStoreItemId: string
  itemId: string
  name: string
  displayImageUrl: string
  effectUrl: string | null
  expiresAt: string
}

export type ActiveStoreItemsMap = Record<StoreItemCategory, ActiveStoreItemDto | null> & {
  rareId: string | null
}

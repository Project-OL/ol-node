import { redisClient, RedisKeys, RESTRICTED_IDENTITY_WORDS_TTL } from '../config/redis'
import { restrictedIdentityWordsRepository } from '../repositories/restrictedIdentityWords.repository'
import {
  assertIdentityNotRestricted,
  DEFAULT_RESTRICTED_IDENTITY_WORDS,
  normalizeRestrictedWordList,
} from '../utils/restricted-identity-words'

export type RestrictedIdentityWordsDto = {
  words: string[]
}

function cacheKey() {
  return RedisKeys.restrictedIdentityWords()
}

async function seedDefaultsIfEmpty(): Promise<void> {
  const count = await restrictedIdentityWordsRepository.count()
  if (count > 0) return
  await restrictedIdentityWordsRepository.insertMissing([...DEFAULT_RESTRICTED_IDENTITY_WORDS])
}

async function readActiveFromDb(): Promise<string[]> {
  await seedDefaultsIfEmpty()
  const rows = await restrictedIdentityWordsRepository.listActive()
  return rows.map((r) => r.word)
}

export const restrictedIdentityWordsService = {
  async getActiveWords(): Promise<string[]> {
    try {
      const hit = await redisClient.get(cacheKey())
      if (hit) {
        const parsed = JSON.parse(hit) as { words?: unknown }
        if (Array.isArray(parsed.words) && parsed.words.every((w) => typeof w === 'string')) {
          return parsed.words
        }
      }
    } catch {
      /* miss */
    }

    const words = await readActiveFromDb()
    try {
      await redisClient.setex(
        cacheKey(),
        RESTRICTED_IDENTITY_WORDS_TTL,
        JSON.stringify({ words }),
      )
    } catch {
      /* ignore */
    }
    return words
  },

  async listWords(): Promise<RestrictedIdentityWordsDto> {
    const words = await this.getActiveWords()
    return { words }
  },

  async replaceWords(raw: readonly string[]): Promise<RestrictedIdentityWordsDto> {
    const words = normalizeRestrictedWordList(raw)
    await restrictedIdentityWordsRepository.replaceAll(words)
    await this.bustCache()
    try {
      await redisClient.setex(
        cacheKey(),
        RESTRICTED_IDENTITY_WORDS_TTL,
        JSON.stringify({ words }),
      )
    } catch {
      /* ignore */
    }
    return { words }
  },

  async bustCache() {
    await redisClient.del(cacheKey())
  },

  async assertNotRestricted(
    text: string,
    opts?: { allowRestricted?: boolean },
  ): Promise<void> {
    if (opts?.allowRestricted) return
    const words = await this.getActiveWords()
    assertIdentityNotRestricted(text, words, opts)
  },

  async assertNamePartsNotRestricted(
    firstName: string | null | undefined,
    lastName?: string | null,
    opts?: { allowRestricted?: boolean },
  ): Promise<void> {
    if (opts?.allowRestricted) return
    if (firstName?.trim()) await this.assertNotRestricted(firstName, opts)
    if (lastName?.trim()) await this.assertNotRestricted(lastName, opts)
  },
}

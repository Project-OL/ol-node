import { describe, it, expect, vi } from 'vitest'

// F18: broadcast recipients are read page by page with an id cursor, with no 50k cap.
const { ids, findMany } = vi.hoisted(() => {
  const ids = Array.from({ length: 12_345 }, (_, i) => `u${String(i).padStart(6, '0')}`)
  const findMany = vi.fn(async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
    const start = args.cursor ? ids.indexOf(args.cursor.id) + (args.skip ?? 0) : 0
    return ids.slice(start, start + args.take).map((id) => ({ id }))
  })
  return { ids, findMany }
})
vi.mock('../../src/config/database', () => ({ prismaRead: { user: { findMany } } }))

import { pagedUsers } from '../../src/utils/paged-users'

describe('pagedUsers', () => {
  it('returns every user exactly once, in pages', async () => {
    const seen: string[] = []
    let pages = 0
    for await (const page of pagedUsers({}, { id: true }, 5_000)) {
      pages++
      seen.push(...page.map((u) => u.id))
    }
    expect(pages).toBe(3)
    expect(seen).toEqual(ids)
    expect(findMany).toHaveBeenCalledTimes(3)
    expect(findMany.mock.calls.every(([a]) => a.take === 5_000)).toBe(true)
  })
})

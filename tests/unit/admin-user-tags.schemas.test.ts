import { describe, it, expect } from 'vitest'
import { normalizeAdminTags } from '../../src/models/admin-user-tags.schemas'

describe('normalizeAdminTags', () => {
  it('trims and dedupes case-insensitively', () => {
    expect(normalizeAdminTags([' VIP ', 'vip', 'Risk', 'risk'])).toEqual(['VIP', 'Risk'])
  })

  it('drops empty strings', () => {
    expect(normalizeAdminTags(['', '  ', 'ok'])).toEqual(['ok'])
  })
})

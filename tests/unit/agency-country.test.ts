import { describe, it, expect } from 'vitest'
import { countriesMatch } from '../../src/utils/agency-country'

describe('countriesMatch', () => {
  it('matches identical non-empty countries', () => {
    expect(countriesMatch('IN', 'IN')).toBe(true)
  })

  it('does not match different countries', () => {
    expect(countriesMatch('IN', 'NP')).toBe(false)
  })

  it('returns false when either side is null or empty', () => {
    expect(countriesMatch(null, 'IN')).toBe(false)
    expect(countriesMatch('IN', null)).toBe(false)
    expect(countriesMatch('', 'IN')).toBe(false)
  })
})

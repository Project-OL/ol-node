import { describe, it, expect } from 'vitest'
import {
  normalizeCountry,
  normalizeCountryOptional,
  countriesMatch,
  countryEqualsFilter,
  countryCacheKeySegment,
} from '../../src/utils/agency-country'

describe('normalizeCountry', () => {
  it('Title-Cases and trims', () => {
    expect(normalizeCountry('INDIA')).toBe('India')
    expect(normalizeCountry('india')).toBe('India')
    expect(normalizeCountry('  India  ')).toBe('India')
  })

  it('collapses whitespace and Title-Cases multi-word names', () => {
    expect(normalizeCountry('united   states')).toBe('United States')
    expect(normalizeCountry('UNITED KINGDOM')).toBe('United Kingdom')
  })
})

describe('normalizeCountryOptional', () => {
  it('returns null for null, undefined, and blank', () => {
    expect(normalizeCountryOptional(null)).toBeNull()
    expect(normalizeCountryOptional(undefined)).toBeNull()
    expect(normalizeCountryOptional('')).toBeNull()
    expect(normalizeCountryOptional('   ')).toBeNull()
  })

  it('normalizes non-empty values', () => {
    expect(normalizeCountryOptional('india')).toBe('India')
  })
})

describe('countriesMatch', () => {
  it('matches case-insensitively', () => {
    expect(countriesMatch('India', 'india')).toBe(true)
    expect(countriesMatch('INDIA', 'India')).toBe(true)
    expect(countriesMatch('  india ', 'INDIA')).toBe(true)
  })

  it('rejects empty or different countries', () => {
    expect(countriesMatch(null, 'India')).toBe(false)
    expect(countriesMatch('', 'India')).toBe(false)
    expect(countriesMatch('India', 'Pakistan')).toBe(false)
  })
})

describe('countryEqualsFilter', () => {
  it('returns Title Case equals with insensitive mode', () => {
    expect(countryEqualsFilter('INDIA')).toEqual({
      equals: 'India',
      mode: 'insensitive',
    })
  })
})

describe('countryCacheKeySegment', () => {
  it('returns lowercase canonical segment', () => {
    expect(countryCacheKeySegment('INDIA')).toBe('india')
    expect(countryCacheKeySegment('United States')).toBe('united states')
  })
})

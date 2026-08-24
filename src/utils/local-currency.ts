/**
 * Display FX for withdrawal and agency point-transfer amounts.
 * Admin-managed `payroll_country_fx_rates` is the authority.
 * India / Nepal singleton columns remain fallbacks for stale cache.
 */

import { normalizeCountry } from './agency-country'

export type LocalFxQuote = {
  code: string
  rate: number
}

export type PayrollCountryFxDto = {
  country: string
  countryCode: string | null
  currencyCode: string
  ratePerUsd: number
  sortOrder: number
}

export type LocalFxRates = {
  inrPerUsd: number
  nprPerUsd?: number | null
  countryRates?: PayrollCountryFxDto[] | null
}

const CODE_ALIASES: Record<string, string[]> = {
  in: ['india', 'ind'],
  np: ['nepal', 'npl'],
}

function key(value: string): string {
  return value.trim().toLowerCase()
}

export function isNepalCountry(country: string | null | undefined): boolean {
  const k = country?.trim().toLowerCase() ?? ''
  return k === 'nepal' || k === 'np' || k === 'npl' || k.startsWith('nepal')
}

function rowMatches(row: PayrollCountryFxDto, country: string): boolean {
  const user = key(country)
  if (!user) return false
  if (key(row.country) === user) return true
  if (row.countryCode && key(row.countryCode) === user) return true
  const extras = row.countryCode ? CODE_ALIASES[key(row.countryCode)] : undefined
  return extras?.includes(user) === true
}

export function defaultCountryRates(rates?: {
  inrPerUsd?: number
  nprPerUsd?: number | null
}): PayrollCountryFxDto[] {
  return [
    {
      country: 'India',
      countryCode: 'IN',
      currencyCode: 'INR',
      ratePerUsd: rates?.inrPerUsd && rates.inrPerUsd > 0 ? rates.inrPerUsd : 94,
      sortOrder: 1,
    },
    {
      country: 'Nepal',
      countryCode: 'NP',
      currencyCode: 'NPR',
      ratePerUsd: rates?.nprPerUsd && rates.nprPerUsd > 0 ? rates.nprPerUsd : 150,
      sortOrder: 2,
    },
  ]
}

export function resolveLocalFx(
  country: string | null | undefined,
  rates: LocalFxRates,
): LocalFxQuote {
  const rows = rates.countryRates?.length ? rates.countryRates : defaultCountryRates(rates)
  if (country?.trim()) {
    const hit = rows.find((row) => rowMatches(row, country))
    if (hit && hit.ratePerUsd > 0) {
      return { code: hit.currencyCode.toUpperCase(), rate: hit.ratePerUsd }
    }
  }
  if (isNepalCountry(country)) {
    const npr = rows.find((r) => r.currencyCode.toUpperCase() === 'NPR')
    return { code: 'NPR', rate: npr?.ratePerUsd && npr.ratePerUsd > 0 ? npr.ratePerUsd : 150 }
  }
  const inr = rows.find((r) => r.currencyCode.toUpperCase() === 'INR')
  return {
    code: 'INR',
    rate:
      inr?.ratePerUsd && inr.ratePerUsd > 0
        ? inr.ratePerUsd
        : rates.inrPerUsd > 0
          ? rates.inrPerUsd
          : 94,
  }
}

export function formatLocalAmount(
  usd: number,
  fx: LocalFxQuote,
): { localCurrencyAmount: string; localCurrencyCode: string } {
  return {
    localCurrencyAmount: (usd * fx.rate).toFixed(2),
    localCurrencyCode: fx.code,
  }
}

export function formatCountryFxDto(row: {
  country: string
  countryCode: string | null
  currencyCode: string
  ratePerUsd: { toString(): string } | number
  sortOrder: number
}): PayrollCountryFxDto {
  return {
    country: row.country,
    countryCode: row.countryCode,
    currencyCode: row.currencyCode,
    ratePerUsd: Number(row.ratePerUsd.toString()),
    sortOrder: row.sortOrder,
  }
}

export function normalizeCountryFxInput(country: string): string {
  return normalizeCountry(country)
}

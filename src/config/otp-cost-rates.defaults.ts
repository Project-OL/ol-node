/**
 * Default per-country OTP cost overrides seeded via `npm run seed:otp-cost-rates`.
 *
 * WhatsApp: source https://msg91.com/pricing/whatsapp, "Authentication Rate" column
 * (INR), fetched 2026-09-02. Utility Rate equals Authentication Rate for every country
 * on that page as of the fetch date; OTP delivery uses the `otp_delivery` authentication
 * template, so only the authentication rate applies here. `rateMinor` = round(rate * 100)
 * (paise) — the published rate has more precision than an integer minor-unit column can
 * hold, so this rounds to the nearest paisa. Countries not listed fall back to the flat
 * `OTP_COST_WHATSAPP_MINOR` env default (the page's "Other" tier is ~56 paise, well above
 * that default — consider raising the env default to match if traffic to unlisted
 * countries is non-trivial).
 *
 * SMS: msg91.com's public SMS pricing pages are localized billing-plan pages for the
 * account's own country (India/Brazil/UAE/Philippines/Singapore/Spain/UK/US), not a
 * per-destination-country termination rate card — that data only exists inside the
 * authenticated MSG91 dashboard (Billing/Wallet) or a support-provided rate card. Seeding
 * SMS country rates from those pages would reintroduce the same wrong-number problem this
 * table exists to fix, so no SMS defaults are seeded yet — `sms` still uses the flat
 * `OTP_COST_SMS_MINOR` env default for every country until real per-country SMS rates are
 * supplied (see `SMS_RATE_MINOR_BY_COUNTRY` below).
 *
 * Re-fetch and re-run the seed periodically — MSG91/Meta revise these rates over time and
 * this snapshot will drift.
 */

function bulk(rateMinor: number, countries: string[]): Record<string, number> {
  return Object.fromEntries(countries.map((country) => [country, rateMinor]))
}

export const WHATSAPP_AUTH_RATE_MINOR_BY_COUNTRY: Record<string, number> = {
  // Individually priced markets
  IN: 12,
  US: 25,
  GB: 161,
  AE: 115,
  SA: 78,
  ZA: 56,
  ES: 146,
  TR: 39,
  AR: 191,
  BR: 50,
  CL: 147,
  CO: 6,
  EG: 26,
  FR: 220,
  DE: 403,
  ID: 183,
  IL: 39,
  IT: 220,
  MY: 103,
  MX: 62,
  NL: 367,
  NG: 49,
  PK: 40,
  PE: 147,
  RU: 293,
  HK: 191,
  SG: 117,
  HU: 256,
  PL: 89,
  RO: 212,
  QA: 88,

  // Africa regional tier (0.293 INR)
  ...bulk(29, [
    'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CM', 'TD', 'CG', 'ER', 'ET', 'GA', 'GM', 'GH', 'GW',
    'CI', 'KE', 'LS', 'LR', 'LY', 'MG', 'MW', 'ML', 'MR', 'MA', 'MZ', 'NA', 'NE', 'RW', 'SN',
    'SL', 'SO', 'SS', 'SD', 'SZ', 'TZ', 'TG', 'TN', 'UG', 'ZM',
  ]),

  // Asia-Pacific regional tier (0.8282 INR)
  ...bulk(83, [
    'AF', 'AU', 'BD', 'KH', 'CN', 'JP', 'LA', 'MN', 'NP', 'NZ', 'PG', 'PH', 'LK', 'TW', 'TJ',
    'TH', 'TM', 'UZ', 'VN',
  ]),

  // Europe regional tier A (1.5496 INR)
  ...bulk(155, [
    'AL', 'AM', 'AZ', 'BY', 'BG', 'HR', 'CZ', 'GE', 'GR', 'LV', 'LT', 'MD', 'MK', 'RS', 'SK',
    'SI', 'UA',
  ]),

  // Europe regional tier B (1.2516 INR)
  ...bulk(125, ['AT', 'BE', 'DK', 'FI', 'IE', 'NO', 'PT', 'SE', 'CH']),

  // Americas regional tier (0.8278 INR)
  ...bulk(83, [
    'BO', 'CR', 'EC', 'SV', 'GT', 'HT', 'HN', 'JM', 'DO', 'NI', 'PA', 'PY', 'PR', 'UY', 'VE',
  ]),

  // Middle East regional tier (0.6665 INR)
  ...bulk(67, ['BH', 'IQ', 'JO', 'KW', 'LB', 'OM', 'YE']),
}

/** Not seeded yet — see file header. Fill in once a real per-destination-country SMS rate card is available. */
export const SMS_RATE_MINOR_BY_COUNTRY: Record<string, number> = {}

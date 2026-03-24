/** Pure VIP pattern classification for sequential public IDs (no I/O). */

export enum VipTier {
  NONE = 'NONE',
  BRONZE = 'BRONZE',
  SILVER = 'SILVER',
  GOLD = 'GOLD',
  DIAMOND = 'DIAMOND',
}

export enum PriceGroup {
  STANDARD = 'STANDARD',
  PREMIUM_BRONZE = 'PREMIUM_BRONZE',
  PREMIUM_SILVER = 'PREMIUM_SILVER',
  PREMIUM_GOLD = 'PREMIUM_GOLD',
  PREMIUM_DIAMOND = 'PREMIUM_DIAMOND',
}

export interface VipClassification {
  isVip: boolean
  tier: VipTier
  priceGroup: PriceGroup
  matchedRules: string[]
  rarityScore: number
}

function allSameDigits(s: string): boolean {
  if (s.length === 0) return false
  const c0 = s[0]
  return [...s].every((ch) => ch === c0)
}

function isAscendingRun(s: string, len: number): boolean {
  if (len <= 0 || s.length < len) return false
  const sub = s.slice(0, len)
  for (let i = 1; i < len; i++) {
    const prev = Number(sub[i - 1])
    const curr = Number(sub[i])
    if (Number.isNaN(prev) || Number.isNaN(curr)) return false
    if ((curr - prev + 10) % 10 !== 1) return false
  }
  return true
}

function isDescendingRun(s: string, len: number): boolean {
  if (len <= 0 || s.length < len) return false
  const sub = s.slice(0, len)
  for (let i = 1; i < len; i++) {
    const prev = Number(sub[i - 1])
    const curr = Number(sub[i])
    if (Number.isNaN(prev) || Number.isNaN(curr)) return false
    if ((prev - curr + 10) % 10 !== 1) return false
  }
  return true
}

function isPalindrome(s: string): boolean {
  return s === [...s].reverse().join('')
}

function isDoubleCopy(s: string): boolean {
  if (s.length % 2 !== 0 || s.length === 0) return false
  const h = s.length / 2
  return s.slice(0, h) === s.slice(h)
}

function isAlternating(s: string): boolean {
  if (s.length < 2) return false
  if (allSameDigits(s)) return false
  const a = s[0]!
  const b = s[1]!
  if (a === b) return false
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== (i % 2 === 0 ? a : b)) return false
  }
  return true
}

function isHalvesRepeated(s: string): boolean {
  if (s.length % 2 !== 0 || s.length === 0) return false
  if (allSameDigits(s)) return false
  const h = s.length / 2
  const left = s.slice(0, h)
  const right = s.slice(h)
  if (!allSameDigits(left) || !allSameDigits(right)) return false
  return left[0] !== right[0]
}

function isPairedSequence(s: string): boolean {
  if (s.length % 2 !== 0 || s.length < 4) return false
  const pairCount = s.length / 2
  for (let i = 0; i < pairCount; i++) {
    if (s[2 * i] !== s[2 * i + 1]) return false
  }
  const digits = Array.from({ length: pairCount }, (_, i) => s[2 * i]!).join('')
  return (
    isAscendingRun(digits, pairCount) ||
    isDescendingRun(digits, pairCount)
  )
}

function endsWithNSame(s: string, n: number): boolean {
  if (n <= 0 || s.length < n) return false
  const tail = s.slice(-n)
  return allSameDigits(tail)
}

function startsWithNSame(s: string, n: number): boolean {
  if (n <= 0 || s.length < n) return false
  const head = s.slice(0, n)
  return allSameDigits(head)
}

function hasRunOfN(s: string, n: number): boolean {
  if (n <= 0) return true
  if (s.length < n) return false
  let run = 1
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1]) {
      run++
      if (run >= n) return true
    } else {
      run = 1
    }
  }
  return false
}

const VIP_RULES: ReadonlyArray<{
  name: string
  tier: VipTier
  check: (d: string) => boolean
}> = [
  { name: 'all-same-digits', tier: VipTier.DIAMOND, check: (d) => allSameDigits(d) },
  {
    name: 'full-ascending-sequence',
    tier: VipTier.DIAMOND,
    check: (d) => isAscendingRun(d, d.length),
  },
  {
    name: 'full-descending-sequence',
    tier: VipTier.DIAMOND,
    check: (d) => isDescendingRun(d, d.length),
  },
  { name: 'alternating-two-digit', tier: VipTier.DIAMOND, check: (d) => isAlternating(d) },
  { name: 'palindrome', tier: VipTier.GOLD, check: (d) => isPalindrome(d) },
  { name: 'double-copy', tier: VipTier.GOLD, check: (d) => isDoubleCopy(d) },
  { name: 'halves-repeated', tier: VipTier.GOLD, check: (d) => isHalvesRepeated(d) },
  { name: 'paired-sequential', tier: VipTier.GOLD, check: (d) => isPairedSequence(d) },
  {
    name: 'ends-with-4-same',
    tier: VipTier.SILVER,
    check: (d) => endsWithNSame(d, 4) && !allSameDigits(d),
  },
  {
    name: 'starts-with-4-same',
    tier: VipTier.SILVER,
    check: (d) => startsWithNSame(d, 4) && !allSameDigits(d),
  },
  {
    name: 'ascending-first-half',
    tier: VipTier.SILVER,
    check: (d) => {
      const half = d.length / 2
      if (!Number.isInteger(half) || half === 0) return false
      return isAscendingRun(d.slice(0, half), half)
    },
  },
  {
    name: 'descending-first-half',
    tier: VipTier.SILVER,
    check: (d) => {
      const half = d.length / 2
      if (!Number.isInteger(half) || half === 0) return false
      return isDescendingRun(d.slice(0, half), half)
    },
  },
  {
    name: 'run-of-4',
    tier: VipTier.BRONZE,
    check: (d) =>
      hasRunOfN(d, 4) && !endsWithNSame(d, 4) && !startsWithNSame(d, 4),
  },
  {
    name: 'ends-with-3-same',
    tier: VipTier.BRONZE,
    check: (d) => endsWithNSame(d, 3) && !endsWithNSame(d, 4),
  },
  {
    name: 'ascending-last-half',
    tier: VipTier.BRONZE,
    check: (d) => {
      const half = d.length / 2
      if (!Number.isInteger(half) || half === 0) return false
      return isAscendingRun(d.slice(half), half)
    },
  },
  {
    name: 'descending-last-half',
    tier: VipTier.BRONZE,
    check: (d) => {
      const half = d.length / 2
      if (!Number.isInteger(half) || half === 0) return false
      return isDescendingRun(d.slice(half), half)
    },
  },
]

function tierPriceAndRarity(tier: VipTier): Pick<VipClassification, 'priceGroup' | 'rarityScore'> {
  switch (tier) {
    case VipTier.NONE:
      return { priceGroup: PriceGroup.STANDARD, rarityScore: 0 }
    case VipTier.BRONZE:
      return { priceGroup: PriceGroup.PREMIUM_BRONZE, rarityScore: 30 }
    case VipTier.SILVER:
      return { priceGroup: PriceGroup.PREMIUM_SILVER, rarityScore: 55 }
    case VipTier.GOLD:
      return { priceGroup: PriceGroup.PREMIUM_GOLD, rarityScore: 80 }
    case VipTier.DIAMOND:
      return { priceGroup: PriceGroup.PREMIUM_DIAMOND, rarityScore: 100 }
    default:
      return { priceGroup: PriceGroup.STANDARD, rarityScore: 0 }
  }
}

/**
 * Classifies a public ID against the VIP rule table (pure, no side effects).
 */
export function classifyPublicId(publicId: bigint): VipClassification {
  const d = publicId.toString()
  const matchedRules: string[] = []
  let winningTier = VipTier.NONE

  for (const rule of VIP_RULES) {
    if (rule.check(d)) {
      matchedRules.push(rule.name)
      if (winningTier === VipTier.NONE) {
        winningTier = rule.tier
      }
    }
  }

  const { priceGroup, rarityScore } = tierPriceAndRarity(winningTier)
  return {
    isVip: winningTier !== VipTier.NONE,
    tier: winningTier,
    priceGroup,
    rarityScore,
    matchedRules,
  }
}

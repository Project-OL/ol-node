/** Mask auth identifiers for duplicate-face transparency responses. */
export function maskEmailForDisplay(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  if (!domain) return 'u****@example.com'
  const maskedLocal =
    local.length <= 1 ? `${local[0] ?? 'u'}****` : `${local[0]}****${local.slice(-1)}`
  return `${maskedLocal}@${domain}`
}

export function maskPhoneForDisplay(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  const prefix = digits.slice(0, 2)
  const suffix = digits.slice(-1)
  const middleLen = Math.max(0, digits.length - 3)
  return `+${prefix}${'X'.repeat(middleLen)}${suffix}`
}

export function pickPrimaryAuth(
  identifiers: { provider: string; identifier: string; isPrimary: boolean }[],
): { authMethod: 'phone' | 'email' | 'other'; authValue: string } | null {
  const sorted = [...identifiers].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  for (const row of sorted) {
    const p = row.provider.toLowerCase()
    if (p === 'phone') {
      return { authMethod: 'phone', authValue: maskPhoneForDisplay(row.identifier) }
    }
    if (p === 'email') {
      return { authMethod: 'email', authValue: maskEmailForDisplay(row.identifier) }
    }
  }
  const first = sorted[0]
  if (!first) return null
  return { authMethod: 'other', authValue: '****' }
}

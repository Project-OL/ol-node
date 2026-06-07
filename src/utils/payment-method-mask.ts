export type PaymentMethodLike = {
  id: string
  methodType: string
  epayEmail: string | null
  bankName: string | null
  bankAccountHolder: string | null
  accountHolderFirstName?: string | null
  accountHolderLastName?: string | null
  branch?: string | null
  bankAccountNumber: string | null
  bankIfscCode: string | null
  upiNumber: string | null
  registeredPhone: string | null
  registeredEmail: string | null
}

/** Last 4 digits only for account numbers (list/card display). */
export function maskAccountNumber(raw: string | null | undefined): string | undefined {
  if (!raw || raw.length < 4) return raw ?? undefined
  return `****${raw.slice(-4)}`
}

/** First two chars + *** + @domain for emails (or masked variant). */
export function maskEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const prefix = local.slice(0, Math.min(2, local.length))
  return `${prefix}***@${domain}`
}

function resolveFirstName(m: PaymentMethodLike): string | null {
  if (m.accountHolderFirstName) return m.accountHolderFirstName
  if (m.bankAccountHolder) {
    const parts = m.bankAccountHolder.trim().split(/\s+/)
    return parts[0] ?? null
  }
  return null
}

function resolveLastName(m: PaymentMethodLike): string | null {
  if (m.accountHolderLastName) return m.accountHolderLastName
  if (m.bankAccountHolder) {
    const parts = m.bankAccountHolder.trim().split(/\s+/)
    if (parts.length > 1) return parts.slice(1).join(' ')
  }
  return null
}

export function maskPaymentMethodForDisplay<T extends PaymentMethodLike>(
  m: T,
): T & {
  firstName?: string | null
  lastName?: string | null
  branch?: string | null
} {
  const firstName = resolveFirstName(m)
  const lastName = resolveLastName(m)
  return {
    ...m,
    firstName,
    lastName,
    branch: m.branch ?? null,
    bankAccountNumber: maskAccountNumber(m.bankAccountNumber) ?? m.bankAccountNumber,
    epayEmail: maskEmail(m.epayEmail) ?? m.epayEmail,
    registeredEmail: maskEmail(m.registeredEmail) ?? m.registeredEmail,
    registeredPhone: maskAccountNumber(m.registeredPhone) ?? m.registeredPhone,
  }
}

export function mapPaymentMethodFull(m: PaymentMethodLike) {
  if (m.methodType === 'EPAY') {
    return {
      methodType: 'EPAY' as const,
      epayEmail: m.epayEmail,
    }
  }
  const firstName = resolveFirstName(m)
  const lastName = resolveLastName(m)
  const holderName =
    m.bankAccountHolder ?? ([firstName, lastName].filter(Boolean).join(' ') || null)
  return {
    methodType: 'BANK' as const,
    firstName,
    lastName,
    holderName,
    bankName: m.bankName,
    branch: m.branch ?? null,
    accountNumber: m.bankAccountNumber,
    ifscCode: m.bankIfscCode,
    phone: m.registeredPhone,
    upiId: m.upiNumber,
    email: m.registeredEmail,
  }
}

export function mapPaymentMethodMaskedForHost(m: PaymentMethodLike) {
  if (m.methodType === 'EPAY') {
    return {
      methodType: 'EPAY' as const,
      epayEmail: maskEmail(m.epayEmail) ?? m.epayEmail,
    }
  }
  const firstName = resolveFirstName(m)
  const lastName = resolveLastName(m)
  return {
    methodType: 'BANK' as const,
    bankName: m.bankName,
    accountNumber: maskAccountNumber(m.bankAccountNumber) ?? m.bankAccountNumber,
    ifscCode: m.bankIfscCode,
    firstName,
    lastName,
    branch: m.branch ?? null,
  }
}

export function mapPaymentMethodMaskedForAgent(m: PaymentMethodLike) {
  const full = mapPaymentMethodFull(m)
  if (full.methodType === 'EPAY') {
    return {
      ...full,
      epayEmail: maskEmail(full.epayEmail) ?? full.epayEmail,
    }
  }
  return {
    ...full,
    accountNumber: maskAccountNumber(full.accountNumber ?? null) ?? full.accountNumber,
  }
}

export function mapPaymentMethodForAgent(
  m: PaymentMethodLike | null,
  assignmentStatus: string,
  expiresAt: Date,
): ReturnType<typeof mapPaymentMethodFull> | null {
  if (!m) return null
  const isPendingActive = assignmentStatus === 'PENDING' && expiresAt.getTime() > Date.now()
  return isPendingActive ? mapPaymentMethodFull(m) : mapPaymentMethodMaskedForAgent(m)
}

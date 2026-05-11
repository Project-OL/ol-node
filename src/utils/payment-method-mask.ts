export type PaymentMethodLike = {
  id: string;
  methodType: string;
  epayEmail: string | null;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  bankIfscCode: string | null;
  upiNumber: string | null;
  registeredPhone: string | null;
  registeredEmail: string | null;
};

/** Last 4 digits only for account numbers. */
export function maskAccountNumber(raw: string | null | undefined): string | undefined {
  if (!raw || raw.length < 4) return raw ?? undefined;
  return `****${raw.slice(-4)}`;
}

/** First two chars + *** + @domain for emails (or masked variant). */
export function maskEmail(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

export function maskPaymentMethodForDisplay<T extends PaymentMethodLike>(
  m: T,
): T {
  return {
    ...m,
    bankAccountNumber: maskAccountNumber(m.bankAccountNumber) ?? m.bankAccountNumber,
    epayEmail: maskEmail(m.epayEmail) ?? m.epayEmail,
    registeredEmail: maskEmail(m.registeredEmail) ?? m.registeredEmail,
    registeredPhone: maskAccountNumber(m.registeredPhone) ?? m.registeredPhone,
  };
}

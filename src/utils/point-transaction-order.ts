import { createHash } from 'crypto'

const ORDER_SUFFIX_DIGITS = 3

function orderSuffix(entryId: string): string {
  const hash = createHash('sha256').update(entryId).digest('hex')
  return String(parseInt(hash.slice(0, 8), 16) % 1000).padStart(ORDER_SUFFIX_DIGITS, '0')
}

/** Deterministic display order number: `YYMMDDHHmmss` + 3-digit suffix from entry id. */
export function formatPointTransactionOrderNumber(entryId: string, createdAt: Date): string {
  const d = createdAt
  const yy = String(d.getUTCFullYear()).slice(2)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yy}${mm}${dd}${hh}${mi}${ss}${orderSuffix(entryId)}`
}

/** Parse the UTC timestamp prefix from an order number (suffix ignored). */
export function parseOrderNumberTimestamp(orderNumber: string): Date | null {
  const trimmed = orderNumber.trim()
  if (!/^\d{15,}$/.test(trimmed)) return null

  const datePart = trimmed.slice(0, 12)
  const yy = 2000 + Number.parseInt(datePart.slice(0, 2), 10)
  const mm = Number.parseInt(datePart.slice(2, 4), 10) - 1
  const dd = Number.parseInt(datePart.slice(4, 6), 10)
  const hh = Number.parseInt(datePart.slice(6, 8), 10)
  const mi = Number.parseInt(datePart.slice(8, 10), 10)
  const ss = Number.parseInt(datePart.slice(10, 12), 10)

  const d = new Date(Date.UTC(yy, mm, dd, hh, mi, ss))
  if (Number.isNaN(d.getTime())) return null
  return d
}

export function matchesPointTransactionOrderNumber(
  entryId: string,
  createdAt: Date,
  orderNumber: string,
): boolean {
  return formatPointTransactionOrderNumber(entryId, createdAt) === orderNumber.trim()
}

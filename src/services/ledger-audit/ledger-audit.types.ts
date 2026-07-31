import type {
  LedgerAuditCategory,
  LedgerAuditSeverity,
  Prisma,
} from '@prisma/client'

export type LedgerAuditFlagDraft = {
  userId: string
  category: LedgerAuditCategory
  code: string
  severity: LedgerAuditSeverity
  fingerprint: string
  summary: string
  evidence: Prisma.InputJsonValue
  ledgerEntryId?: string | null
  pointLedgerEntryId?: string | null
  vipPurchaseId?: string | null
  windowStart: Date
  windowEnd: Date
}

export const LEDGER_AUDIT_CODES = {
  VIP_EXPIRY_MISMATCH: 'VIP_EXPIRY_MISMATCH',
  VIP_ACTIVE_WITHOUT_PURCHASE: 'VIP_ACTIVE_WITHOUT_PURCHASE',
  VIP_PURCHASE_WITHOUT_LEDGER: 'VIP_PURCHASE_WITHOUT_LEDGER',
  VIP_LEDGER_WITHOUT_PURCHASE: 'VIP_LEDGER_WITHOUT_PURCHASE',
  NON_APP_ADMIN_LEDGER: 'NON_APP_ADMIN_LEDGER',
  NON_APP_UNKNOWN_LEDGER: 'NON_APP_UNKNOWN_LEDGER',
  LEDGER_BALANCE_CHAIN_BREAK: 'LEDGER_BALANCE_CHAIN_BREAK',
} as const

export type LedgerAuditCode = (typeof LEDGER_AUDIT_CODES)[keyof typeof LEDGER_AUDIT_CODES]

export interface SupportSubType {
  key: string
  label: string
}

export interface SupportTypeConfig {
  key: string // mirrors SupportTicketType enum value exactly
  label: string
  subTypes: SupportSubType[]
}

export const SUPPORT_TYPE_CONFIG: SupportTypeConfig[] = [
  {
    key: 'CONSULT',
    label: 'Consult',
    subTypes: [
      { key: 'TOP_UP', label: 'Top Up' },
      { key: 'HOST_TALKS_REWARDS', label: 'Host Talks/Rewards' },
      { key: 'SOFTWARE_DEFECT', label: 'Software Defect' },
      { key: 'FEATURE_REQUESTS', label: 'Feature Requests' },
      { key: 'FACE_AUTHENTICATION', label: 'Face Authentication' },
      { key: 'LEAVE_AGENCY', label: 'Leave Agency' },
      { key: 'CHANGE_OF_DEVICE_COUNTRY', label: 'Change of Device/Country' },
      { key: 'APPEAL_ACCOUNT_SUSPENSION', label: 'Appeal of Account Suspension' },
      { key: 'FUN_ZONE', label: 'Fun Zone' },
      { key: 'ACCOUNT_AND_SECURITY', label: 'Account and Security' },
      { key: 'AGENCY_FORCE_EXIT', label: 'Agency force exit' },
      { key: 'ACCOUNT_HACKED', label: 'Account Hacked' },
      { key: 'PLATFORM_EXPAT', label: 'Platform Expat' },
      { key: 'OTHERS', label: 'Others' },
    ],
  },
  {
    key: 'REPORT_COMPLAINTS',
    label: 'Report Complaints',
    subTypes: [
      { key: 'ABUSE_MANAGEMENT', label: 'Abuse/Management' },
      { key: 'GIFT_FRAUD', label: 'Gift Fraud' },
      { key: 'IDENTITY_IMPERSONATION', label: 'Identity Impersonation' },
      { key: 'MULTIPLE_ACCOUNT', label: 'Multiple Account' },
      { key: 'TOPUP_FRAUD', label: 'Top-up Fraud' },
      { key: 'EXTERNAL_SITE_ADVERTISEMENT', label: 'External Site Advertisement' },
      { key: 'LIVE_BROADCAST_VIOLATION', label: 'Live Broadcast Violation' },
      { key: 'VIOLATION_OF_CHILD_SAFETY', label: 'Violation of Child Safety' },
      { key: 'REPORT_OTHERS', label: 'Report Others' },
    ],
  },
  {
    key: 'FEEDBACK',
    label: 'Feedback',
    subTypes: [
      { key: 'SOFTWARE_DEFECT', label: 'Software Defect' },
      { key: 'FEATURE_REQUEST', label: 'Feature Request' },
    ],
  },
  {
    key: 'BUSINESS_COOPERATION',
    label: 'Business Cooperation',
    subTypes: [
      { key: 'AGENCY_APPLICATION', label: 'Agency Application' },
      { key: 'AGENCY_AND_HOST', label: 'Agency and Host' },
      { key: 'BASE_SALARY_HOST', label: 'Base Salary Host' },
      { key: 'COINSELLER_APPLICATION', label: 'Coinseller Application' },
    ],
  },
]

/** O(n) lookup — config is tiny; no Map needed. */
export function isValidSubType(type: string, subType: string): boolean {
  const typeConf = SUPPORT_TYPE_CONFIG.find((t) => t.key === type)
  if (!typeConf) return false
  return typeConf.subTypes.some((s) => s.key === subType)
}

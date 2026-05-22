/**
 * Mask account number: show last 4 digits only.
 * '8006223499' → '******3499'
 */
export function maskAccountNumber(raw: string): string {
  if (raw.length <= 4) return raw;
  return "*".repeat(raw.length - 4) + raw.slice(-4);
}

/**
 * Mask EPAY email: 'karishma@gmail.com' → 'ka***@gmail.com'
 */
export function maskEpayEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || local.length <= 2) return email;
  return local.slice(0, 2) + "***@" + domain;
}

/**
 * Human-readable duration from seconds.
 * 65 → '1m 5s', 3600 → '1h 0m'
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${seconds % 60}s`;
}

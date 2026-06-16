/** True when both sides have the same non-empty country (users.country). */
export function countriesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a != null && a.length > 0 && a === b
}

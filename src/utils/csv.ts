export interface CsvColumn<T> {
  key: keyof T & string
  header: string
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'bigint'
        ? value.toString()
        : String(value)
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * RFC-4180 CSV serialization. Prefixed with a UTF-8 BOM so Excel opens it
 * with the right encoding.
 */
export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: CsvColumn<T>[],
): string {
  const header = columns.map((c) => escapeCell(c.header)).join(',')
  const lines = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(','))
  return '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n'
}

import { z } from 'zod'

/**
 * BE-25: zod 4 rewords every default validation message ("Required" became
 * "Invalid input: expected string, received undefined", and so on). Many routes return
 * `issues[0].message` to the app, so the shipped app would see different text. This global
 * error map reproduces zod 3's English defaults. Messages set on a schema still win; anything
 * not mapped here falls through to zod 4's own text.
 */

type Raw = {
  code?: string
  input?: unknown
  expected?: string
  origin?: string
  minimum?: number | bigint
  maximum?: number | bigint
  inclusive?: boolean
  exact?: boolean
  format?: string
  prefix?: string
  suffix?: string
  includes?: string
  values?: readonly unknown[]
  keys?: readonly string[]
  divisor?: number | bigint
  note?: string
  options?: readonly unknown[]
}

/** zod 3 `getParsedType` names. */
function receivedType(v: unknown): string {
  switch (typeof v) {
    case 'undefined':
      return 'undefined'
    case 'string':
      return 'string'
    case 'number':
      return Number.isNaN(v) ? 'nan' : 'number'
    case 'boolean':
      return 'boolean'
    case 'function':
      return 'function'
    case 'bigint':
      return 'bigint'
    case 'symbol':
      return 'symbol'
  }
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  if (v instanceof Map) return 'map'
  if (v instanceof Set) return 'set'
  if (typeof (v as { then?: unknown }).then === 'function') return 'promise'
  return 'object'
}

/** zod 3 `util.joinValues`. */
const joinValues = (vals: readonly unknown[]) =>
  vals.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ')

const FORMAT_NAMES: Record<string, string> = { guid: 'uuid', uuid: 'uuid', regex: '' }

export function v3Message(iss: Raw): string | undefined {
  switch (iss.code) {
    case 'invalid_type': {
      if (iss.input === undefined) return 'Required'
      if (iss.expected === 'date' && iss.input instanceof Date) return 'Invalid date'
      // zod 4 rejects ±Infinity (zod 3 accepted it); use zod 3's not_finite wording.
      if (iss.expected === 'number' && typeof iss.input === 'number' && !Number.isNaN(iss.input))
        return 'Number must be finite'
      if (iss.expected === 'int') {
        const r = receivedType(iss.input)
        return `Expected integer, received ${r === 'number' ? 'float' : r}`
      }
      return `Expected ${iss.expected}, received ${receivedType(iss.input)}`
    }
    case 'invalid_value': {
      const vals = iss.values ?? []
      if (vals.length === 1) return `Invalid literal value, expected ${JSON.stringify(vals[0])}`
      // zod 3 reported a wrong-typed enum input as invalid_type (z.enum: non-string;
      // z.nativeEnum: neither string nor number).
      const allStrings = vals.every((v) => typeof v === 'string')
      const t = typeof iss.input
      if (iss.input === undefined) return 'Required'
      if (allStrings ? t !== 'string' : t !== 'string' && t !== 'number')
        return `Expected ${joinValues(vals)}, received ${receivedType(iss.input)}`
      return `Invalid enum value. Expected ${joinValues(vals)}, received '${String(iss.input)}'`
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${(iss.keys ?? []).map((k) => `'${k}'`).join(', ')}`
    case 'invalid_union':
      if (iss.note === 'No matching discriminator' && iss.options?.length)
        return `Invalid discriminator value. Expected ${joinValues(iss.options)}`
      return 'Invalid input'
    case 'invalid_format': {
      if (iss.format === 'starts_with') return `Invalid input: must start with "${iss.prefix}"`
      if (iss.format === 'ends_with') return `Invalid input: must end with "${iss.suffix}"`
      if (iss.format === 'includes') return `Invalid input: must include "${iss.includes}"`
      const name = iss.format ? (FORMAT_NAMES[iss.format] ?? iss.format) : ''
      return name ? `Invalid ${name}` : 'Invalid'
    }
    case 'too_small': {
      const { minimum: m, inclusive, exact } = iss
      if (iss.origin === 'array' || iss.origin === 'set')
        return `${iss.origin === 'set' ? 'Set' : 'Array'} must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${m} element(s)`
      if (iss.origin === 'string')
        return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${m} character(s)`
      if (iss.origin === 'number' || iss.origin === 'bigint' || iss.origin === 'int')
        return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${m}`
      if (iss.origin === 'date')
        return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(m))}`
      return 'Invalid input'
    }
    case 'too_big': {
      const { maximum: m, inclusive, exact } = iss
      if (iss.origin === 'array' || iss.origin === 'set')
        return `${iss.origin === 'set' ? 'Set' : 'Array'} must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${m} element(s)`
      if (iss.origin === 'string')
        return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${m} character(s)`
      // origin 'int': zod 4 also caps .int() at Number.MAX_SAFE_INTEGER (zod 3 had no cap).
      if (iss.origin === 'number' || iss.origin === 'bigint' || iss.origin === 'int')
        return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${m}`
      if (iss.origin === 'date')
        return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(m))}`
      return 'Invalid input'
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${iss.divisor}`
    case 'custom':
      return 'Invalid input'
    default:
      return undefined
  }
}

/** Idempotent; imported by `config/env.ts` so every process installs it before any parse. */
z.config({ customError: (iss) => v3Message(iss as unknown as Raw) })

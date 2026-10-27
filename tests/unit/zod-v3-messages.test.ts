import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import '../../src/config/zod-v3-messages'

// BE-25: the app sees issues[0].message, so zod 4 must keep zod 3's wording.
const msg = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input)
  if (r.success) throw new Error('expected failure')
  return r.error.issues[0]?.message
}

enum Color {
  Red = 'RED',
  Blue = 'BLUE',
}

describe('zod 3 message compatibility', () => {
  it.each([
    ['missing field', z.object({ a: z.string() }), {}, 'Required'],
    ['wrong type', z.string(), 5, 'Expected string, received number'],
    ['NaN', z.coerce.number(), 'abc', 'Expected number, received nan'],
    ['float for int', z.number().int(), 1.5, 'Expected integer, received float'],
    ['string min', z.string().min(3), 'ab', 'String must contain at least 3 character(s)'],
    ['string max', z.string().max(2), 'abc', 'String must contain at most 2 character(s)'],
    ['string length', z.string().length(4), 'abc', 'String must contain exactly 4 character(s)'],
    ['array min', z.array(z.string()).min(1), [], 'Array must contain at least 1 element(s)'],
    ['number gte', z.number().min(1), 0, 'Number must be greater than or equal to 1'],
    ['number gt', z.number().positive(), 0, 'Number must be greater than 0'],
    ['number lte', z.number().max(5), 6, 'Number must be less than or equal to 5'],
    ['email', z.string().email(), 'x', 'Invalid email'],
    ['url', z.string().url(), 'not a url', 'Invalid url'],
    ['guid', z.string().guid(), 'abc', 'Invalid uuid'],
    ['datetime', z.string().datetime(), '2026-10-27', 'Invalid datetime'],
    ['regex', z.string().regex(/^\d+$/), 'a', 'Invalid'],
    ['enum', z.enum(['a', 'b']), 'c', "Invalid enum value. Expected 'a' | 'b', received 'c'"],
    ['enum wrong type', z.enum(['a', 'b']), 5, "Expected 'a' | 'b', received number"],
    ['enum missing', z.object({ p: z.enum(['a', 'b']) }), {}, 'Required'],
    ['nativeEnum missing', z.object({ c: z.nativeEnum(Color) }), {}, 'Required'],
    ['literal missing', z.object({ t: z.literal('x') }), {}, 'Invalid literal value, expected "x"'],
    [
      'nativeEnum',
      z.nativeEnum(Color),
      'GREEN',
      "Invalid enum value. Expected 'RED' | 'BLUE', received 'GREEN'",
    ],
    ['literal', z.literal('yes'), 'no', 'Invalid literal value, expected "yes"'],
    ['union', z.union([z.string(), z.number()]), true, 'Invalid input'],
    [
      'strict',
      z.object({ a: z.string() }).strict(),
      { a: 'x', b: 1 },
      "Unrecognized key(s) in object: 'b'",
    ],
    ['refine', z.string().refine((s) => s === 'x'), 'y', 'Invalid input'],
    ['custom message wins', z.string().min(3, 'Too short!'), 'a', 'Too short!'],
  ])('%s', (_name, schema, input, expected) => {
    expect(msg(schema as z.ZodType, input)).toBe(expected)
  })

  it('guid accepts non-RFC UUIDs like zod 3 uuid did', () => {
    expect(z.string().guid().safeParse('11111111-1111-1111-1111-111111111111').success).toBe(true)
  })
})

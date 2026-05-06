import { z } from 'zod'

const uuidSchema = z.string().uuid()

export const keyParamSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
})

const submitAnswerSchema = z.object({
  questionId: uuidSchema,
  optionId: uuidSchema,
})

export const submitQuestionnaireBodySchema = z.object({
  answers: z
    .array(submitAnswerSchema)
    .min(1)
    .superRefine((items, ctx) => {
      const seen = new Set<string>()
      for (const item of items) {
        if (seen.has(item.questionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Duplicate questionId in answers',
          })
          return
        }
        seen.add(item.questionId)
      }
    }),
})

const createOptionSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  order: z.number().int().min(1),
  isCorrect: z.boolean(),
})

const createQuestionSchema = z
  .object({
    order: z.number().int().min(1),
    text: z.string().min(1),
    options: z.array(createOptionSchema).min(2),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.isCorrect).length
    if (correct !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each question must have exactly one correct option',
      })
    }
    const orderSet = new Set<number>()
    const valueSet = new Set<string>()
    for (const option of q.options) {
      if (orderSet.has(option.order)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate option order in question' })
      }
      if (valueSet.has(option.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate option value in question' })
      }
      orderSet.add(option.order)
      valueSet.add(option.value)
    }
  })

export const createQuestionnaireBodySchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    title: z.string().min(1).max(255),
    description: z.string().max(2000).nullable().optional(),
    questions: z.array(createQuestionSchema).min(1),
  })
  .superRefine((body, ctx) => {
    const orderSet = new Set<number>()
    for (const q of body.questions) {
      if (orderSet.has(q.order)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate question order' })
      }
      orderSet.add(q.order)
    }
  })

export const patchQuestionnaireMetaBodySchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    requireAllCorrect: z.boolean().optional(),
  })
  .refine((val) => Object.keys(val).length > 0, 'At least one field is required')

export const myAttemptsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
})

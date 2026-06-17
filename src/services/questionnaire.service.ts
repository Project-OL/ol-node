import { prisma, prismaRead } from '../config/database'
import {
  QUESTIONNAIRE_ACTIVE_TTL,
  QUESTIONNAIRE_USER_STATUS_TTL,
  RedisKeys,
  redisClient,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { questionnaireRepository } from '../repositories/questionnaire.repository'

type ActiveQuestionnaire = Awaited<ReturnType<typeof questionnaireRepository.findActiveByKey>>
type SubmitAnswer = { questionId: string; optionId: string }

function toPublicDto(q: NonNullable<ActiveQuestionnaire>) {
  return {
    id: q.id,
    key: q.key,
    title: q.title,
    description: q.description,
    version: q.version,
    questions: q.questions.map((question) => ({
      id: question.id,
      order: question.order,
      text: question.text,
      options: question.options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        value: opt.value,
        order: opt.order,
      })),
    })),
  }
}

function toInternalDto(q: NonNullable<ActiveQuestionnaire>) {
  return {
    ...toPublicDto(q),
    requireAllCorrect: q.requireAllCorrect,
    questions: q.questions.map((question) => ({
      id: question.id,
      order: question.order,
      text: question.text,
      options: question.options.map((opt) => ({
        id: opt.id,
        label: opt.label,
        value: opt.value,
        order: opt.order,
        isCorrect: opt.isCorrect,
      })),
    })),
  }
}

export function scoreSubmission(
  active: ReturnType<typeof toInternalDto>,
  answers: SubmitAnswer[],
): {
  correctCount: number
  totalQuestions: number
  allCorrect: boolean
  perQuestion: Array<{
    questionId: string
    selectedOptionId: string
    selectedValue: string
    isCorrect: boolean
  }>
} {
  const byQuestion = new Map(active.questions.map((q) => [q.id, q]))
  const submittedQuestionIds = new Set(answers.map((a) => a.questionId))
  if (submittedQuestionIds.size !== active.questions.length) {
    throw new AppError(400, 'Answers must cover all active questions', 'incomplete_answers')
  }
  const perQuestion = answers.map((answer) => {
    const question = byQuestion.get(answer.questionId)
    if (!question) throw new AppError(400, 'Unknown question in request', 'unknown_question')
    const option = question.options.find((opt) => opt.id === answer.optionId)
    if (!option) throw new AppError(400, 'Unknown option for question', 'unknown_option')
    return {
      questionId: question.id,
      selectedOptionId: option.id,
      selectedValue: option.value,
      isCorrect: option.isCorrect,
    }
  })
  const correctCount = perQuestion.filter((q) => q.isCorrect).length
  const totalQuestions = active.questions.length
  const allCorrect = correctCount === totalQuestions
  return { correctCount, totalQuestions, allCorrect, perQuestion }
}

async function getActiveFromCacheOrDb(key: string) {
  const publicKey = RedisKeys.questionnaireActive(key)
  const internalKey = RedisKeys.questionnaireActiveFull(key)
  const cachedPublic = await redisClient.get(publicKey)
  const cachedInternal = await redisClient.get(internalKey)
  if (cachedPublic && cachedInternal) {
    return {
      publicPayload: JSON.parse(cachedPublic),
      internalPayload: JSON.parse(cachedInternal),
    }
  }
  const active = await questionnaireRepository.findActiveByKey(key)
  if (!active) throw new AppError(404, 'Active questionnaire not found', 'questionnaire_not_found')
  const publicPayload = toPublicDto(active)
  const internalPayload = toInternalDto(active)
  await redisClient.set(publicKey, JSON.stringify(publicPayload), 'EX', QUESTIONNAIRE_ACTIVE_TTL)
  await redisClient.set(
    internalKey,
    JSON.stringify(internalPayload),
    'EX',
    QUESTIONNAIRE_ACTIVE_TTL,
  )
  return { publicPayload, internalPayload }
}

async function invalidateByKey(key: string) {
  await redisClient.del(RedisKeys.questionnaireActive(key), RedisKeys.questionnaireActiveFull(key))
  try {
    const pattern = `questionnaire:user-status:*:${key}`
    let cursor = '0'
    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = nextCursor
      if (keys.length > 0) await redisClient.del(...keys)
    } while (cursor !== '0')
  } catch (error) {
    console.warn('[questionnaire] user-status invalidation scan failed', { key, error })
  }
}

export const questionnaireService = {
  async getPublicActiveByKey(key: string) {
    const { publicPayload } = await getActiveFromCacheOrDb(key)
    return publicPayload
  },

  async getMyStatus(userId: string, key: string) {
    const cacheKey = RedisKeys.questionnaireUserStatus(userId, key)
    const cached = await redisClient.get(cacheKey)
    if (cached != null) return JSON.parse(cached)

    const { internalPayload } = await getActiveFromCacheOrDb(key)
    const lastAttempt = await prismaRead.userQuestionnaireAttempt.findFirst({
      where: {
        userId,
        questionnaireId: internalPayload.id,
        questionnaireVersion: internalPayload.version,
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    })
    const response = {
      key,
      version: internalPayload.version,
      passed: Boolean(lastAttempt?.allCorrect),
      lastAttempt: lastAttempt
        ? {
            attemptId: lastAttempt.id,
            completedAt: lastAttempt.completedAt.toISOString(),
            allCorrect: lastAttempt.allCorrect,
            correctCount: lastAttempt.correctCount,
            totalQuestions: lastAttempt.totalQuestions,
          }
        : null,
    }
    await redisClient.set(cacheKey, JSON.stringify(response), 'EX', QUESTIONNAIRE_USER_STATUS_TTL)
    return response
  },

  async listMyAttempts(userId: string, key: string, opts: { limit: number; cursor?: string }) {
    const { internalPayload } = await getActiveFromCacheOrDb(key)
    const rows = await questionnaireRepository.listAttemptsByUser(userId, internalPayload.id, opts)
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    return {
      items: page.map((row) => ({
        attemptId: row.id,
        version: row.questionnaireVersion,
        totalQuestions: row.totalQuestions,
        correctCount: row.correctCount,
        allCorrect: row.allCorrect,
        passed: row.allCorrect,
        completedAt: row.completedAt.toISOString(),
      })),
      nextCursor: hasMore
        ? `${page[page.length - 1]!.completedAt.toISOString()}|${page[page.length - 1]!.id}`
        : null,
    }
  },

  async submit(userId: string, key: string, answers: SubmitAnswer[]) {
    const { internalPayload } = await getActiveFromCacheOrDb(key)
    const score = scoreSubmission(internalPayload, answers)
    const attempt = await prisma.$transaction(
      async (tx) =>
        questionnaireRepository.insertAttemptWithAnswers(tx, {
          userId,
          questionnaireId: internalPayload.id,
          questionnaireVersion: internalPayload.version,
          totalQuestions: score.totalQuestions,
          correctCount: score.correctCount,
          allCorrect: score.allCorrect,
          answers: score.perQuestion,
        }),
      { isolationLevel: 'Serializable' },
    )

    const statusKey = RedisKeys.questionnaireUserStatus(userId, key)
    await redisClient.del(statusKey)
    await questionnaireService.getMyStatus(userId, key)

    return {
      attemptId: attempt.id,
      version: internalPayload.version,
      totalQuestions: score.totalQuestions,
      correctCount: score.correctCount,
      allCorrect: score.allCorrect,
      passed: score.allCorrect,
      results: score.perQuestion.map((r) => ({
        questionId: r.questionId,
        selectedOptionId: r.selectedOptionId,
        isCorrect: r.isCorrect,
      })),
    }
  },

  async adminList() {
    const rows = await questionnaireRepository.listAll()
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      version: row.version,
      isActive: row.isActive,
      requireAllCorrect: row.requireAllCorrect,
      questionsCount: row._count.questions,
      attemptsCount: row._count.attempts,
      updatedAt: row.updatedAt.toISOString(),
    }))
  },

  async adminGet(id: string) {
    const row = await questionnaireRepository.findById(id)
    if (!row) throw new AppError(404, 'Questionnaire not found', 'questionnaire_not_found')
    return toInternalDto(row)
  },

  async adminCreate(
    actorId: string,
    input: {
      key: string
      title: string
      description?: string | null
      questions: Array<{
        order: number
        text: string
        options: Array<{ label: string; value: string; order: number; isCorrect: boolean }>
      }>
    },
  ) {
    const created = await prisma.$transaction(
      async (tx) => {
        await questionnaireRepository.deactivateActiveByKey(tx, input.key, actorId)
        const maxVersion = await questionnaireRepository.getMaxVersionByKey(tx, input.key)
        return questionnaireRepository.createWithQuestionsAndOptions(tx, {
          ...input,
          version: maxVersion + 1,
          isActive: true,
          actorId,
        })
      },
      { isolationLevel: 'Serializable' },
    )
    await invalidateByKey(input.key)
    return toInternalDto(created)
  },

  async adminPatchMeta(
    actorId: string,
    id: string,
    patch: { title?: string; description?: string | null; requireAllCorrect?: boolean },
  ) {
    const updated = await prisma.$transaction(
      async (tx) => {
        const existing = await questionnaireRepository.findByIdForUpdate(tx, id)
        if (!existing) throw new AppError(404, 'Questionnaire not found', 'questionnaire_not_found')
        await tx.questionnaire.update({
          where: { id },
          data: { ...patch, updatedById: actorId },
        })
        return questionnaireRepository.findById(id)
      },
      { isolationLevel: 'Serializable' },
    )
    await invalidateByKey(updated!.key)
    return toInternalDto(updated!)
  },

  async adminActivate(actorId: string, id: string) {
    const updated = await prisma.$transaction(
      async (tx) => {
        const existing = await questionnaireRepository.findByIdForUpdate(tx, id)
        if (!existing) throw new AppError(404, 'Questionnaire not found', 'questionnaire_not_found')
        await questionnaireRepository.deactivateActiveByKey(tx, existing.key, actorId)
        await questionnaireRepository.setActive(tx, id, true, actorId)
        return questionnaireRepository.findById(id)
      },
      { isolationLevel: 'Serializable' },
    )
    await invalidateByKey(updated!.key)
    return toInternalDto(updated!)
  },

  async adminDeactivate(actorId: string, id: string) {
    const updated = await prisma.$transaction(
      async (tx) => {
        const existing = await questionnaireRepository.findByIdForUpdate(tx, id)
        if (!existing) throw new AppError(404, 'Questionnaire not found', 'questionnaire_not_found')
        await questionnaireRepository.setActive(tx, id, false, actorId)
        return questionnaireRepository.findById(id)
      },
      { isolationLevel: 'Serializable' },
    )
    await invalidateByKey(updated!.key)
    return toInternalDto(updated!)
  },
}

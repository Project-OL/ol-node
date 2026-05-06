import type { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

const activeInclude = {
  questions: {
    orderBy: { order: 'asc' as const },
    include: { options: { orderBy: { order: 'asc' as const } } },
  },
}

export const questionnaireRepository = {
  findActiveByKey(key: string) {
    return prismaRead.questionnaire.findFirst({
      where: { key, isActive: true },
      orderBy: { version: 'desc' },
      include: activeInclude,
    })
  },

  findById(id: string) {
    return prismaRead.questionnaire.findUnique({
      where: { id },
      include: activeInclude,
    })
  },

  findByIdForUpdate(tx: Prisma.TransactionClient, id: string) {
    return tx.questionnaire.findUnique({
      where: { id },
      include: activeInclude,
    })
  },

  listAll() {
    return prismaRead.questionnaire.findMany({
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      include: { _count: { select: { attempts: true, questions: true } } },
    })
  },

  createWithQuestionsAndOptions(
    tx: Prisma.TransactionClient,
    input: {
      key: string
      title: string
      description?: string | null
      version: number
      isActive: boolean
      requireAllCorrect?: boolean
      actorId?: string
      questions: Array<{
        order: number
        text: string
        options: Array<{ label: string; value: string; order: number; isCorrect: boolean }>
      }>
    },
  ) {
    return tx.questionnaire.create({
      data: {
        key: input.key,
        title: input.title,
        description: input.description ?? null,
        version: input.version,
        isActive: input.isActive,
        requireAllCorrect: input.requireAllCorrect ?? true,
        createdById: input.actorId ?? null,
        updatedById: input.actorId ?? null,
        questions: {
          create: input.questions.map((q) => ({
            order: q.order,
            text: q.text,
            options: { create: q.options },
          })),
        },
      },
      include: activeInclude,
    })
  },

  setActive(tx: Prisma.TransactionClient, id: string, active: boolean, actorId?: string) {
    return tx.questionnaire.update({
      where: { id },
      data: { isActive: active, updatedById: actorId ?? null },
    })
  },

  deactivateActiveByKey(tx: Prisma.TransactionClient, key: string, actorId?: string) {
    return tx.questionnaire.updateMany({
      where: { key, isActive: true },
      data: { isActive: false, updatedById: actorId ?? null },
    })
  },

  async getMaxVersionByKey(tx: Prisma.TransactionClient, key: string) {
    const row = await tx.questionnaire.findFirst({
      where: { key },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    return row?.version ?? 0
  },

  insertAttemptWithAnswers(
    tx: Prisma.TransactionClient,
    payload: {
      userId: string
      questionnaireId: string
      questionnaireVersion: number
      totalQuestions: number
      correctCount: number
      allCorrect: boolean
      answers: Array<{
        questionId: string
        selectedOptionId: string
        selectedValue: string
        isCorrect: boolean
      }>
    },
  ) {
    return tx.userQuestionnaireAttempt.create({
      data: {
        userId: payload.userId,
        questionnaireId: payload.questionnaireId,
        questionnaireVersion: payload.questionnaireVersion,
        totalQuestions: payload.totalQuestions,
        correctCount: payload.correctCount,
        allCorrect: payload.allCorrect,
        answers: {
          createMany: {
            data: payload.answers.map((a) => ({
              questionId: a.questionId,
              selectedOptionId: a.selectedOptionId,
              selectedValue: a.selectedValue,
              isCorrect: a.isCorrect,
            })),
          },
        },
      },
      include: { answers: true },
    })
  },

  findLatestPassedAttempt(userId: string, questionnaireId: string, version: number) {
    return prismaRead.userQuestionnaireAttempt.findFirst({
      where: { userId, questionnaireId, questionnaireVersion: version, allCorrect: true },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    })
  },

  listAttemptsByUser(
    userId: string,
    questionnaireId: string,
    opts: { limit: number; cursor?: string },
  ) {
    return prismaRead.userQuestionnaireAttempt.findMany({
      where: {
        userId,
        questionnaireId,
        ...(opts.cursor
          ? {
              OR: [
                { completedAt: { lt: new Date(opts.cursor.split('|')[0] ?? opts.cursor) } },
                {
                  completedAt: new Date(opts.cursor.split('|')[0] ?? opts.cursor),
                  id: { lt: opts.cursor.split('|')[1] ?? '' },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
    })
  },
}

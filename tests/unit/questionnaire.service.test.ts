import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisGet = vi.fn()
const redisSet = vi.fn()
const redisDel = vi.fn()
const redisScan = vi.fn()

const findActiveByKey = vi.fn()
const listAll = vi.fn()
const findById = vi.fn()
const listAttemptsByUser = vi.fn()
const insertAttemptWithAnswers = vi.fn()
const deactivateActiveByKey = vi.fn()
const getMaxVersionByKey = vi.fn()
const createWithQuestionsAndOptions = vi.fn()
const findByIdForUpdate = vi.fn()
const setActive = vi.fn()

const tx = {
  questionnaire: { update: vi.fn() },
}

vi.mock('../../src/config/redis', () => ({
  getRedisForRead: () => ({ get: (...a: unknown[]) => redisGet(...a) }),
  redisClient: {
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
    del: (...a: unknown[]) => redisDel(...a),
    scan: (...a: unknown[]) => redisScan(...a),
  },
  RedisKeys: {
    questionnaireActive: (key: string) => `questionnaire:active:${key}`,
    questionnaireActiveFull: (key: string) => `questionnaire:active-full:${key}`,
    questionnaireUserStatus: (u: string, k: string) => `questionnaire:user-status:${u}:${k}`,
  },
  QUESTIONNAIRE_ACTIVE_TTL: 600,
  QUESTIONNAIRE_USER_STATUS_TTL: 3600,
}))

vi.mock('../../src/repositories/questionnaire.repository', () => ({
  questionnaireRepository: {
    findActiveByKey: (...a: unknown[]) => findActiveByKey(...a),
    listAll: (...a: unknown[]) => listAll(...a),
    findById: (...a: unknown[]) => findById(...a),
    listAttemptsByUser: (...a: unknown[]) => listAttemptsByUser(...a),
    insertAttemptWithAnswers: (...a: unknown[]) => insertAttemptWithAnswers(...a),
    deactivateActiveByKey: (...a: unknown[]) => deactivateActiveByKey(...a),
    getMaxVersionByKey: (...a: unknown[]) => getMaxVersionByKey(...a),
    createWithQuestionsAndOptions: (...a: unknown[]) => createWithQuestionsAndOptions(...a),
    findByIdForUpdate: (...a: unknown[]) => findByIdForUpdate(...a),
    setActive: (...a: unknown[]) => setActive(...a),
  },
}))

vi.mock('../../src/config/database', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  },
  prismaRead: {
    userQuestionnaireAttempt: {
      findFirst: vi.fn(),
    },
  },
}))

import { prismaRead } from '../../src/config/database'
import { AppError } from '../../src/middlewares/errorHandler'
import { questionnaireService, scoreSubmission } from '../../src/services/questionnaire.service'

const active = {
  id: 'q1',
  key: 'fun_zone_awareness',
  title: 'User Awareness Testing',
  description: null,
  version: 1,
  requireAllCorrect: true,
  questions: [
    {
      id: 'qa',
      order: 1,
      text: 'Q1',
      options: [
        { id: 'oa1', label: 'yes', value: 'yes', order: 1, isCorrect: true },
        { id: 'oa2', label: 'no', value: 'no', order: 2, isCorrect: false },
      ],
    },
    {
      id: 'qb',
      order: 2,
      text: 'Q2',
      options: [
        { id: 'ob1', label: 'yes', value: 'yes', order: 1, isCorrect: true },
        { id: 'ob2', label: 'no', value: 'no', order: 2, isCorrect: false },
      ],
    },
  ],
}

describe('questionnaire.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisGet.mockResolvedValue(null)
    redisSet.mockResolvedValue('OK')
    redisDel.mockResolvedValue(1)
    redisScan.mockResolvedValue(['0', []])
    findActiveByKey.mockResolvedValue(active)
    ;(prismaRead.userQuestionnaireAttempt.findFirst as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    insertAttemptWithAnswers.mockResolvedValue({ id: 'attempt1' })
    findByIdForUpdate.mockResolvedValue(active)
    findById.mockResolvedValue(active)
    getMaxVersionByKey.mockResolvedValue(1)
    createWithQuestionsAndOptions.mockResolvedValue({ ...active, id: 'q2', version: 2 })
  })

  it('scoreSubmission all correct returns allCorrect=true', () => {
    const scored = scoreSubmission(
      {
        ...active,
        questions: active.questions,
      } as never,
      [
        { questionId: 'qa', optionId: 'oa1' },
        { questionId: 'qb', optionId: 'ob1' },
      ],
    )
    expect(scored.correctCount).toBe(2)
    expect(scored.allCorrect).toBe(true)
  })

  it('submit partial keeps passed false', async () => {
    const result = await questionnaireService.submit('u1', 'fun_zone_awareness', [
      { questionId: 'qa', optionId: 'oa1' },
      { questionId: 'qb', optionId: 'ob2' },
    ])
    expect(result.correctCount).toBe(1)
    expect(result.passed).toBe(false)
  })

  it('submit rejects missing/unknown question', async () => {
    await expect(
      questionnaireService.submit('u1', 'fun_zone_awareness', [{ questionId: 'qa', optionId: 'oa1' }]),
    ).rejects.toBeInstanceOf(AppError)

    await expect(
      questionnaireService.submit('u1', 'fun_zone_awareness', [
        { questionId: 'qa', optionId: 'oa1' },
        { questionId: 'qx', optionId: 'oa2' },
      ]),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('submit rejects option from another question', async () => {
    await expect(
      questionnaireService.submit('u1', 'fun_zone_awareness', [
        { questionId: 'qa', optionId: 'ob1' },
        { questionId: 'qb', optionId: 'ob1' },
      ]),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('status cache hit short-circuits db', async () => {
    redisGet.mockResolvedValueOnce(JSON.stringify({ key: 'fun_zone_awareness', version: 1, passed: true, lastAttempt: null }))
    const out = await questionnaireService.getMyStatus('u1', 'fun_zone_awareness')
    expect(out.passed).toBe(true)
    expect(prismaRead.userQuestionnaireAttempt.findFirst).not.toHaveBeenCalled()
  })

  it('admin create deactivates previous and bumps version', async () => {
    const created = await questionnaireService.adminCreate('admin1', {
      key: 'fun_zone_awareness',
      title: 'User Awareness Testing',
      questions: [
        {
          order: 1,
          text: 'Q',
          options: [
            { label: 'y', value: 'y', order: 1, isCorrect: true },
            { label: 'n', value: 'n', order: 2, isCorrect: false },
          ],
        },
      ],
    })
    expect(created.version).toBe(2)
    expect(deactivateActiveByKey).toHaveBeenCalled()
  })
})

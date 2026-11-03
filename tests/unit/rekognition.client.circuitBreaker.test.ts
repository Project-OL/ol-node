import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const send = vi.fn()

class FakeCommand {
  input: unknown
  constructor(input: unknown) {
    this.input = input
  }
}

vi.mock('@aws-sdk/client-rekognition', () => ({
  CompareFacesCommand: FakeCommand,
  CreateCollectionCommand: FakeCommand,
  CreateFaceLivenessSessionCommand: FakeCommand,
  DeleteFacesCommand: FakeCommand,
  DescribeCollectionCommand: FakeCommand,
  DetectFacesCommand: FakeCommand,
  DetectModerationLabelsCommand: FakeCommand,
  GetFaceLivenessSessionResultsCommand: FakeCommand,
  IndexFacesCommand: FakeCommand,
  ListFacesCommand: FakeCommand,
  QualityFilter: { NONE: 'NONE', AUTO: 'AUTO', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
  RecognizeCelebritiesCommand: FakeCommand,
  RekognitionClient: class RekognitionClient {
    send = send
  },
  ResourceAlreadyExistsException: class ResourceAlreadyExistsException extends Error {},
  SearchFacesByImageCommand: FakeCommand,
}))

const { deleteFaceFromCollection, getFaceLivenessSessionResults, searchFaceByImage } = await import(
  '../../src/lib/rekognition.client'
)
const { rekognitionCircuitBreakers } = await import('../../src/utils/circuitBreaker')
const rekognitionCircuitBreaker = rekognitionCircuitBreakers.index

describe('rekognition.client circuit breaker wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens after threshold Rekognition failures, fails fast without calling AWS again, then recovers', async () => {
    send.mockRejectedValue(new Error('Rekognition unreachable'))

    // The index breaker's production threshold is 6.
    for (let i = 0; i < 6; i++) {
      await expect(deleteFaceFromCollection('face-1')).rejects.toThrow('Rekognition unreachable')
    }
    expect(send).toHaveBeenCalledTimes(6)
    expect(rekognitionCircuitBreaker.getState()).toBe('open')

    await expect(deleteFaceFromCollection('face-1')).rejects.toMatchObject({
      code: 'REKOGNITION_CIRCUIT_OPEN',
    })
    expect(send).toHaveBeenCalledTimes(6)

    vi.setSystemTime(15_000)
    rekognitionCircuitBreaker.getState()
    vi.setSystemTime(18_000)

    send.mockResolvedValueOnce({ FaceIds: ['face-1'] })
    await expect(deleteFaceFromCollection('face-1')).resolves.toEqual({ FaceIds: ['face-1'] })
    expect(rekognitionCircuitBreaker.getState()).toBe('closed')
  })

  it('an open index breaker does not block liveness or search calls (BE-10)', async () => {
    vi.setSystemTime(100_000)
    send.mockRejectedValue(new Error('IndexFaces denied'))
    for (let i = 0; i < 6; i++) {
      await expect(deleteFaceFromCollection('face-1')).rejects.toThrow('IndexFaces denied')
    }
    expect(rekognitionCircuitBreakers.index.getState()).toBe('open')

    send.mockResolvedValueOnce({ Status: 'SUCCEEDED' })
    await expect(getFaceLivenessSessionResults('s-1')).resolves.toEqual({ Status: 'SUCCEEDED' })
    send.mockResolvedValueOnce({ FaceMatches: [] })
    await expect(searchFaceByImage(new Uint8Array([1]))).resolves.toEqual({ FaceMatches: [] })
    expect(rekognitionCircuitBreakers.liveness.getState()).toBe('closed')
    expect(rekognitionCircuitBreakers.search.getState()).toBe('closed')

    // Close it again for the next test (same probe timing as the first test).
    vi.setSystemTime(115_000)
    rekognitionCircuitBreakers.index.getState()
    vi.setSystemTime(118_000)
    send.mockResolvedValueOnce({ FaceIds: ['face-1'] })
    await deleteFaceFromCollection('face-1')
    expect(rekognitionCircuitBreakers.index.getState()).toBe('closed')
  })

  it('does not trip the breaker on an InvalidParameterException (a business-shaped rejection)', async () => {
    const err = Object.assign(new Error('bad params'), { name: 'InvalidParameterException' })
    send.mockRejectedValue(err)

    await expect(deleteFaceFromCollection('face-1')).rejects.toThrow('bad params')
    expect(rekognitionCircuitBreaker.getState()).toBe('closed')
  })
})

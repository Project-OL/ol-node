import {
  CreateCollectionCommand,
  DeleteFacesCommand,
  DetectFacesCommand,
  IndexFacesCommand,
  QualityFilter,
  RekognitionClient,
  ResourceAlreadyExistsException,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition'
import { env } from '../config/env'

const rekognitionClient = new RekognitionClient({
  region: env.AWS_REGION,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
})

function resolveQualityFilter(value: string): QualityFilter {
  switch (value) {
    case 'NONE':
      return QualityFilter.NONE
    case 'AUTO':
      return QualityFilter.AUTO
    case 'LOW':
      return QualityFilter.LOW
    case 'MEDIUM':
      return QualityFilter.MEDIUM
    case 'HIGH':
      return QualityFilter.HIGH
    default:
      return QualityFilter.AUTO
  }
}

async function withTimeout<T>(timeoutMs: number, run: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export async function ensureCollectionExists(): Promise<void> {
  try {
    await rekognitionClient.send(
      new CreateCollectionCommand({ CollectionId: env.REKOGNITION_COLLECTION_ID }),
    )
  } catch (error) {
    if (error instanceof ResourceAlreadyExistsException) {
      return
    }
    throw error
  }
}

export async function detectFacesQuality(imageBytes: Uint8Array) {
  return withTimeout(env.FACE_VERIFY_TIMEOUT_MS, async (abortSignal) =>
    rekognitionClient.send(
      new DetectFacesCommand({
        Attributes: ['ALL'],
        Image: { Bytes: imageBytes },
      }),
      { abortSignal },
    ),
  )
}

export async function indexUserFace(params: {
  userId: string
  imageBytes: Uint8Array
}) {
  // Rekognition rejects some characters in ExternalImageId (e.g. ':').
  // Keep it stable but sanitize to a safe subset.
  const externalImageId = params.userId.replace(/[^A-Za-z0-9_.-]/g, '_')

  return withTimeout(env.FACE_INDEX_TIMEOUT_MS, async (abortSignal) =>
    rekognitionClient.send(
      new IndexFacesCommand({
        CollectionId: env.REKOGNITION_COLLECTION_ID,
        ExternalImageId: externalImageId,
        Image: { Bytes: params.imageBytes },
        MaxFaces: 1,
        QualityFilter: resolveQualityFilter(env.REKOGNITION_QUALITY_FILTER),
        DetectionAttributes: ['DEFAULT'],
      }),
      { abortSignal },
    ),
  )
}

export async function searchFaceByImage(imageBytes: Uint8Array) {
  return withTimeout(env.FACE_VERIFY_TIMEOUT_MS, async (abortSignal) =>
    rekognitionClient.send(
      new SearchFacesByImageCommand({
        CollectionId: env.REKOGNITION_COLLECTION_ID,
        Image: { Bytes: imageBytes },
        MaxFaces: 1,
        FaceMatchThreshold: env.FACE_MATCH_THRESHOLD_REJECT,
        QualityFilter: QualityFilter.AUTO,
      }),
      { abortSignal },
    ),
  )
}

export async function searchFaceInCollection(params: {
  imageBytes: Uint8Array
  collectionId: string
  threshold: number
  maxFaces?: number
  timeoutMs?: number
}) {
  try {
    const result = await withTimeout(params.timeoutMs ?? env.FACE_VERIFY_TIMEOUT_MS, async (abortSignal) =>
      rekognitionClient.send(
        new SearchFacesByImageCommand({
          CollectionId: params.collectionId,
          Image: { Bytes: params.imageBytes },
          MaxFaces: params.maxFaces ?? 1,
          FaceMatchThreshold: params.threshold,
          QualityFilter: QualityFilter.AUTO,
        }),
        { abortSignal },
      ),
    )
    const top = result.FaceMatches?.[0]
    if (!top?.Face?.FaceId || top.Similarity == null) {
      return null
    }
    return {
      faceId: top.Face.FaceId,
      similarity: Number(top.Similarity),
      requestId: result.$metadata.requestId,
    }
  } catch (error) {
    if ((error as { name?: string }).name === 'InvalidParameterException') {
      return null
    }
    throw error
  }
}

export async function deleteFaceFromCollection(faceId: string) {
  return withTimeout(env.FACE_INDEX_TIMEOUT_MS, async (abortSignal) =>
    rekognitionClient.send(
      new DeleteFacesCommand({
        CollectionId: env.REKOGNITION_COLLECTION_ID,
        FaceIds: [faceId],
      }),
      { abortSignal },
    ),
  )
}


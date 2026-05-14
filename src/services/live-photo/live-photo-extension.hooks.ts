/**
 * Extension points for passive liveness, blink/motion challenges, device integrity, EXIF heuristics.
 * Register async hooks in `livePhotoPreCompareHooks`; the worker runs them after S3 HeadObject and
 * target DetectFaces, before Rekognition CompareFaces. Empty array = no extra gates (production default).
 */
export type LivePhotoPreCompareContext = {
  userId: string;
  livePhotoS3Key: string;
  sourceFaceS3Key: string;
  requestId?: string;
  targetContentLength: number;
  targetContentType?: string;
};

export type LivePhotoPreCompareResult =
  | { pass: true }
  | { pass: false; reason: string; code?: string };

export const livePhotoPreCompareHooks: Array<
  (ctx: LivePhotoPreCompareContext) => Promise<LivePhotoPreCompareResult>
> = [];

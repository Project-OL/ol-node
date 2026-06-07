/** In-process counters for live-photo worker observability (export to metrics backend later). */
export const livePhotoMetrics = {
  verifyJobsCompleted: 0,
  verifyJobsFailed: 0,
  verifyStaleSkipped: 0,
  rekognitionCompareMsTotal: 0,
  rekognitionCompareSamples: 0,
  purgeJobsCompleted: 0,
  purgeJobsFailed: 0,
}

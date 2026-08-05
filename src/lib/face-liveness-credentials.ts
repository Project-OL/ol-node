import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { env } from '../config/env'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'faceLivenessCredentials' })

export type FaceLivenessTemporaryCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiration: string
}

let stsClient: STSClient | null = null

function getStsClient(): STSClient {
  if (!stsClient) {
    stsClient = new STSClient({
      region: env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    })
  }
  return stsClient
}

/**
 * Mint short-lived AWS credentials for the Amplify Face Liveness SDK.
 * Requires `FACE_LIVENESS_STS_ROLE_ARN` (role trusts this API's IAM principal and
 * allows `rekognition:StartFaceLivenessSession`).
 */
export async function mintFaceLivenessCredentials(
  userId: string,
): Promise<FaceLivenessTemporaryCredentials | null> {
  const roleArn = env.FACE_LIVENESS_STS_ROLE_ARN?.trim()
  if (!roleArn) return null

  const durationSeconds = env.FACE_LIVENESS_CREDENTIALS_DURATION_SEC
  try {
    const result = await getStsClient().send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `face-liveness-${userId.replace(/-/g, '').slice(0, 32)}`,
        DurationSeconds: durationSeconds,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['rekognition:StartFaceLivenessSession'],
              Resource: '*',
            },
          ],
        }),
      }),
    )
    const c = result.Credentials
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      log.warn({ userId }, 'sts_assume_role_missing_credentials')
      return null
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration.toISOString(),
    }
  } catch (err) {
    log.error({ err, userId }, 'sts_assume_role_failed')
    return null
  }
}

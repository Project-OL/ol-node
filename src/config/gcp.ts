import { MetricServiceClient } from '@google-cloud/monitoring'
import { BigQuery } from '@google-cloud/bigquery'
import { env } from './env'

/**
 * GCP clients for the admin infra monitor. Application Default Credentials only — no
 * key file. On the production VM this resolves to the attached service account
 * (`roles/monitoring.viewer` + BigQuery roles on the billing-export dataset); locally
 * it resolves to whatever `gcloud auth application-default login` account is active.
 * Both are lazily constructed and only when `GCP_PROJECT_ID` is set, so environments
 * without this feature configured never attempt GCP auth.
 */
let metricServiceClient: MetricServiceClient | null = null
let bigQueryClient: BigQuery | null = null

export function isGcpInfraMonitorConfigured(): boolean {
  return !!env.GCP_PROJECT_ID
}

/**
 * Constructs the client AND awaits `initialize()` (credential resolution + gRPC stub
 * creation) before returning it. This matters: `new MetricServiceClient()` alone
 * kicks off that work in the background outside any promise the caller awaits, so a
 * credentials failure surfaces as an **unhandled rejection that crashes the whole
 * process** instead of a normal rejected promise a caller's try/catch can catch
 * (confirmed the hard way — an ADC failure here took down the entire worker process,
 * not just this one collector, which is a bigger blast radius than the "each resource
 * fails independently" behavior every other collector in this file has). Awaiting
 * `initialize()` inside the caller's own try/catch forces the error onto a path that
 * is actually catchable.
 */
export async function getMetricServiceClient(): Promise<MetricServiceClient> {
  if (!env.GCP_PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID is not set — GCP infra monitor is not configured')
  }
  if (!metricServiceClient) {
    const client = new MetricServiceClient({ projectId: env.GCP_PROJECT_ID })
    await client.initialize()
    metricServiceClient = client
  }
  return metricServiceClient
}

export function getBigQueryClient(): BigQuery {
  if (!env.GCP_PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID is not set — GCP infra monitor is not configured')
  }
  if (!bigQueryClient) {
    bigQueryClient = new BigQuery({ projectId: env.GCP_PROJECT_ID })
  }
  return bigQueryClient
}

export const gcpProjectId = () => env.GCP_PROJECT_ID

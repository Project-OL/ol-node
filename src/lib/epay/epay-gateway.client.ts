import http_ from 'http'
import https from 'https'
import axios, { type AxiosInstance } from 'axios'
import { env } from '../../config/env'
import { AppError } from '../../middlewares/errorHandler'
import { rootLogger as logger } from '../../utils/rootLogger'
import { epayCircuitBreaker } from '../../utils/circuitBreaker'
import { epaySign, verifyEpaySign, type EpaySignParams } from './epay-sign'

/**
 * Real Epay gateway client (https://opendocs.epay.com/gateway/cn/).
 *
 * Every call is `POST <EPAY_API_BASE_URL><path>` with JSON `{ param, sign }`; the response is
 * `{ code, message, data, sign }` where `code === 1` means the request was accepted.
 *
 * Retry policy (deliberate):
 *  - Calls that move money (`createCashierPayin`, `createEpayTransfer`) are sent ONCE. A timeout
 *    there is ambiguous (the order may exist), so the caller must query by merchantOrderNo before
 *    trying again; a blind resend could double-charge or double-pay.
 *  - Read-only calls (queries, balance) retry on network errors / 5xx with backoff.
 * The shared circuit breaker counts only transport failures and 5xx; a well-formed business
 * rejection (`code !== 1`) is a healthy round-trip.
 */

export type EpayKeyKind = 'PAYIN' | 'PAYOUT'

/** Order status codes (https://opendocs.epay.com/gateway/cn/references/orderCode.html). */
export const EPAY_STATUS = {
  GATEWAY_CREATED: '0',
  CONFIRMED: '1',
  CANCELLED: '5',
  FAILED: '6',
  SUCCESS: '7',
  CLOSED: '8',
  FROZEN: '9',
  EXCEPTION: '11',
  CASH_PENDING: '19',
  FAILED_FEE_KEPT: '20',
} as const

const FINAL_FAILURE_STATUSES = new Set<string>(['5', '6', '8', '20'])

export type EpayOutcome = 'SUCCESS' | 'FAILED' | 'PENDING'

/** Only 7 is success; 5/6/8/20 are final failures; everything else (0/1/9/11/19/unknown) waits. */
export function classifyEpayStatus(status: string | number | null | undefined): EpayOutcome {
  const s = status == null ? '' : String(status)
  if (s === EPAY_STATUS.SUCCESS) return 'SUCCESS'
  if (FINAL_FAILURE_STATUSES.has(s)) return 'FAILED'
  return 'PENDING'
}

export interface EpayEnvelope<T> {
  code: number
  message?: string
  sign?: string
  data: T
}

/** Thrown when Epay answered but refused the request (`code !== 1`). */
export class EpayRejectedError extends AppError {
  constructor(
    public readonly path: string,
    public readonly epayCode: unknown,
    public readonly epayMessage: string | undefined,
  ) {
    super(502, 'Epay rejected the request', 'EPAY_REJECTED', {
      path,
      epayCode,
      epayMessage,
    })
    this.name = 'EpayRejectedError'
    // AppError pins its own prototype; restore ours so `instanceof EpayRejectedError` works.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Raised for transport failures where the outcome of the call is unknown. */
export class EpayUnavailableError extends AppError {
  constructor(path: string, cause: string) {
    super(502, 'Epay gateway error', 'EPAY_GATEWAY_ERROR', { path, cause })
    this.name = 'EpayUnavailableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function isEpayConfigured(): boolean {
  return Boolean(
    env.EPAY_ENABLED &&
    env.EPAY_API_BASE_URL &&
    env.EPAY_ACCOUNT &&
    env.EPAY_PAYIN_KEY &&
    env.EPAY_PAYOUT_KEY,
  )
}

function assertConfigured(): void {
  if (!isEpayConfigured()) {
    throw new AppError(503, 'Epay payments are not enabled', 'EPAY_DISABLED')
  }
}

export function epayKey(kind: EpayKeyKind): string {
  const key = kind === 'PAYIN' ? env.EPAY_PAYIN_KEY : env.EPAY_PAYOUT_KEY
  if (!key) throw new AppError(503, 'Epay payments are not enabled', 'EPAY_DISABLED')
  return key
}

let http: AxiosInstance | null = null
function getHttp(): AxiosInstance {
  if (!http) {
    http = axios.create({
      baseURL: env.EPAY_API_BASE_URL,
      timeout: env.EPAY_HTTP_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      // Reuse TCP/TLS connections to Epay: saves a full handshake (often 100–300 ms to an
      // overseas gateway) on every call after the first. Capped so a burst can't open
      // hundreds of sockets against a third party.
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000 }),
      httpAgent: new http_.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000 }),
    })
  }
  return http
}

/** Test hook: drop the cached axios instance. */
export function __resetEpayHttpForTests(): void {
  http = null
}

function transportStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status
}

async function call<T>(
  path: string,
  param: EpaySignParams,
  kind: EpayKeyKind,
  opts: { retries: number },
): Promise<T> {
  assertConfigured()
  if (epayCircuitBreaker.shouldSkip()) {
    throw new AppError(502, 'Epay gateway temporarily unavailable', 'EPAY_CIRCUIT_OPEN')
  }
  const fullParam: EpaySignParams = {
    epayAccount: env.EPAY_ACCOUNT,
    version: env.EPAY_API_VERSION,
    ...param,
  }
  const body = { param: fullParam, sign: epaySign(fullParam, epayKey(kind)) }
  const orderNo = typeof param.merchantOrderNo === 'string' ? param.merchantOrderNo : undefined

  let lastErr: unknown
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await getHttp().post<EpayEnvelope<T>>(path, body)
      epayCircuitBreaker.recordSuccess()
      const envelope = res.data
      if (!envelope || Number(envelope.code) !== 1) {
        logger.warn(
          {
            epayPath: path,
            merchantOrderNo: orderNo,
            epayCode: envelope?.code,
            epayMessage: envelope?.message,
          },
          'epay: request rejected',
        )
        throw new EpayRejectedError(path, envelope?.code, envelope?.message)
      }
      return envelope.data
    } catch (err) {
      if (err instanceof EpayRejectedError) throw err
      lastErr = err
      const status = transportStatus(err)
      // 4xx from the HTTP layer is not transient: stop retrying.
      if ((status != null && status < 500) || attempt === opts.retries) break
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 300))
    }
  }
  epayCircuitBreaker.recordFailure()
  const cause = lastErr instanceof Error ? lastErr.message : String(lastErr)
  logger.error({ epayPath: path, merchantOrderNo: orderNo, cause }, 'epay: transport failure')
  throw new EpayUnavailableError(path, cause)
}

// ── Response shapes (kept loose: Epay says "trust the live response, not the doc") ──

export interface EpayOrderData {
  merchantOrderNo?: string
  epayOrderNo?: string
  status?: string
  amount?: string
  currency?: string
  fee?: string
  paymentAmount?: string
  paymentCurrency?: string
  receiveAmount?: string
  receiveCurrency?: string
  [key: string]: unknown
}

export interface EpayCashierData extends EpayOrderData {
  epayUrl?: string
}

export interface EpayTransferData extends EpayOrderData {
  receiveEpayAccount?: string
}

export const epayGateway = {
  /**
   * Pay-in through the hosted cashier (`/gateway/sendTransaction`). The payer finishes on
   * `epayUrl`. Sent once, never auto-retried.
   */
  async createCashierPayin(input: {
    merchantOrderNo: string
    amount: string
    currency: string
    remark?: string
    language?: string
  }): Promise<EpayCashierData & { epayUrl: string }> {
    const data = await call<EpayCashierData>(
      '/gateway/sendTransaction',
      {
        merchantName: env.EPAY_MERCHANT_NAME,
        merchantOrderNo: input.merchantOrderNo,
        amount: input.amount,
        currency: input.currency,
        notifyUrl: env.EPAY_NOTIFY_URL,
        successUrl: env.EPAY_SUCCESS_URL,
        failUrl: env.EPAY_FAIL_URL,
        channelCode: env.EPAY_PAYIN_CHANNEL_CODE,
        checkOutType: env.EPAY_PAYIN_CHECKOUT_TYPE,
        remark: input.remark,
        language: input.language,
      },
      'PAYIN',
      { retries: 0 },
    )
    if (!data?.epayUrl) {
      throw new EpayRejectedError('/gateway/sendTransaction', 'NO_EPAY_URL', 'epayUrl missing')
    }
    return data as EpayCashierData & { epayUrl: string }
  },

  async queryPayin(merchantOrderNo: string): Promise<EpayOrderData> {
    return call<EpayOrderData>('/payinApi/queryTransaction', { merchantOrderNo }, 'PAYIN', {
      retries: 2,
    })
  },

  /**
   * Payout from our Epay balance to another Epay account (`/payoutApi/createEpayTransaction`).
   * Sent once, never auto-retried: on any error the caller must `queryPayout` first.
   */
  async createEpayTransfer(input: {
    merchantOrderNo: string
    amount: string
    currency: string
    receiveEpayAccount: string
    remark?: string
  }): Promise<EpayTransferData> {
    return call<EpayTransferData>(
      '/payoutApi/createEpayTransaction',
      {
        merchantName: env.EPAY_MERCHANT_NAME,
        merchantOrderNo: input.merchantOrderNo,
        amount: input.amount,
        currency: input.currency,
        receiveEpayAccount: input.receiveEpayAccount,
        notifyUrl: env.EPAY_NOTIFY_URL,
        remark: input.remark,
      },
      'PAYOUT',
      { retries: 0 },
    )
  },

  async queryPayout(merchantOrderNo: string): Promise<EpayOrderData> {
    return call<EpayOrderData>('/payoutApi/queryTransaction', { merchantOrderNo }, 'PAYOUT', {
      retries: 2,
    })
  },

  /** Merchant balance; shape varies by account, returned raw. */
  async getBalance(): Promise<unknown> {
    return call<unknown>('/payoutApi/getBalance', {}, 'PAYOUT', { retries: 2 })
  },
}

/**
 * Parse an Epay async notification body (POST application/x-www-form-urlencoded) into flat
 * string fields. Duplicate keys keep the last value.
 */
export function parseEpayCallbackBody(raw: string | Buffer): Record<string, string> {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(text)) out[k] = v
  return out
}

/** Verify a callback's `sign` with the key for the order's direction. */
export function verifyEpayCallback(fields: Record<string, string>, kind: EpayKeyKind): boolean {
  if (!isEpayConfigured()) return false
  return verifyEpaySign(fields, epayKey(kind))
}

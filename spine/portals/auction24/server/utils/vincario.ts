import { createHash } from 'node:crypto'
import type { VincarioDecodeResponse } from '~/models'

const BASE_URL = 'https://api.vincario.com/3.2'
const ACTION = 'decode'

export type VincarioErrorKind =
  | 'not_configured'
  | 'auth'
  | 'insufficient_balance'
  | 'rate_limited'
  | 'network'
  | 'bad_response'

export class VincarioError extends Error {
  constructor(
    readonly kind: VincarioErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'VincarioError'
  }
}

// First 10 chars of sha1("VIN|decode|API_KEY|SECRET_KEY"); the VIN must be uppercased
// (it is hashed into the URL path, so a lowercase VIN yields a 403 from Vincario).
export const vincarioControlSum = (vin: string, apiKey: string, secretKey: string): string =>
  createHash('sha1').update(`${vin.toUpperCase()}|${ACTION}|${apiKey}|${secretKey}`).digest('hex').slice(0, 10)

const getCredentials = (): { apiKey: string; secretKey: string } => {
  const { vincarioApiKey, vincarioSecretKey } = useRuntimeConfig()
  if (!vincarioApiKey || !vincarioSecretKey) {
    throw new VincarioError('not_configured', 'Vincario API keys are not configured')
  }
  return { apiKey: vincarioApiKey, secretKey: vincarioSecretKey }
}

const errorFromMessage = (raw: string, httpStatus?: number): VincarioError => {
  const m = raw.toLowerCase()
  if (httpStatus === 429 || m.includes('rate limit') || m.includes('too many'))
    return new VincarioError('rate_limited', raw, 429)
  if (m.includes('balance') || m.includes('credit') || m.includes('insufficient') || m.includes('payment'))
    return new VincarioError('insufficient_balance', raw, httpStatus)
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    m.includes('control sum') ||
    m.includes('api key') ||
    m.includes('authentic')
  )
    return new VincarioError('auth', raw, httpStatus)
  return new VincarioError('bad_response', raw, httpStatus)
}

const mapFetchError = (err: unknown): VincarioError => {
  const httpStatus = (err as { response?: { status?: number } }).response?.status
  const code = (err as { code?: string }).code ?? ''
  if (
    [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
    ].includes(code)
  ) {
    return new VincarioError('network', `Vincario network error (${code})`)
  }
  const body = (err as { data?: { message?: string; error?: string } }).data
  // Don't fall back to err.message: ofetch embeds the full request URL there (which carries the
  // API key + control sum), and this message is logged via captureServerError.
  const message = body?.message ?? body?.error ?? `Vincario request failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}`
  return errorFromMessage(message, httpStatus)
}

export const decodeVinRemote = async (vin: string): Promise<VincarioDecodeResponse> => {
  const { apiKey, secretKey } = getCredentials()
  const upper = vin.toUpperCase()
  const controlSum = vincarioControlSum(upper, apiKey, secretKey)
  const url = `${BASE_URL}/${apiKey}/${controlSum}/${ACTION}/${upper}.json`

  let res: VincarioDecodeResponse
  try {
    res = await $fetch<VincarioDecodeResponse>(url, { timeout: 15_000 })
  } catch (err) {
    throw mapFetchError(err)
  }

  // Vincario answers some failures with HTTP 200 + an error body instead of a decode array.
  if (!res || !Array.isArray(res.decode)) {
    const raw = (res as { message?: string; error?: string } | undefined)?.message ?? (res as { error?: string })?.error
    throw raw ? errorFromMessage(raw) : new VincarioError('bad_response', 'Vincario response had no decode array')
  }
  return res
}

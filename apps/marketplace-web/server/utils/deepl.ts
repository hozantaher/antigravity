export type DeeplErrorKind = 'not_configured' | 'auth' | 'quota' | 'rate_limited' | 'network' | 'bad_response'

export class DeeplError extends Error {
  constructor(
    readonly kind: DeeplErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'DeeplError'
  }
}

// Free keys carry the ":fx" suffix and must hit the api-free host; Pro keys use the paid host.
const hostForKey = (key: string): string =>
  key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'

// DeepL's target_lang requires a regional variant for English/Portuguese; the base code is
// accepted for every other language and for source_lang.
const normalizeTarget = (code: string): string => {
  const c = code.toUpperCase()
  if (c === 'EN') return 'EN-US'
  if (c === 'PT') return 'PT-PT'
  return c
}

const mapFetchError = (err: unknown): DeeplError => {
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
    return new DeeplError('network', `DeepL network error (${code})`)
  }
  if (httpStatus === 401 || httpStatus === 403) return new DeeplError('auth', 'DeepL authentication failed', httpStatus)
  if (httpStatus === 429) return new DeeplError('rate_limited', 'DeepL rate limit exceeded', 429)
  if (httpStatus === 456) return new DeeplError('quota', 'DeepL quota exceeded', 456)
  // Don't surface err.message: ofetch embeds the request URL/headers there (the auth key).
  return new DeeplError('bad_response', `DeepL request failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}`, httpStatus)
}

interface DeeplResponse {
  translations?: { text: string; detected_source_language?: string }[]
}

// Translates a batch of texts in a single request (DeepL accepts up to 50). Returns the
// translations in input order. Throws DeeplError on misconfiguration or upstream failure.
export const translateTexts = async (texts: string[], targetLang: string, sourceLang?: string): Promise<string[]> => {
  const { deeplApiKey } = useRuntimeConfig()
  if (!deeplApiKey) throw new DeeplError('not_configured', 'DeepL API key is not configured')
  if (!texts.length) return []

  let res: DeeplResponse
  try {
    res = await $fetch<DeeplResponse>(`${hostForKey(deeplApiKey)}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${deeplApiKey}` },
      body: {
        text: texts,
        target_lang: normalizeTarget(targetLang),
        ...(sourceLang ? { source_lang: sourceLang.toUpperCase() } : {}),
      },
      timeout: 15_000,
    })
  } catch (err) {
    throw mapFetchError(err)
  }

  if (!res?.translations || res.translations.length !== texts.length) {
    throw new DeeplError('bad_response', 'DeepL returned an unexpected response')
  }
  return res.translations.map(t => t.text)
}

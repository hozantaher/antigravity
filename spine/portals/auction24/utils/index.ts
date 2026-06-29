import type { Ref } from 'vue'
import type { Item, Price } from '~/models'

const pad2 = (n: number): string => String(n).padStart(2, '0')

// Native replacement for moment's formatter — supports the patterns the app uses
// ('DD.MM.yyyy', 'DD.MM.yyyy HH:mm', 'YYYY-MM-DDTHH:mm'). A 'YYYY-MM-DD' string is parsed as
// LOCAL midnight: `new Date('YYYY-MM-DD')` parses UTC and renders a day early in negative
// offsets (off-by-one + hydration mismatch), which moment avoided.
export const formatDate = (date: Date | number | string, format = 'DD.MM.yyyy'): string => {
  let d: Date
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, day] = date.split('-').map(Number)
    d = new Date(y!, m! - 1, day!)
  } else {
    d = new Date(date)
  }
  const tokens: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    YYYY: String(d.getFullYear()),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  }
  return format.replace(/yyyy|YYYY|MM|DD|HH|mm|ss/g, token => tokens[token]!)
}

export const isFormValid = (fields: Ref[]) => {
  let isValid = true
  for (const f of fields) {
    f.value?.validate()
    if (!f.value?.isValid) isValid = false
  }
  return isValid
}

// Best-effort human message from a caught $fetch/H3 error. Nitro puts the status message under
// `data.statusMessage`; some throw paths surface it at the top level. Single source so toasts
// across composables don't each guess a different property.
export const apiErrorMessage = (e: unknown, fallback = 'Something went wrong'): string => {
  const err = e as { data?: { statusMessage?: string }; statusMessage?: string }
  return err?.data?.statusMessage ?? err?.statusMessage ?? fallback
}

// Fetch one item by id, swallowing failures (deleted/invalid id → null) so a batch fetch of
// several ids doesn't fail as a whole. Shared by the compare dock and page.
export const fetchItemOrNull = async (id: string): Promise<Item | null> => {
  try {
    return await $fetch<Item>(`/api/item/${encodeURIComponent(id)}`)
  } catch {
    return null
  }
}

// en-US grouping (comma thousands, dot decimal), up to 2 decimals, no forced trailing
// zeros — matches the old numeral('0,0.[00]') output without the dependency.
const amountFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export const formatAmount = (amount?: number): string => {
  if (!amount) return '---'
  return amountFormatter.format(amount)
}

// Deposit amounts carry a bare ISO code (no Currency object) — format via Intl.
// cs-CZ grouping matches how the fixed amounts are presented (10 000 Kč / 500 €).
export const formatDepositAmount = (amount: number, currency: string): string =>
  new Intl.NumberFormat('cs-CZ', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)

export const formatPrice = (price?: Price): string => {
  if (!price) return '---'

  const result = formatAmount(price.amount)

  if (price.currency?.symbolBefore) return `${price.currency.symbol}${result}`
  else return `${result} ${price.currency?.symbol ?? ''}`
}

export const remainingTime = (startDateTime: Date | number) => {
  if (!startDateTime) return ''
  const formattedNumber = (n: number) => n.toString().padStart(2, '0')

  let result = ''

  const now = new Date()
  let time = (+startDateTime - +now) / 1000
  const days: number = Math.floor(time / 86400)
  time = time - days * 86400
  const hrs: number = Math.floor(time / 3600)
  time = time - hrs * 3600
  const minutes: number = Math.floor(time / 60)
  time = time - minutes * 60
  const seconds: number = Math.floor(time)
  if (time < 0 || days < 0 || hrs < 0 || minutes < 0) return '00:00:00:00'

  result = `${formattedNumber(days)}:${formattedNumber(hrs)}:${formattedNumber(minutes)}:${formattedNumber(seconds)}`

  return result
}

export const getTermsLink = (locale: string) => {
  if (locale === 'cz') return '/terms/terms_cz.pdf'
  return '/terms/terms_en.pdf'
}

export const getGdprLink = (locale: string) => {
  if (locale === 'cz') return '/terms/gdpr_cz.pdf'
  return '/terms/gdpr_en.pdf'
}

export const parseUserIdentifier = (id?: string) => {
  return `${id?.slice(0, 3)}${id?.slice(-3)}`
}

export const deeplLocales: Record<string, string> = {
  cz: 'CS',
  de: 'DE',
  en: 'EN',
  fr: 'FR',
  nl: 'NL',
  pl: 'PL',
  ru: 'RU',
  ua: 'UK',
}

export const getDeeplLocale = (locale: string) => deeplLocales[locale]

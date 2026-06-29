import { formatDate, formatPrice } from '~/utils'
import { itemCurrentPrice, RECO_CONFIG, type EmailItemCard, type Item } from '~/models'
import * as newsletterRepo from '../repos/newsletterRepo'
import { recommendForNewsletter } from './recommendation/serve'
import { emailItemImageUrl } from '../email/itemImage'
import { enqueueEmail } from './emailQueue'
import { mapWithConcurrency } from './concurrency'
import { hashApiToken } from './apiToken'
import { captureServerError } from './observability'

const NEWSLETTER_LIMIT = 8
const DEFAULT_BATCH = 500
// Per-user work (claim → recommend → enqueue) is independent and the claim-CAS guards double-send,
// so process the batch with bounded concurrency instead of strictly serially.
const SEND_CONCURRENCY = 8
const HORIZON_MS = RECO_CONFIG.newsletterHorizonHours * 3_600_000

export interface NewsletterResult {
  due: number
  sent: number
  skippedNoItems: number
  errored: number
}

// HMAC token for one-click unsubscribe (verified by the unsubscribe endpoint). The userId
// isn't secret; the signature is what prevents forging another user's opt-out.
export const unsubscribeToken = (userId: string): string => {
  const sig = hashApiToken(userId, useRuntimeConfig().internalApiSecret).slice(0, 32)
  return `${userId}.${sig}`
}

export const verifyUnsubscribeToken = (token: string): string | null => {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const userId = token.slice(0, dot)
  // Constant-time-ish: regenerate and compare.
  return unsubscribeToken(userId) === token ? userId : null
}

// cz (default) is unprefixed; other locales carry their code as the URL prefix (mirrors
// i18n strategy:prefix_except_default), so the recipient gets links in their own language.
const localeItemUrl = (baseUrl: string, locale: string, id: string): string =>
  locale === 'cz' ? `${baseUrl}/item/${id}` : `${baseUrl}/${locale}/item/${id}`

const toEmailCard = (item: Item, baseUrl: string, locale: string): EmailItemCard => ({
  title: item.title,
  price: formatPrice(itemCurrentPrice(item)) || undefined,
  endsAt: item.endDate ? formatDate(item.endDate, 'DD.MM.yyyy HH:mm') : undefined,
  imageUrl: emailItemImageUrl(item.image),
  url: localeItemUrl(baseUrl, locale, item.id),
})

// Email every due subscriber (≥7 days since last send) a localized set of recommended
// vehicles (§12). Claim-then-send (CAS stamp) guards against double-send on overlapping
// runs; a per-user failure is logged and skipped. dryRun computes without claiming/sending.
export const sendDueNewsletters = async (
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<NewsletterResult> => {
  const result: NewsletterResult = { due: 0, sent: 0, skippedNoItems: 0, errored: 0 }
  const nowMs = Date.now()
  const cutoff = nowMs - RECO_CONFIG.newsletterDueDays * 86_400_000
  const baseUrl = useRuntimeConfig().public.baseUrl
  const periodKey = new Date(nowMs).toISOString().slice(0, 10)

  const users = await newsletterRepo.listDueNewsletterUsers(cutoff, opts.limit ?? DEFAULT_BATCH)
  result.due = users.length

  await mapWithConcurrency(users, SEND_CONCURRENCY, async user => {
    try {
      // Claim first: a losing concurrent run skips, so no user is mailed twice.
      if (!opts.dryRun && !(await newsletterRepo.claimNewsletterSend(user.id, cutoff))) return

      const locale = user.languageCode ?? 'cz'
      const items = await recommendForNewsletter({ userId: user.id, locale, limit: NEWSLETTER_LIMIT, sendAtMs: nowMs })
      // Defensive horizon re-check (the engine already applies it).
      const eligible = items.filter(i => !(i.endDate && i.endDate < nowMs + HORIZON_MS))
      if (eligible.length === 0) {
        // Skip without stamping in dryRun; in a real run the claim already stamped them,
        // which is fine — they simply had nothing to show this cycle.
        result.skippedNoItems++
        return
      }
      const cards = eligible.map(i => toEmailCard(i, baseUrl, locale))
      if (opts.dryRun) {
        result.sent++
        return
      }
      await enqueueEmail(
        {
          recipient: user.email,
          templateKey: 'newsletter',
          language: locale,
          params: {
            recommendedItems: cards,
            unsubscribeUrl: `${baseUrl}/api/newsletter/unsubscribe?token=${unsubscribeToken(user.id)}`,
          },
        },
        { dedupKey: `newsletter:${user.id}:${periodKey}` },
      )
      result.sent++
    } catch (e) {
      result.errored++
      captureServerError(e, { area: 'newsletter.send', tags: { userId: user.id } })
    }
  })

  return result
}

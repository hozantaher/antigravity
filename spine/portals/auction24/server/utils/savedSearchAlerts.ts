import { formatDate, formatPrice } from '~/utils'
import { itemCurrentPrice, ALERT_DUE_DAYS, ALERT_ITEM_CAP, savedSearchQueryToItemFilter } from '~/models'
import type { EmailItemCard, Item } from '~/models'
import * as savedSearchRepo from '../repos/savedSearchRepo'
import { listSavedSearchMatchesPage } from '../repos/itemRepo'
import { emailItemImageUrl } from '../email/itemImage'
import { enqueueEmail } from './emailQueue'
import { mapWithConcurrency } from './concurrency'
import { hashApiToken } from './apiToken'
import { captureServerError } from './observability'

const DEFAULT_BATCH = 500
// Per-search work (claim → query → enqueue) is independent and claim-CAS guards double-send, so run
// the batch with bounded concurrency rather than one full item query at a time.
const SEND_CONCURRENCY = 8

export interface SavedSearchAlertResult {
  due: number
  sent: number
  skippedNoItems: number
  errored: number
}

// HMAC token for one-click alert-off. The token signs the saved-search id (not the user) so
// unsubscribe disables that one alert, not the account — identical construction to the newsletter's
// unsubscribeToken, reusing the same hashApiToken + INTERNAL_API_SECRET.
export const savedSearchUnsubToken = (id: string): string => {
  const sig = hashApiToken(id, useRuntimeConfig().internalApiSecret).slice(0, 32)
  return `${id}.${sig}`
}

export const verifySavedSearchUnsubToken = (token: string): string | null => {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const id = token.slice(0, dot)
  // Constant-time-ish: regenerate and compare.
  return savedSearchUnsubToken(id) === token ? id : null
}

// cz (default) is unprefixed; other locales carry their code as the URL prefix (i18n
// strategy:prefix_except_default), so the recipient gets links in their own language.
const localeItemUrl = (baseUrl: string, locale: string, id: string): string =>
  locale === 'cz' ? `${baseUrl}/item/${id}` : `${baseUrl}/${locale}/item/${id}`

const toEmailCard = (item: Item, baseUrl: string, locale: string): EmailItemCard => ({
  title: item.title,
  price: formatPrice(itemCurrentPrice(item)) || undefined,
  endsAt: item.endDate ? formatDate(item.endDate, 'DD.MM.yyyy HH:mm') : undefined,
  imageUrl: emailItemImageUrl(item.image),
  url: localeItemUrl(baseUrl, locale, item.id),
})

// Email every due saved search (≥7 days since last alert) the newest items matching its stored query,
// run through the existing itemRepo filter pipeline. Per-search claim-then-send (CAS) guards against
// double-send on overlapping runs; a per-search failure is logged and skipped. dryRun computes
// matches without claiming/sending. Mirrors sendDueNewsletters + auctionCloser two-pass discipline.
export const sendDueSavedSearchAlerts = async (
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<SavedSearchAlertResult> => {
  const result: SavedSearchAlertResult = { due: 0, sent: 0, skippedNoItems: 0, errored: 0 }
  const nowMs = Date.now()
  const cutoff = nowMs - ALERT_DUE_DAYS * 86_400_000
  const baseUrl = useRuntimeConfig().public.baseUrl
  const periodKey = new Date(nowMs).toISOString().slice(0, 10)

  const searches = await savedSearchRepo.listDueAlertSearches(cutoff, opts.limit ?? DEFAULT_BATCH)
  result.due = searches.length

  await mapWithConcurrency(searches, SEND_CONCURRENCY, async search => {
    try {
      // Claim first: a losing concurrent run skips, so no search is mailed twice.
      if (!opts.dryRun && !(await savedSearchRepo.claimAlertSend(search.id, cutoff))) return

      const locale = search.languageCode ?? 'cz'
      const filter = savedSearchQueryToItemFilter(search.query)
      const page = await listSavedSearchMatchesPage(filter, {
        page: 1,
        pageSize: ALERT_ITEM_CAP,
        limit: ALERT_ITEM_CAP,
        offset: 0,
      })
      if (page.items.length === 0) {
        // The claim already stamped it (in a real run), which is fine — nothing to show this cycle.
        result.skippedNoItems++
        return
      }
      const cards = page.items.map(i => toEmailCard(i, baseUrl, locale))
      if (opts.dryRun) {
        result.sent++
        return
      }
      await enqueueEmail(
        {
          recipient: search.email,
          templateKey: 'savedSearchAlert',
          language: locale,
          params: {
            savedSearchName: search.name,
            recommendedItems: cards,
            unsubscribeUrl: `${baseUrl}/api/saved-search/unsubscribe?token=${savedSearchUnsubToken(search.id)}`,
          },
        },
        { dedupKey: `saved-search:${search.id}:${periodKey}` },
      )
      result.sent++
    } catch (e) {
      result.errored++
      captureServerError(e, { area: 'saved-search.alert', tags: { savedSearchId: search.id } })
    }
  })

  return result
}

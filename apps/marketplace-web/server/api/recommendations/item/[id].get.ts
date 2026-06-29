import { VID_COOKIE } from '~/models'
import { recommendForItem } from '../../../utils/recommendation/serve'
import { parseRecoLimit } from '../../../utils/reco'
import { resolveRequestLocale } from '../../../utils/requestLocale'

// Detail "Podobné inzeráty" (§7, §14). Public; the vid cookie rides SSR so the first render
// is already personalized, and the client refetches with the user token after hydration.
// recommendForItem never throws — worst case it returns the deterministic fallback chain.
export default defineEventHandler(async event => {
  const anchorId = getRouterParam(event, 'id')
  if (!anchorId) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

  const vid = getCookie(event, VID_COOKIE) || undefined
  const userId = (await getSessionUser(event))?.id
  const locale = resolveRequestLocale(event)

  return recommendForItem({ anchorId, vid, userId, locale, limit: parseRecoLimit(event) })
})

import { VID_COOKIE } from '~/models'
import { recommendForHome } from '../../utils/recommendation/serve'
import { parseRecoLimit } from '../../utils/reco'
import { resolveRequestLocale } from '../../utils/requestLocale'

// Homepage "Vybráno pro vás" rail (§2). Public; personalized by the a24_vid cookie and, when
// present, the bearer user. Anchor-less. Never errors — degrades to the popularity/newest fallback.
export default defineEventHandler(async event => {
  const vid = getCookie(event, VID_COOKIE) || undefined
  const userId = (await getSessionUser(event))?.id
  const locale = resolveRequestLocale(event)

  return recommendForHome({ vid, userId, locale, limit: parseRecoLimit(event) })
})

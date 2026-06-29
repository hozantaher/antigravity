import type { H3Event } from 'h3'
import { RECO_CONFIG } from '~/models'

// Master kill-switch predicate (§13). Opt-in like stripeEnabled — off → serving falls back to
// popularity, collection + crons are no-ops. One definition for every gated site.
export const isRecoEnabled = (): boolean => useRuntimeConfig().public.recoEnabled === true

// Clamp the ?limit query to the serving bounds. Shared by the item + home reco endpoints.
export const parseRecoLimit = (event: H3Event): number => {
  const raw = Number(getQuery(event).limit)
  return Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 4), RECO_CONFIG.servingMaxN)
    : RECO_CONFIG.servingDefaultN
}

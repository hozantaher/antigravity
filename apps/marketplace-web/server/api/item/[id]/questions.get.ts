import { toPublicQuestion } from '~/models'
import { listQuestionsPage } from '~/server/repos/questionRepo'

// Public: the item detail page lazy-fetches the published Q&A thread (client-side). Newest first,
// paginated. IP-keyed rate limit (this is an anonymous read). The payload is projected to
// PublicQuestion so the asker's userId and the answering admin (answeredBy) never leak publicly.
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  enforceRateLimit(event, { bucket: 'questions:list', limit: 60, windowMs: 60_000 })
  const page = await listQuestionsPage(id, parsePageParams(event, { defaultPageSize: 20 }))
  return { ...page, items: page.items.map(toPublicQuestion) }
})

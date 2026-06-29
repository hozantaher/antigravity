import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json, jsonBody, jsonPage, pageQuery } from '../schemas/common'
import {
  QuestionSchema,
  PublicQuestionSchema,
  AskQuestionRequestSchema,
  AnswerQuestionRequestSchema,
} from '../schemas/messaging'

export const registerMessagingPaths = () => {
  registry.registerPath({
    method: 'post',
    path: '/api/item/{id}/question',
    tags: ['items'],
    summary: 'Ask a question on a listing',
    description:
      'Requires a session user. The question lands moderated (pending) and is hidden until an admin publishes it. Rate-limited 10/min per user.',
    request: {
      params: z.object({ id: z.string() }),
      body: jsonBody(AskQuestionRequestSchema),
    },
    responses: {
      200: json(z.object({ ok: z.boolean(), id: z.string() }), 'Question accepted (pending review)'),
      400: errorResponses[400],
      401: errorResponses[401],
      404: { description: 'Item not found' },
      429: errorResponses[429],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/item/{id}/questions',
    tags: ['items'],
    summary: "List a listing's published Q&A (newest first, paginated)",
    description: 'Public read (anonymized — no asker/answerer ids). Rate-limited 60/min per IP.',
    request: { params: z.object({ id: z.string() }), query: pageQuery },
    responses: {
      200: jsonPage(PublicQuestionSchema, 'Page of published questions'),
      429: errorResponses[429],
    },
    security: [],
  })

  registry.registerPath({
    method: 'post',
    path: '/api/admin/item/{id}/question',
    tags: ['admin'],
    summary: 'Answer or moderate a question',
    description: 'Requires the `admin` role. Provide an answer (auto-publishes) or a status to publish/hide.',
    request: {
      params: z.object({ id: z.string() }),
      body: jsonBody(AnswerQuestionRequestSchema),
    },
    responses: {
      200: json(QuestionSchema, 'Updated question'),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: { description: 'Question not found' },
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/admin/questions',
    tags: ['admin'],
    summary: 'List questions for moderation (all statuses, paginated)',
    description: 'Requires the `admin` role. Optional `itemId` scopes the list to one listing.',
    request: { query: pageQuery.extend({ itemId: z.string().optional() }) },
    responses: {
      200: jsonPage(QuestionSchema, 'Page of questions'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })
}

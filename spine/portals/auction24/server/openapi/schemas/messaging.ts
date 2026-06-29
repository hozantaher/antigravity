import { z } from 'zod'
import { registry } from '../registry'

export const QUESTION_STATUSES = ['pending', 'published', 'hidden'] as const

export const QuestionSchema = registry.register(
  'Question',
  z
    .object({
      id: z.string(),
      itemId: z.string(),
      userId: z.string(),
      body: z.string().openapi({ example: 'Is the service history complete?' }),
      answer: z.string().optional().openapi({ description: "Seller's answer; absent until answered." }),
      answeredBy: z.string().optional().openapi({ description: 'Admin user id who answered (soft ref).' }),
      status: z.enum(QUESTION_STATUSES).openapi({ description: 'pending (hidden) | published | hidden' }),
      created: z.number().openapi({ description: 'Epoch-ms.' }),
      answeredAt: z.number().optional().openapi({ description: 'Epoch-ms the answer was posted.' }),
    })
    .openapi('Question'),
)

// Public projection: the asker's userId and the answering admin (answeredBy) are stripped so the
// public thread can't leak who asked or answered. Backs GET /api/item/{id}/questions.
export const PublicQuestionSchema = registry.register(
  'PublicQuestion',
  z
    .object({
      id: z.string(),
      itemId: z.string(),
      body: z.string().openapi({ example: 'Is the service history complete?' }),
      answer: z.string().optional().openapi({ description: "Seller's answer; absent until answered." }),
      status: z.enum(QUESTION_STATUSES).openapi({ description: 'pending (hidden) | published | hidden' }),
      created: z.number().openapi({ description: 'Epoch-ms.' }),
      answeredAt: z.number().optional().openapi({ description: 'Epoch-ms the answer was posted.' }),
    })
    .openapi('PublicQuestion'),
)

export const AskQuestionRequestSchema = registry.register(
  'AskQuestionRequest',
  z
    .object({
      body: z.string().openapi({ description: 'Question text (≤ 2000 chars).', example: 'Is the VIN available?' }),
    })
    .openapi('AskQuestionRequest'),
)

export const AnswerQuestionRequestSchema = registry.register(
  'AnswerQuestionRequest',
  z
    .object({
      questionId: z.string(),
      answer: z
        .string()
        .optional()
        .openapi({ description: 'Answer text (≤ 5000 chars). Answering auto-publishes the question.' }),
      status: z.enum(QUESTION_STATUSES).optional().openapi({ description: 'Set to publish/hide without answering.' }),
    })
    .openapi('AnswerQuestionRequest'),
)

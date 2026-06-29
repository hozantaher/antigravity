import sgMail from '@sendgrid/mail'
import { renderEmail, type RenderedEmail } from './render'
import type { EmailTemplateKey, EmailParams } from './templates'

export interface SendEmailInput {
  recipient: string
  // Either a localized template rendered in the recipient's language…
  templateKey?: EmailTemplateKey
  language?: string
  params?: EmailParams
  // …or a pre-rendered payload — internal/ops notifications that aren't user-localized
  // and so bypass the per-locale template registry (server/email/internal.ts).
  rendered?: RenderedEmail
  // Optional Reply-To (e.g. the contact sender) so staff can answer the customer directly.
  replyTo?: string
  // Observability label for the rendered path, which has no templateKey to tag.
  label?: string
}

export interface SendEmailResult {
  ok: true
  messageId: string | null
}

export const sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
  const config = useRuntimeConfig()
  const apiKey = config.sendgridApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'SENDGRID_API_KEY not configured' })
  }
  if (!input.rendered && !input.templateKey) {
    throw createError({ statusCode: 500, statusMessage: 'Email payload missing template or rendered content' })
  }

  const from = config.sendgridFromNoReply || 'no-reply@auction24.cz'
  const { subject, html, text } =
    input.rendered ?? (await renderEmail(input.templateKey!, input.language ?? 'cz', input.params ?? {}))

  sgMail.setApiKey(apiKey)
  const [res] = await sgMail.send({
    to: input.recipient,
    from: { email: from, name: 'Auction24' },
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject,
    html,
    text,
  })

  const messageId =
    (res?.headers?.['x-message-id'] as string | undefined) ??
    (res?.headers?.['X-Message-Id'] as string | undefined) ??
    null

  return { ok: true, messageId }
}

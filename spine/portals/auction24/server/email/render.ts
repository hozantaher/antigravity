import mjml2html from 'mjml'
import { convert as htmlToText } from 'html-to-text'
import { buildMjml, type EmailContent, type LayoutStrings } from './layout'
import { TEMPLATE_BUILDERS, type EmailTemplateKey, type EmailParams, type TemplateStrings } from './templates'
import { getTranslation } from './translations'
import { captureServerError } from '../utils/observability'

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

// Shared MJML → {html,text} step. Both the localized templates and the internal ops
// notifications (server/email/internal.ts) build an EmailContent and render it here.
export const renderContent = async (
  content: EmailContent,
  layout: LayoutStrings,
  label: string,
): Promise<RenderedEmail> => {
  const mjmlString = buildMjml(content, layout)
  const { html, errors } = await mjml2html(mjmlString, { minify: true })

  if (errors.length > 0) {
    captureServerError(new Error(`MJML render errors for ${label}`), {
      area: 'email.render.mjml',
      tags: { label, errorCount: String(errors.length) },
    })
  }

  return {
    subject: content.subject,
    html,
    text: htmlToText(html, { wordwrap: 80 }),
  }
}

export const renderEmail = async (
  templateKey: EmailTemplateKey,
  language: string,
  params: EmailParams,
): Promise<RenderedEmail> => {
  const translation = getTranslation(language)
  const templateStrings = translation.templates[templateKey]
  // TS can't narrow the union per key.
  const builder = TEMPLATE_BUILDERS[templateKey] as (
    s: TemplateStrings[typeof templateKey],
    p: EmailParams,
  ) => EmailContent

  const content = builder(templateStrings, params)
  return renderContent(content, translation.layout as LayoutStrings, `${templateKey}/${language}`)
}

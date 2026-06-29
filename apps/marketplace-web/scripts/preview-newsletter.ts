#!/usr/bin/env tsx
// Render the recommendations newsletter to local HTML files for visual review — no DB, no send.
// Usage: pnpm preview:newsletter [locale ...]   (default: cz en ar)
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { loadEnv } from './load-env'
import { renderEmail } from '../server/email/render'
import { EMAIL_LOCALES } from '../server/email/translations'

loadEnv()

const sampleItems = [
  {
    title: 'BMW X5 xDrive40d',
    price: '1 290 000 Kč',
    endsAt: '01.07.2026 18:00',
    imageUrl: 'https://picsum.photos/seed/x5/360/240',
    url: 'https://auction24.cz/item/demo-x5',
  },
  {
    title: 'Audi A6 Avant 3.0 TDI',
    price: '890 000 Kč',
    endsAt: '02.07.2026 18:00',
    imageUrl: 'https://picsum.photos/seed/a6/360/240',
    url: 'https://auction24.cz/item/demo-a6',
  },
  {
    title: 'Škoda Superb 2.0 TDI',
    price: '540 000 Kč',
    endsAt: '03.07.2026 18:00',
    imageUrl: 'https://picsum.photos/seed/superb/360/240',
    url: 'https://auction24.cz/item/demo-superb',
  },
]

const run = async (): Promise<void> => {
  const outDir = resolve(process.cwd(), '.preview')
  mkdirSync(outDir, { recursive: true })
  const locales = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['cz', 'en', 'ar']
  for (const locale of locales) {
    const { html, subject } = await renderEmail('newsletter', locale, {
      recommendedItems: sampleItems,
      unsubscribeUrl: 'https://auction24.cz/api/newsletter/unsubscribe?token=demo',
    })
    const file = resolve(outDir, `newsletter-${locale}.html`)
    writeFileSync(file, html)
    console.log(`✓ ${locale}  "${subject}"  → ${file}`)
  }
  console.log(`\nOpen .preview/newsletter-*.html in a browser. Available locales: ${EMAIL_LOCALES.join(', ')}`)
}

run().catch(e => {
  console.error(e)
  process.exit(1)
})

// frontier/drive/read — extract one external listing into the canonical asset-model record.
// PoC reads a LOCAL fixture (no live portal traffic — that stays behind the legal gate, ADR 0002).
// Production swaps the fixture for a rate-limited, robots/ToS-respecting fetch.
import { readFileSync } from 'node:fs'

const attr = (html, name) => {
  const m = html.match(new RegExp(`data-${name}="([^"]*)"`))
  return m ? m[1] : ''
}

export function extract(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8')
  const num = (n) => Number(attr(html, n))
  const attachments = attr(html, 'attachments')
  return {
    make: attr(html, 'make'),
    model: attr(html, 'model'),
    category: attr(html, 'category'),
    year: num('year'),
    serialNumber: attr(html, 'serial'),
    operatingHours: num('hours'),
    condition: attr(html, 'condition') || 'unknown',
    attachments: attachments ? attachments.split(',') : [],
    priceAsking: num('price'),
    currency: attr(html, 'currency'),
    vatRate: num('vat'),
    location: attr(html, 'location'),
    photos: [],
    source: attr(html, 'source'),
    sourceListingRefs: [attr(html, 'ref')],
    lifecycle: 'sourced',
    externalIds: {},
  }
}

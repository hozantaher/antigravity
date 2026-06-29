#!/usr/bin/env tsx
// Bulk-backfill translated item descriptions in the production DB via DeepL.
//
// For each item it takes one source-language description and fills the other
// DeepL-supported locales. Mirrors the admin editor's "translate to other
// languages" action (composables/admin/useAdminItem.ts), but server-to-server:
// it talks to the DB directly (itemRepo imports the `~` alias which tsx can't
// resolve) and calls DeepL directly (server/utils/deepl.ts needs the Nitro
// runtime config, unavailable here).
//
// Default is a DRY RUN: it reads descriptions, prints the plan + DeepL character
// estimate, and writes nothing. Pass --apply to translate and persist.
//
//   pnpm translate:descriptions                 # dry run, up to 200 items
//   pnpm translate:descriptions --apply         # do it
//   pnpm translate:descriptions --apply --limit 50 --visible-only
//   pnpm translate:descriptions --apply --only iabc123,idef456
//   pnpm translate:descriptions --apply --overwrite --source cz
//
import { loadEnv } from './load-env'

// DeepL only covers these 8 of the project's 12 locales — source of truth is
// `deeplLocales` in utils/index.ts. Keys are app locale codes (the description
// map keys); values are DeepL language codes. ar/hr/me/rs are out of scope.
const DEEPL_BY_LOCALE: Record<string, string> = {
  cz: 'CS',
  de: 'DE',
  en: 'EN',
  fr: 'FR',
  nl: 'NL',
  pl: 'PL',
  ru: 'RU',
  ua: 'UK',
}
const DEEPL_LOCALES = Object.keys(DEEPL_BY_LOCALE)
// Auto-pick order when no --source is given: project default first, then common
// fallbacks, then any remaining supported locale that happens to be filled.
const SOURCE_PRIORITY = ['cz', 'en', 'de', ...DEEPL_LOCALES.filter(c => !['cz', 'en', 'de'].includes(c))]

const nonEmpty = (s?: string): s is string => typeof s === 'string' && s.trim() !== ''
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ---- CLI -------------------------------------------------------------------

const argv = process.argv.slice(2)
const hasFlag = (f: string): boolean => argv.includes(f)
const flagValue = (f: string): string | undefined => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const csv = (v: string | undefined): string[] | undefined =>
  v
    ?.split(',')
    .map(s => s.trim())
    .filter(Boolean)

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(
    `
Backfill translated item descriptions via DeepL.

Usage: tsx scripts/translate-descriptions.ts [options]

  --apply            Actually call DeepL and write the DB (default: dry run)
  --limit N          Max items to process (default: 200)
  --overwrite        Re-translate target locales that already have text
  --source <code>    Force source locale (default: auto cz>en>de>...)
  --targets <codes>  Restrict target locales, comma-separated (default: all 8)
  --visible-only     Skip hidden items
  --only <ids>       Restrict to specific item ids, comma-separated
  --batch N          DeepL texts per request, 1..50 (default: 40)
  -h, --help         Show this help

Supported locales: ${DEEPL_LOCALES.join(', ')}
`.trim(),
  )
  process.exit(0)
}

const apply = hasFlag('--apply')
const overwrite = hasFlag('--overwrite')
const visibleOnly = hasFlag('--visible-only')
const limit = Math.max(0, Number(flagValue('--limit') ?? '200'))
const batchSize = Math.min(50, Math.max(1, Number(flagValue('--batch') ?? '40')))
const forcedSource = flagValue('--source')
const onlyIds = csv(flagValue('--only'))
const targetFilter = csv(flagValue('--targets'))

if (forcedSource && !DEEPL_LOCALES.includes(forcedSource)) {
  console.error(`--source '${forcedSource}' is not DeepL-supported. Choose one of: ${DEEPL_LOCALES.join(', ')}`)
  process.exit(1)
}
const badTargets = targetFilter?.filter(t => !DEEPL_LOCALES.includes(t))
if (badTargets?.length) {
  console.error(
    `--targets contains unsupported locales: ${badTargets.join(', ')}. Supported: ${DEEPL_LOCALES.join(', ')}`,
  )
  process.exit(1)
}

// ---- DeepL -----------------------------------------------------------------

class DeeplFatal extends Error {
  constructor(
    readonly kind: 'auth' | 'quota' | 'network' | 'bad_response',
    message: string,
  ) {
    super(message)
    this.name = 'DeeplFatal'
  }
}

// Free keys carry the ":fx" suffix and must hit the api-free host (parity with server/utils/deepl.ts).
const deeplHost = (key: string): string =>
  key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'

// DeepL needs a regional variant for English/Portuguese targets; base code is fine elsewhere and for source.
const normalizeTarget = (deeplCode: string): string => {
  if (deeplCode === 'EN') return 'EN-US'
  if (deeplCode === 'PT') return 'PT-PT'
  return deeplCode
}

interface DeeplResponse {
  translations?: { text: string }[]
}

// Translates up to `batchSize` texts in one request, in input order. Retries
// transient errors (network/429/5xx); throws DeeplFatal on auth/quota/malformed.
const deeplTranslate = async (
  texts: string[],
  sourceLocale: string,
  targetLocale: string,
  apiKey: string,
): Promise<string[]> => {
  if (!texts.length) return []
  const url = `${deeplHost(apiKey)}/v2/translate`
  const sourceLang = DEEPL_BY_LOCALE[sourceLocale]
  const targetLang = DEEPL_BY_LOCALE[targetLocale]
  if (!sourceLang || !targetLang)
    throw new DeeplFatal('bad_response', `Unsupported DeepL locale pair ${sourceLocale}->${targetLocale}`)
  const body = JSON.stringify({
    text: texts,
    source_lang: sourceLang,
    target_lang: normalizeTarget(targetLang),
  })

  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
        body,
      })
    } catch {
      // Don't surface the error message verbatim — it can embed the request URL/headers (the auth key).
      if (attempt <= 3) {
        await sleep(1000 * attempt)
        continue
      }
      throw new DeeplFatal('network', `DeepL network error after ${attempt} attempts`)
    }

    if (res.ok) {
      const json = (await res.json()) as DeeplResponse
      const out = json.translations?.map(t => t.text)
      if (!out || out.length !== texts.length)
        throw new DeeplFatal('bad_response', 'DeepL returned an unexpected response')
      return out
    }
    if (res.status === 429 && attempt <= 5) {
      const retryAfter = Number(res.headers.get('retry-after')) || attempt * 2
      await sleep(retryAfter * 1000)
      continue
    }
    if (res.status >= 500 && attempt <= 3) {
      await sleep(1000 * attempt)
      continue
    }
    if (res.status === 456) throw new DeeplFatal('quota', 'DeepL quota exceeded (HTTP 456) — character limit reached')
    if (res.status === 401 || res.status === 403)
      throw new DeeplFatal('auth', 'DeepL authentication failed (check DEEPL_API_KEY)')
    throw new DeeplFatal('bad_response', `DeepL request failed (HTTP ${res.status})`)
  }
}

// ---- Planning --------------------------------------------------------------

interface Candidate {
  id: string
  title: string
  hidden: boolean
  source: string
  sourceText: string
  targets: string[]
  current: Record<string, string>
}

const pickSource = (desc: Record<string, string>): string | undefined => {
  if (forcedSource) return nonEmpty(desc[forcedSource]) ? forcedSource : undefined
  return SOURCE_PRIORITY.find(code => nonEmpty(desc[code]))
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const dbHostLabel = (): string => {
  try {
    const u = new URL(process.env.POSTGRES_URL ?? '')
    return `${u.host}${u.pathname}`
  } catch {
    return '(unparseable POSTGRES_URL)'
  }
}

// ---- Main ------------------------------------------------------------------

const main = async (): Promise<void> => {
  loadEnv()
  process.env.POSTGRES_STATEMENT_TIMEOUT ??= '0'

  const apiKey = process.env.DEEPL_API_KEY
  if (apply && !apiKey) {
    console.error('DEEPL_API_KEY is not set — cannot --apply. Add it to .env.')
    process.exit(1)
  }

  // Dynamic import after loadEnv so server/utils/db reads POSTGRES_URL from env.
  const { db, destroyDb } = await import('../server/utils/db')

  try {
    console.log(`DB: ${dbHostLabel()}`)
    console.log(`Mode: ${apply ? 'APPLY (will translate + write)' : 'dry run (no DeepL, no writes)'}\n`)

    let query = db
      .selectFrom('items')
      .select(['id', 'title', 'description', 'hidden', 'created'])
      .where('description', 'is not', null)
    if (visibleOnly) query = query.where('hidden', '=', false)
    if (onlyIds?.length) query = query.where('id', 'in', onlyIds)
    const rows = await query.execute()

    const targetPool = targetFilter ?? DEEPL_LOCALES

    const candidates: Candidate[] = []
    let noSource = 0
    let alreadyComplete = 0
    for (const row of rows) {
      const desc = (row.description ?? {}) as Record<string, string>
      const source = pickSource(desc)
      if (!source) {
        noSource++
        continue
      }
      const targets = targetPool.filter(t => t !== source && (overwrite || !nonEmpty(desc[t])))
      if (!targets.length) {
        alreadyComplete++
        continue
      }
      candidates.push({
        id: row.id,
        title: row.title,
        hidden: !!row.hidden,
        source,
        sourceText: desc[source]!,
        targets,
        current: desc,
      })
    }

    // Visible items first, then newest — so a --limit cut keeps the items that matter most.
    const created = new Map(
      rows.map(r => [
        r.id,
        (r.created instanceof Date ? r.created : new Date(r.created as unknown as string)).getTime(),
      ]),
    )
    candidates.sort((a, b) =>
      a.hidden === b.hidden ? (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0) : a.hidden ? 1 : -1,
    )
    const selected = candidates.slice(0, limit)

    const perTarget: Record<string, number> = {}
    let translations = 0
    let chars = 0
    for (const c of selected) {
      for (const t of c.targets) {
        perTarget[t] = (perTarget[t] ?? 0) + 1
        translations++
        chars += c.sourceText.length
      }
    }

    console.log(`Scanned ${rows.length} items with a description.`)
    console.log(`  - ${noSource} have no DeepL-supported source language (skipped)`)
    console.log(`  - ${alreadyComplete} already complete${overwrite ? '' : ' (use --overwrite to redo)'} (skipped)`)
    console.log(`  - ${candidates.length} need work; processing ${selected.length} (limit ${limit}).\n`)

    if (!selected.length) {
      console.log('Nothing to do.')
      return
    }

    console.log(`Planned: ${translations} translations across ${selected.length} items.`)
    console.log(
      `Per target locale: ${DEEPL_LOCALES.filter(l => perTarget[l])
        .map(l => `${l}:${perTarget[l]}`)
        .join('  ')}`,
    )
    console.log(`DeepL source characters (approx): ${chars.toLocaleString('en-US')}\n`)

    const sample = selected.slice(0, 10)
    console.log(`Sample (first ${sample.length}):`)
    for (const c of sample) {
      console.log(
        `  ${c.id}  [${c.source}→${c.targets.join(',')}]${c.hidden ? ' (hidden)' : ''}  ${c.title.slice(0, 50)}`,
      )
    }
    console.log('')

    if (!apply) {
      console.log('Dry run — re-run with --apply to translate and write.')
      return
    }

    // ---- Translate + persist, durable per chunk -----------------------------
    let itemsWritten = 0
    let translationsDone = 0
    let charsSent = 0
    const errors: string[] = []

    const chunks = chunk(selected, batchSize)
    for (let ci = 0; ci < chunks.length; ci++) {
      const group = chunks[ci]!
      const pending = new Map(group.map(c => [c.id, { ...c.current } as Record<string, string>]))

      // One DeepL request per (target locale, source locale) pair — texts batched across items.
      for (const target of targetPool) {
        const needers = group.filter(c => c.targets.includes(target))
        if (!needers.length) continue
        const bySource = new Map<string, Candidate[]>()
        for (const c of needers) {
          const list = bySource.get(c.source) ?? []
          list.push(c)
          bySource.set(c.source, list)
        }

        for (const [src, items] of bySource) {
          try {
            const texts = items.map(c => c.sourceText)
            const translated = await deeplTranslate(texts, src, target, apiKey!)
            items.forEach((c, i) => {
              pending.get(c.id)![target] = translated[i]!
            })
            translationsDone += items.length
            charsSent += texts.reduce((sum, t) => sum + t.length, 0)
            await sleep(200) // be gentle on DeepL's rate limit
          } catch (err) {
            if (err instanceof DeeplFatal && (err.kind === 'auth' || err.kind === 'quota')) {
              console.error(`\nFATAL: ${err.message}`)
              console.error(`Stopping. ${itemsWritten} items written so far.`)
              process.exitCode = 1
              return
            }
            const msg = err instanceof Error ? err.message : String(err)
            errors.push(`${target}<-${src} (${items.length} items): ${msg}`)
            console.error(`  ! ${target}<-${src}: ${msg} — leaving these untranslated`)
          }
        }
      }

      // Persist each item once. Bump `updated` (content changed, like the admin save) but leave
      // `visibleUpdated` so a bulk translate doesn't reshuffle the public "recently updated" sort.
      const now = new Date()
      for (const c of group) {
        const next = pending.get(c.id)!
        const changed = c.targets.some(t => next[t] !== c.current[t])
        if (!changed) continue
        await db.updateTable('items').set({ description: next, updated: now }).where('id', '=', c.id).execute()
        itemsWritten++
      }
      console.log(
        `Chunk ${ci + 1}/${chunks.length}: ${itemsWritten} items written, ${translationsDone} translations done.`,
      )
    }

    console.log(
      `\nDone. ${itemsWritten} items updated, ${translationsDone} translations, ~${charsSent.toLocaleString('en-US')} DeepL chars.`,
    )
    if (errors.length) {
      console.log(`\n${errors.length} batch error(s):`)
      errors.forEach(e => console.log(`  - ${e}`))
      process.exitCode = 1
    }
  } finally {
    await destroyDb()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})

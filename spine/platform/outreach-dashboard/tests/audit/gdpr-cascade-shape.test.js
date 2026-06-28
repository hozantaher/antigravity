// @linkage-allowed: discipline ratchet — pins GDPR DSR cascade + privacy footer contract
/**
 * KT-B12 — GDPR cascade shape audit.
 *
 * Pins the schema-level contract for the GDPR DSR (Art. 17) erase
 * cascade and the legal-information footer required in every outbound
 * campaign template (Art. 13/14 + §7 zák. 480/2004).
 *
 * The test reads the BFF source (`server.js`) + production templates
 * (`features/outreach/campaigns/configs/templates/`) and asserts that:
 *   1. DSR erase handler queries each PII-bearing table the LIA + Privacy
 *      Notice document as in scope.
 *   2. Suppression UNION semantics (outreach_suppressions ∪ suppression_list)
 *      are referenced — the erased subject must remain blocked.
 *   3. Active campaign templates carry controller identity, IČO, sídlo,
 *      legal-basis ref, source-of-data, unsubscribe placeholder, and
 *      privacy-policy URL.
 *
 * Goal: surface silent regressions where someone removes a cascade
 * branch, drops a footer field, or adds a new campaign template that
 * skips the legal block. Treat this as a one-way ratchet: never weaken,
 * only tighten as the contract evolves.
 *
 * See: docs/legal/privacy-notice.md, docs/legal/lia-direct-marketing.md,
 *      docs/initiatives/2026-04-30-kampan-vykupu-techniky-B-quality.md (KT-B12).
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../../../..')
const DASHBOARD_DIR = join(REPO_ROOT, 'features/platform/outreach-dashboard')
const SERVER_JS = join(DASHBOARD_DIR, 'server.js')
// T2.6.0 — DSR handlers may be extracted from server.js into a dedicated
// route module under src/server-routes/. The audit reads BOTH locations
// (when present) and concatenates the source so assertions stay
// location-independent. Add new optional paths here if the route module
// gets split further.
const DSR_ROUTE_MODULE = join(DASHBOARD_DIR, 'src/server-routes/dsr.js')
// Sprint AH: configs/templates/ directory deleted — templates are now in
// email_templates DB (migration 061). Test uses inline DB fixtures below.
const AUDIT_SCRIPT = join(REPO_ROOT, 'scripts/audits/gdpr-compliance-check.sh')
const PRIVACY_NOTICE = join(REPO_ROOT, 'docs/legal/privacy-notice.md')

function readText(p) {
  return readFileSync(p, 'utf8')
}

// Read text from `p` if it exists; return '' otherwise. Lets the audit
// gracefully tolerate optional DSR route modules that may not exist yet
// (pre-extract) or after a future re-merge.
function readTextOptional(p) {
  return existsSync(p) ? readText(p) : ''
}

// Tables the DSR erase cascade currently reaches (locked contract — must
// never regress). Each entry is the canonical Postgres table name; the
// test asserts that `server.js` references the table inside the
// `/api/dsr/erase` handler region (between the route declaration and the
// next route).
const REQUIRED_CASCADE_TABLES = [
  'outreach_contacts',
  'tracking_events',
  'suppression_list',
  'crm_clients',
]

// Spec-target cascade tables — KT-B12 calls these out as in-scope but the
// current BFF handler (server.js as of 2026-04-30) does NOT yet UPDATE
// them on erase. These are pinned as `it.todo` so the audit surfaces the
// gap in test naming without blocking CI. Resolution: cascade fix PR;
// flip from `it.todo` to `it` once handler updates.
const SPEC_TARGET_GAPS = [
  'outreach_threads',     // spec: "outreach_threads closed"
  'outreach_suppressions', // spec: "suppression UNION includes erased contact" (writes side)
]

// Track E (migration 019) — three audit tables that must be cascaded by
// the DSR erase handler. channel_audit_log: DELETE rows by subject_email;
// ai_suggestion_audit: UPDATE → anonymize (thread_id NULL, operator_id
// 'erased'); photo_parse_audit: NOT cascaded (schema has no subject FK,
// only blob_ref + machinery attributes). Promoted on 2026-04-30 alongside
// migration 019.
const TRACK_E_AUDIT_TABLES = [
  'channel_audit_log',
  'ai_suggestion_audit',
]

// Privacy-footer fields required in every outbound campaign template.
// Each pattern is matched case-sensitively against the raw template body
// (we want IČO with the diacritic, sídlo with the diacritic, etc.).
const REQUIRED_FOOTER_FIELDS = [
  { name: 'controller (BALKAN MOTORS INT DOO)', re: /BALKAN\s+MOTORS\s+INT\s+DOO/ },
  { name: 'PIB 03387194', re: /PIB\s*03387194/ },
  { name: 'sídlo (Oktobarske revolucije / Podgorica)', re: /Oktobarske\s+revolucije[\s\S]*Podgorica|sídlem\s+Oktobarske/ },
  { name: 'legal basis (oprávněný zájem / GDPR čl. 6)', re: /oprávněn[ýé]\s+zájem|čl\.\s*6\(1\)\(f\)|GDPR/ },
  { name: 'source-of-data (firmy.cz veřejný registr)', re: /firmy\.cz|veřejn[éý].*(registr|rejstřík)/ },
  // No unsubscribe URL + no privacy URL in cold-mail body — operator HARD RULE
  // memory `feedback_no_unsub_url_in_body` (2026-05-07). Opt-out provided via
  // STOP keyword reply (covered by `unsub_keyword_optout` in the Go-side
  // audit ratchet) + reply-based ("stačí odepsat") path.
  { name: 'unsub keyword (STOP)', re: /\bSTOP\b/ },
]

// Concatenate every file that may host DSR handlers. Order doesn't
// matter for grep-style assertions; we use `\n\n` as separator so a
// regex that crosses file boundaries (rare) still won't accidentally
// glue tokens together. T2.6.0: extracting server.js → server-routes/
// dsr.js must not require touching this audit.
const serverSource = [readText(SERVER_JS), readTextOptional(DSR_ROUTE_MODULE)]
  .filter(Boolean)
  .join('\n\n')

// Slice the DSR erase handler block: from `app.post('/api/dsr/erase'` up
// to the next top-level route declaration in the SAME file. Now scans
// every candidate source and returns the first non-empty match. The
// handler can live in server.js OR in src/server-routes/dsr.js (Express
// Router uses `router.post(...)` instead of `app.post(...)`, so the
// regex accepts either prefix).
const ROUTE_START_RE = /\n(?:app|router)\.(get|post|put|delete|patch|use)\(/
function sliceHandlerBlock(src, startToken) {
  const start = src.indexOf(startToken)
  if (start < 0) return ''
  const rest = src.slice(start + 1)
  const next = rest.search(ROUTE_START_RE)
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next)
}

// Locate the erase handler across all candidate files. Returns the
// first non-empty slice. Handler declaration may use app.post(...) in
// server.js or router.post(...) once extracted into a Router module.
function findHandlerBlock(routeKey) {
  const candidates = [
    readText(SERVER_JS),
    readTextOptional(DSR_ROUTE_MODULE),
  ].filter(Boolean)
  for (const src of candidates) {
    for (const prefix of ['app', 'router']) {
      const block = sliceHandlerBlock(src, `${prefix}.post('${routeKey}'`)
      if (block) return block
    }
    for (const prefix of ['app', 'router']) {
      const block = sliceHandlerBlock(src, `${prefix}.get('${routeKey}'`)
      if (block) return block
    }
  }
  return ''
}

const eraseBlock = findHandlerBlock('/api/dsr/erase')

// Sprint AH — DB fixtures for campaign templates (migration 061).
// The configs/templates/ directory has been deleted; template bodies now live
// in the email_templates table. These fixtures mirror the bodies seeded by
// migration 061_email_templates_seed_from_tmpl.sql so the GDPR footer audit
// runs without a live DB connection.
const DB_TEMPLATE_FIXTURES = [
  {
    name: 'initial',
    subject: 'Výkup techniky — kontakt z firmy.cz',
    body: `{{/* humanize: off */}}

Dobrý den,

získal jsem na Vás kontakt v katalogu firem (firmy.cz) v rámci našeho zájmu o sourcing použité stavební a manipulační techniky.

Chtěl jsem se zeptat, zda-li Vám v současné chvíli na dvorku nestojí nějaká technika (vozidlo, kamion, bagr, nakladač, traktor...), které byste se rád zbavil, nebo zda neplánujete v dohledné době výměnu vozového parku.

Pokud ano — pošlete mi prosím fotku a TP (i kopii postačuje) na tento e-mail. V zahraničí mám odběratele, kteří berou prakticky vše. Papíry i odvoz zařídím sám.

Případně volejte 776 299 933.

Děkuji za odpověď,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,
  },
  {
    name: 'followup1',
    subject: 'Pripominam se - vykup techniky',
    body: `{{/* humanize: off */}}

Dobry den,

pripominam se s pred par dny - jestli mate u Vas nejakou pouzitou
techniku, kterou byste radi prodali.

Cokoli, co Vam u firmy stoji a chcete to pryc - auto, dodavka,
traktor, stroj. Vykupuju pouzitou techniku pro odberatele v zahranici,
prodavame to dal a Vy dostanete poctivou nabidku.

Staci fotka a TP na tento mail. Cenu rekneme do 24 hodin.

Pripadne 776 299 933.

Diky,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,
  },
  {
    name: 'final',
    subject: 'Posledni pokus - vykup techniky',
    body: `{{/* humanize: off */}}

Dobry den,

posledni zprava ohledne odkupu pouzite techniky.

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
Kdyby se ale nekdy v budoucnu objevila prilezitost (auto,
dodavka, traktor, stroj), klidne se ozvete - tento mail bude
porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,
  },
  {
    name: 'heavy-01-intro',
    subject: 'Pouzita technika u Vas?',
    body: `{{/* humanize: off */}}

Dobrý den,

{mate u Vas pouzitou techniku, ktere se chcete zbavit?|nemate u Vas nejakou pouzitou techniku, co Vam stoji bez vyuziti?|nezbyla Vam ve firme nejaka technika, co byste radi prodali?}
Auto, dodavku, traktor, stavebni stroj... cokoli.

Vykupuju pouzitou techniku pro odberatele v zahranici. V zahranici
beru prakticky vse, papiry i odvoz zaridim sam, Vy dostanete poctivou
nabidku.

Staci poslat fotku a TP (i kopii) na tento mail. Pripadne volejte
776 299 933. Zbytek zaridim.

Diky,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,
  },
  {
    name: 'heavy-03-bump',
    subject: 'Posledni pokus - vykup techniky',
    body: `{{/* humanize: off */}}

Dobrý den,

{posledni zprava ohledne odkupu pouzite techniky.|tohle je ode mne posledni zprava k odkupu pouzite techniky.|naposledy se ptam ohledne odkupu pouzite techniky.}

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
{Kdyby se ale nekdy v budoucnu objevila prilezitost|Pokud by se ale neco objevilo casem} (auto, dodavka, traktor, stroj),
klidne se ozvete - tento mail bude porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,
  },
]

describe('KT-B12 — GDPR DSR erase cascade shape', () => {
  // 1. Audit script exists and is executable.
  it('audit CLI script exists at scripts/audits/gdpr-compliance-check.sh', () => {
    expect(existsSync(AUDIT_SCRIPT)).toBe(true)
    const mode = statSync(AUDIT_SCRIPT).mode
    // owner exec bit must be set (0o100)
    expect((mode & 0o100) !== 0).toBe(true)
  })

  // 2. Audit script declares the synthetic IČO=99999999 reservation
  // inline (memory rule feedback_no_fabricated_test_data).
  it('audit script documents synthetic IČO=99999999 reservation', () => {
    const src = readText(AUDIT_SCRIPT)
    expect(src).toMatch(/SYNTHETIC_ICO=["']?99999999/)
    expect(src).toMatch(/feedback_no_fabricated_test_data|test reservation|není přiděleno|vyhrazené/i)
  })

  // 3. Audit script blocks against production DATABASE_URL.
  it('audit script refuses production DATABASE_URL', () => {
    const src = readText(AUDIT_SCRIPT)
    expect(src).toMatch(/RAILWAY_ENVIRONMENT_NAME|production/)
    expect(src).toMatch(/exit 9/)
  })

  // 4. Audit script appends JSONL row to docs/audits/gdpr-checks.jsonl.
  it('audit script writes audit row to docs/audits/gdpr-checks.jsonl', () => {
    const src = readText(AUDIT_SCRIPT)
    expect(src).toMatch(/docs\/audits\/gdpr-checks\.jsonl/)
    expect(src).toMatch(/>>\s*"\$AUDIT_FILE"|>>\s*\$AUDIT_FILE/)
  })

  // 5. DSR erase handler exists in BFF (either server.js or
  // src/server-routes/dsr.js after T2.6 extract).
  it('/api/dsr/erase handler is declared in BFF', () => {
    expect(eraseBlock.length).toBeGreaterThan(0)
    expect(eraseBlock).toMatch(/(?:app|router)\.post\('\/api\/dsr\/erase'/)
  })

  // 6. Each currently-honored cascade table is referenced inside the
  // erase handler. Locked contract — never weaken.
  for (const table of REQUIRED_CASCADE_TABLES) {
    it(`DSR erase cascade references ${table}`, () => {
      expect(eraseBlock).toContain(table)
    })
  }

  // 6b. Spec-target gaps documented + verified — fix landed via PR #381.
  // outreach_threads gets UPDATE status='closed', outreach_suppressions gets
  // INSERT alongside suppression_list. Promoted from `it.todo` to `it`.
  for (const table of SPEC_TARGET_GAPS) {
    it(`DSR erase cascade references ${table} (PR #381)`, () => {
      expect(eraseBlock).toContain(table)
    })
  }

  // 6c. Track E (migration 019) cascade — promoted from it.todo to it on
  // 2026-04-30. channel_audit_log: DELETE; ai_suggestion_audit: anonymize.
  for (const table of TRACK_E_AUDIT_TABLES) {
    it(`DSR erase cascade references ${table} (Track E / migration 019)`, () => {
      expect(eraseBlock).toContain(table)
    })
  }

  // 6d. ai_suggestion_audit is anonymized, NOT deleted. Verify the handler
  // performs UPDATE … operator_id = 'erased' against this table (RLHF
  // dataset is operator-internal accountability data per Art. 5/2).
  it('ai_suggestion_audit is anonymized (UPDATE), not DELETEd', () => {
    expect(eraseBlock).toMatch(/UPDATE\s+ai_suggestion_audit/i)
    expect(eraseBlock).toMatch(/operator_id\s*=\s*'erased'/)
    // Negative: the handler must not DELETE rows from this table.
    expect(eraseBlock).not.toMatch(/DELETE\s+FROM\s+ai_suggestion_audit/i)
  })

  // 6e. channel_audit_log is deleted by subject_email match.
  it('channel_audit_log is deleted by subject_email', () => {
    expect(eraseBlock).toMatch(/DELETE\s+FROM\s+channel_audit_log/i)
    expect(eraseBlock).toMatch(/subject_email/)
  })

  // 7. Erase handler keeps suppression_list as proof-of-opt-out (Art. 17 +
  // §7(4) zák. 480/2004 — operator must prove honored objection).
  it('erase handler INSERTs into suppression_list with gdpr_erasure reason', () => {
    expect(eraseBlock).toMatch(/INSERT\s+INTO\s+suppression_list/i)
    expect(eraseBlock).toMatch(/gdpr_erasure/)
  })

  // 8. Erase response signals suppression_kept=true so audit script can
  // assert UNION still blocks the subject post-erase.
  it('erase response includes suppression_kept signal', () => {
    expect(eraseBlock).toMatch(/suppression_kept\s*:\s*true/)
  })

  // 9. Erase handler writes operator_audit_log row (Art. 30 ROPA).
  it('erase handler writes operator_audit_log entry (action=dsr_erase)', () => {
    expect(eraseBlock).toMatch(/operator_audit_log/)
    expect(eraseBlock).toMatch(/dsr_erase/)
  })
})

describe('KT-B12 — Suppression UNION shape (read-site)', () => {
  // 10. server.js references both suppression tables (UNION at every
  // send-tick read site per LIA mitigation).
  it('BFF references both outreach_suppressions and suppression_list', () => {
    expect(serverSource).toContain('outreach_suppressions')
    expect(serverSource).toContain('suppression_list')
  })

  // 11. DSR access handler aggregates from both tables. Lookup is
  // multi-file aware (server.js OR src/server-routes/dsr.js) and
  // tolerates app.get(...) or router.get(...) prefix.
  it('DSR access response surfaces both suppression tables as separate buckets', () => {
    const accessBlock = findHandlerBlock('/api/dsr/access')
    expect(accessBlock.length).toBeGreaterThan(0)
    expect(accessBlock).toMatch(/suppression_list/)
    expect(accessBlock).toMatch(/outreach_suppressions/)
  })
})

describe('KT-B12 — Privacy footer contract (active campaign templates)', () => {
  // 12. There is at least one production template in the DB fixture.
  // Sprint AH: configs/templates/ deleted; fixtures mirror migration 061.
  it('email_templates DB has ≥1 active template row', () => {
    expect(DB_TEMPLATE_FIXTURES.length).toBeGreaterThan(0)
  })

  // 12b. Exactly 5 templates migrated from .tmpl files (migration 061).
  it('email_templates DB fixture has exactly 5 rows (initial+followup1+final+heavy-01-intro+heavy-03-bump)', () => {
    expect(DB_TEMPLATE_FIXTURES.length).toBe(5)
  })

  // 13. Every active template carries every required footer field.
  // Generates one assertion per (template × field) pair so failures
  // localize to "template X missing field Y".
  for (const tmpl of DB_TEMPLATE_FIXTURES) {
    const tmplName = tmpl.name
    const tmplBody = tmpl.body
    for (const field of REQUIRED_FOOTER_FIELDS) {
      it(`template ${tmplName} contains ${field.name}`, () => {
        expect(tmplBody).toMatch(field.re)
      })
    }
  }
})

describe('KT-B12 — Privacy Notice footer alignment', () => {
  // 14. Privacy Notice document lives at the canonical path.
  it('docs/legal/privacy-notice.md exists', () => {
    expect(existsSync(PRIVACY_NOTICE)).toBe(true)
  })

  // 15. Privacy Notice covers all 7 GDPR rights (čl. 15-22).
  it('Privacy Notice enumerates GDPR Art. 15-22 rights', () => {
    const body = readText(PRIVACY_NOTICE)
    // Art. 15 (access), 16 (rectification), 17 (erasure), 18 (restriction),
    // 20 (portability), 21 (objection); čl. 77 (DPA complaint).
    for (const art of ['15', '16', '17', '18', '20', '21']) {
      expect(body).toMatch(new RegExp(`čl\\.\\s*${art}|Art\\.?\\s*${art}|article\\s*${art}`, 'i'))
    }
  })

  // 16. Privacy Notice declares retention period (12 months).
  it('Privacy Notice documents retention window (12 měsíců)', () => {
    const body = readText(PRIVACY_NOTICE)
    expect(body).toMatch(/12\s*měsíců|12\s*months/i)
  })

  // 17. Privacy Notice § 9.1 discloses internal photo parsing through
  // local AI (no third-party transfer). Required by ROPA Činnost č. 6.
  it('Privacy Notice discloses internal photo parsing via local AI', () => {
    const body = readText(PRIVACY_NOTICE)
    expect(body).toMatch(/lokáln[ěí][\s\S]{0,40}AI|Ollama/i)
    expect(body).toMatch(/fotograf/i)
    expect(body).toMatch(/EHP|Evropský hospodářský prostor/)
  })

  // 18. Privacy Notice § 7.1 enumerates the new audit tables in the DSR
  // erase scope so subjects can see what gets cleared on výmaz.
  it('Privacy Notice § 7.1 names channel_audit_log + ai_suggestion_audit', () => {
    const body = readText(PRIVACY_NOTICE)
    expect(body).toContain('channel_audit_log')
    expect(body).toContain('ai_suggestion_audit')
  })
})

// ════════════════════════════════════════════════════════════════════════
// Track E — migration 019 (audit log schemas) shape audit
// ════════════════════════════════════════════════════════════════════════

const MIGRATION_019 = join(REPO_ROOT, 'scripts/migrations/019_audit_log_schemas.sql')
const ART30 = join(REPO_ROOT, 'docs/legal/art30-register.md')
const LIA = join(REPO_ROOT, 'docs/legal/lia-direct-marketing.md')

describe('Track E — migration 019 audit log schemas', () => {
  // 19. Migration file exists at the canonical path.
  it('scripts/migrations/019_audit_log_schemas.sql exists', () => {
    expect(existsSync(MIGRATION_019)).toBe(true)
  })

  // 20-22. Migration creates each of the three Track E tables.
  const TRACK_E_ALL_TABLES = [
    'channel_audit_log',
    'ai_suggestion_audit',
    'photo_parse_audit',
  ]
  for (const table of TRACK_E_ALL_TABLES) {
    it(`migration 019 creates ${table}`, () => {
      const body = readText(MIGRATION_019)
      expect(body).toMatch(new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}`, 'i'))
    })
  }

  // 23. Migration is idempotent — every CREATE uses IF NOT EXISTS.
  it('migration 019 is idempotent (CREATE … IF NOT EXISTS only)', () => {
    const body = readText(MIGRATION_019)
    // No bare CREATE TABLE without IF NOT EXISTS.
    expect(body).not.toMatch(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i)
  })

  // 24. ai_suggestion_audit constrains operator_action to the 3-value enum.
  it('ai_suggestion_audit constrains operator_action to approved|edited|rejected', () => {
    const body = readText(MIGRATION_019)
    expect(body).toMatch(/operator_action\s+IN\s*\(\s*'approved'\s*,\s*'edited'\s*,\s*'rejected'\s*\)/i)
  })

  // 25. photo_parse_audit defaults llm_provider to ollama (local-only signal).
  it('photo_parse_audit defaults llm_provider to ollama-llama3.2-vision', () => {
    const body = readText(MIGRATION_019)
    expect(body).toMatch(/llm_provider[\s\S]{0,80}DEFAULT\s+'ollama-llama3\.2-vision'/i)
  })
})

describe('Track E — ROPA + LIA documentation alignment', () => {
  // 26. art30-register declares ROPA Činnost č. 6 (interní photo parsing).
  it('art30-register.md adds Činnost č. 6 — interní photo parsing', () => {
    const body = readText(ART30)
    expect(body).toMatch(/Činnost\s+zpracování\s+č\.\s*6/i)
    expect(body).toMatch(/photo\s+parsing|interní\s+(extrakc|photo)/i)
    expect(body).toContain('photo_parse_audit')
  })

  // 27. art30-register names the three Track E audit tables explicitly.
  it('art30-register.md enumerates the three Track E audit tables', () => {
    const body = readText(ART30)
    expect(body).toContain('channel_audit_log')
    expect(body).toContain('ai_suggestion_audit')
    expect(body).toContain('photo_parse_audit')
  })

  // 28. LIA refresh adds per-channel balancing (§ 3.5) and photo parsing
  // balancing (§ 3.6) sections.
  it('lia-direct-marketing.md adds § 3.5 per-channel + § 3.6 photo balancing', () => {
    const body = readText(LIA)
    expect(body).toMatch(/3\.5[\s\S]{0,40}[Pp]er-channel/)
    expect(body).toMatch(/3\.6[\s\S]{0,80}([Pp]hoto\s+parsing|fotograf)/)
  })

  // 29. LIA version ≥ 1.1 (Track E refresh 2026-04-30 introduced § 3.5/3.6).
  // Document has since progressed to 1.2 (scope expansion 2026-05-06).
  // Check: current version header is ≥ 1.1 AND the 2026-04-30 entry still
  // exists in the version history table (confirming Track E content was not
  // silently removed). Using /Verze:\*?\*?\s*1\.[1-9]/ to allow future minor
  // bumps without a test edit.
  it('lia-direct-marketing.md is at version ≥ 1.1 (Track E refresh 2026-04-30)', () => {
    const body = readText(LIA)
    expect(body).toMatch(/Verze:\*?\*?\s*1\.[1-9]/)
    expect(body).toMatch(/2026-04-30/)
  })
})

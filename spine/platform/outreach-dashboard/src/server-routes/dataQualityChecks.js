// dataQualityChecks.js — GET /api/data-quality — system-wide data-quality checks.
//
// Operator (2026-06-01): "musíme také pravidelně kontrolovat kvalitu našich dat."
// Per-company DQS already exists (lib/dataQuality.js); this is the SYSTEM view:
// a set of deterministic SQL checks over the whole linked model, each returning
// a count + severity, so the operator (and the 'Kvalita dat' surface, which
// polls) sees integrity issues at a glance. Read-only. All counts SELECT-only;
// columns schema-verified 2026-06-01.

// Named thresholds (no magic numbers). The outbound reply worker
// (runOutboundReplyCron, Go runner) polls ~every 90s; a reply still unsent
// after STUCK_OUTBOX_MIN minutes, or that has burned through STUCK_OUTBOX_ATTEMPTS
// dispatch attempts, means the relay path is broken — not normal latency.
const STUCK_OUTBOX_MIN = 15
const STUCK_OUTBOX_ATTEMPTS = 3

// Pipeline-freshness — RELATIVE, not absolute (feedback_relative_not_absolute).
// A flat "no inbound for 24h" / "no send for 24h" false-fires whenever the
// system is legitimately quiet (paused campaign, weekend). Instead each check
// is relative to the activity that SHOULD produce the signal:
//   - ingest is judged relative to OUTBOUND: if we sent recently we should be
//     getting replies; zero inbound while sending is the anomaly. If we're not
//     sending, no inbound is expected → silent.
//   - send is judged relative to CAMPAIGN STATE: a running campaign with pending
//     contacts but no recent sends is a stuck sender; a paused campaign that
//     stops sending is expected → silent (the absolute version flagged paused
//     campaign 457 as noise).
// The only remaining absolutes are unavoidable lookback windows, kept named.
const INGEST_EXPECT_SEND_WINDOW = '7 days'   // sent within this → replies expected
const INGEST_SILENCE_WINDOW = '48 hours'     // …but none arrived in this → anomaly
const SEND_STUCK_WINDOW = '2 hours'          // running campaign + pending but no send in this = stuck

// Declarative checks. severity: 'error' (integrity/dangling), 'warn' (degraded
// readability/classification), 'info' (mineable gap — not a defect, an opportunity).
const CHECKS = [
  { key: 'reply_orphan_contact', label: 'Odpovědi s neexistujícím kontaktem (dangling FK)', severity: 'error',
    hint: 'reply_inbox.contact_id ukazuje na smazaný kontakt → NULLovat (migrace 143 vzor).',
    sql: `SELECT count(*)::int n FROM reply_inbox r WHERE r.contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.id=r.contact_id)` },
  { key: 'vehicle_orphan_company', label: 'Vozidla s neexistující firmou (dangling FK)', severity: 'error',
    hint: 'vehicles.company_id ukazuje na smazanou firmu.',
    sql: `SELECT count(*)::int n FROM vehicles v WHERE v.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM companies c WHERE c.id=v.company_id)` },
  // Interconnection-integrity guards (data hardening 2026-06-01). Currently 0 —
  // they ratchet: surface the FIRST broken link the moment it appears, across
  // the data-mining model (vozidlo↔odpověď↔kontakt↔CRM↔firma).
  { key: 'vehicle_orphan_reply', label: 'Vozidla s neexistující zdrojovou odpovědí (dangling FK)', severity: 'error',
    hint: 'vehicles.source_reply_id ukazuje na smazanou reply_inbox — ztracená vazba vozidlo↔odpověď.',
    sql: `SELECT count(*)::int n FROM vehicles v WHERE v.source_reply_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reply_inbox r WHERE r.id=v.source_reply_id)` },
  { key: 'contact_orphan_crm', label: 'Kontakty s neexistujícím CRM klientem (dangling FK)', severity: 'error',
    hint: 'contacts.crm_client_id ukazuje na smazaný crm_clients — rozbitá vazba kontakt↔CRM.',
    sql: `SELECT count(*)::int n FROM contacts c WHERE c.crm_client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crm_clients k WHERE k.id=c.crm_client_id)` },
  { key: 'duplicate_company_ico', label: 'Duplicitní firmy (stejné IČO)', severity: 'warn',
    hint: 'Dvě+ firmy se stejným IČO → tříští interconnection (vozidla/kontakty se rozpadnou mezi duplikáty). Sloučit.',
    sql: `SELECT COALESCE(sum(c-1),0)::int n FROM (SELECT count(*) c FROM companies WHERE ico IS NOT NULL AND ico<>'' GROUP BY ico HAVING count(*)>1) t` },
  { key: 'duplicate_contact_email', label: 'Duplicitní kontakty (stejný e-mail)', severity: 'warn',
    hint: 'Dva+ kontakty se stejným e-mailem → odpovědi/vozidla se rozpadnou mezi duplikáty. Sloučit.',
    sql: `SELECT COALESCE(sum(c-1),0)::int n FROM (SELECT count(*) c FROM contacts WHERE email IS NOT NULL AND email<>'' GROUP BY lower(email) HAVING count(*)>1) t` },
  { key: 'reply_mime_subject', label: 'Odpovědi s MIME-encoded předmětem v DB', severity: 'warn',
    hint: 'Předmět uložen jako =?UTF-8?Q?…?= — UI dekóduje, ale data jsou nečitelná. Kandidát na backfill.',
    sql: `SELECT count(*)::int n FROM reply_inbox WHERE subject LIKE '=?%?=%'` },
  { key: 'manual_reply_stuck', label: 'Operátorské odpovědi uvízlé ve frontě', severity: 'error',
    hint: `manual_reply_outbox: neodesláno přes ${STUCK_OUTBOX_MIN} min nebo ≥${STUCK_OUTBOX_ATTEMPTS} pokusů → relay worker pravděpodobně stojí. Operátor si myslí, že odpověděl, ale mail neodešel.`,
    sql: `SELECT count(*)::int n FROM manual_reply_outbox WHERE sent_at IS NULL AND (created_at < now() - INTERVAL '${STUCK_OUTBOX_MIN} minutes' OR attempts >= ${STUCK_OUTBOX_ATTEMPTS})` },
  { key: 'pipeline_ingest_stale', label: 'Posíláme, ale nechodí odpovědi', severity: 'warn',
    hint: `Za poslední týden jsme odeslali, ale za 48 h nepřišla ŽÁDNÁ příchozí (reply_inbox/unmatched_inbound) → IMAP ingest pravděpodobně stojí (RCA 2026-06-01: tichá ztráta příchozích). Relativní k odeslání — když neposíláme, nehlásí se.`,
    sql: `SELECT (
      EXISTS (SELECT 1 FROM send_events WHERE sent_at > now() - INTERVAL '${INGEST_EXPECT_SEND_WINDOW}')
      AND NOT EXISTS (SELECT 1 FROM reply_inbox WHERE received_at > now() - INTERVAL '${INGEST_SILENCE_WINDOW}')
      AND NOT EXISTS (SELECT 1 FROM unmatched_inbound WHERE received_at > now() - INTERVAL '${INGEST_SILENCE_WINDOW}')
    )::int n` },
  { key: 'pipeline_send_stuck', label: 'Běžící kampaň neodesílá', severity: 'warn',
    hint: `Kampaň je 'running' a má pending kontakty, ale za 2 h neproběhl žádný send → zaseklý sender. Relativní ke stavu kampaně — pozastavená kampaň se nehlásí (na rozdíl od fixního „24h bez odeslání").`,
    sql: `SELECT (
      EXISTS (
        SELECT 1 FROM campaigns c
        JOIN campaign_contacts cc ON cc.campaign_id = c.id AND cc.status = 'pending'
        WHERE c.status = 'running'
      )
      AND NOT EXISTS (SELECT 1 FROM send_events WHERE sent_at > now() - INTERVAL '${SEND_STUCK_WINDOW}')
    )::int n` },
  { key: 'reply_unclassified', label: 'Nezařazené odpovědi', severity: 'warn',
    hint: 'classification IS NULL — klasifikátor (regex/Ollama) je nezpracoval.',
    sql: `SELECT count(*)::int n FROM reply_inbox WHERE classification IS NULL` },
  { key: 'vehicle_sparse_info', label: 'Vozidla bez identifikace (model + rok)', severity: 'warn',
    hint: 'Jen značka, chybí model i rok → auto nelze zařadit do aukce. Extrakce z odpovědi nezachytila detaily; doplnit ručně nebo přetěžit. (Cena se neřeší — obchod jde přes aukci/telefon.)',
    sql: `SELECT count(*)::int n FROM vehicles WHERE (model IS NULL OR model='') AND year IS NULL AND status <> 'cancelled'` },
  { key: 'crm_no_ico', label: 'CRM klienti bez IČO', severity: 'info',
    hint: 'crm_clients bez IČO → nelze spárovat s firmami přes registr.',
    sql: `SELECT count(*)::int n FROM crm_clients WHERE ico IS NULL OR ico=''` },
  { key: 'positive_reply_no_vehicle', label: 'Zájem bez zachyceného vozidla', severity: 'info',
    hint: 'Někdo odpověděl se zájmem, ale jeho technika ještě není v aukční pipeline (vehicles.source_reply_id). To je jádro výkupu — „lead JE vozidlo". Otevři odpověď a zachyť vozidlo přes 🚚 v composeru.',
    sql: `SELECT count(*)::int n FROM reply_inbox r WHERE r.classification='positive' AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.source_reply_id = r.id)` },
  { key: 'positive_reply_no_crm', label: 'Zapojené kontakty (positive) mimo CRM', severity: 'info',
    hint: 'Kontakt odpověděl se zájmem, ale není v CRM knize — nevytěžený lead.',
    sql: `SELECT count(DISTINCT r.contact_id)::int n FROM reply_inbox r WHERE r.classification='positive' AND r.contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM contacts c WHERE c.id=r.contact_id AND c.crm_client_id IS NOT NULL)` },
  { key: 'hot_reply_phone_unsaved', label: 'Zájem s telefonem v e-mailu, ale neuloženým u kontaktu', severity: 'warn',
    hint: 'Vytěžili jsme z odpovědi telefon, ale kontakt ho nemá uložený → nezavolatelný hot lead. Výkup se uzavírá telefonem: otevři odpověď, klikni „💾 ke kontaktu" u čísla a zavolej.',
    sql: `SELECT count(*)::int n FROM reply_inbox r WHERE r.classification='positive' AND r.mined IS NOT NULL AND jsonb_array_length(r.mined->'phones') > 0 AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = r.contact_id AND c.phone IS NOT NULL AND c.phone <> '')` },
]

export function mountDataQualityRoute(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/data-quality', async (req, res) => {
    try {
      const results = await Promise.all(CHECKS.map(async (c) => {
        const { rows: [{ n }] } = await pool.query(c.sql)
        return { key: c.key, label: c.label, severity: c.severity, hint: c.hint, count: Number(n) || 0 }
      }))
      const errors = results.filter((r) => r.severity === 'error' && r.count > 0).length
      const warnings = results.filter((r) => r.severity === 'warn' && r.count > 0).length
      res.json({ checked_at: new Date().toISOString(), errors, warnings, checks: results })
    } catch (e) { capture500(res, e, safeError) }
  })
}

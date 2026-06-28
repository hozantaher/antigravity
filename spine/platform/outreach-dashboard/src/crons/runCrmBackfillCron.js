// runCrmBackfillCron.js — iter62 (autonomous sync)
// ─────────────────────────────────────────────────────────────────────────────
// Daily auto-link of newly-ingested contacts → crm_clients (by ICO then email),
// so the link no longer depends on the operator clicking POST /api/crm/backfill-run.
// New contacts/companies added between manual runs were drifting unlinked; this
// keeps the residual trending to 0 hands-off ("plně autonomní sync" between
// contacts ↔ CRM clients). Reuses the single shared rule in lib/crmBackfill.js.
//
// HARD feedback_audit_log_on_mutations T0 — runCrmBackfill writes the audit row
// in-tx when total>0. HARD feedback_no_magic_thresholds T0 — cap is a named const.

import { runCrmBackfill, CRM_BACKFILL_MAX_ROWS_DEFAULT } from '../lib/crmBackfill.js'

export async function runCrmBackfillCron(pool) {
  const r = await runCrmBackfill(pool, {
    maxRows: CRM_BACKFILL_MAX_ROWS_DEFAULT,
    actor: 'cron:runCrmBackfillCron',
  })
  // slog convention: op field + counts only (no PII).
  console.log(`[cron] runCrmBackfillCron op=crmBackfill/done ico_matched=${r.ico_matched} email_matched=${r.email_matched} total=${r.total} duration_ms=${r.duration_ms}`)
  return r
}

// src/lib/mailboxPassword.js
//
// R1 / S3.3 — Per-mailbox password resolution.
//
// Single source of truth for the row-first / env-fallback logic.
// Imported by:
//   - apps/outreach-dashboard/campaign-send-batch.mjs (CLI)
//   - apps/outreach-dashboard/scripts/mailbox-warmup-ramp.mjs (warmup)
//
// Per HARD RULE feedback_mailbox_passwords_via_db:
//   Primary source = outreach_mailboxes.password per DB row.
//   Fallback = SMTP_PASSWORD env var (optional, backward compat).
//
// Per HARD RULE feedback_no_pii_in_commands:
//   Error messages contain only mailbox_id, never password values.

'use strict';

/**
 * Resolve effective SMTP password for a mailbox row.
 *
 * Priority:
 *   1. mb.password (DB row) — if non-null and non-empty after trim
 *   2. fallback            — SMTP_PASSWORD env var (may be null/undefined)
 *
 * Throws with code='MAILBOX_NO_PASSWORD' if neither is available.
 *
 * @param {{ id: number, [key: string]: unknown, password?: string|null }} mb
 * @param {string|null|undefined} fallback  — env var value (may be absent)
 * @returns {string}
 */
export function resolveMailboxPassword(mb, fallback) {
  const rowPwd = mb.password && mb.password.trim().length > 0 ? mb.password : null;
  const effective = rowPwd ?? (fallback && fallback.trim().length > 0 ? fallback : null);
  if (!effective) {
    throw Object.assign(
      new Error(
        `No password for mailbox ${mb.id} (row.password NULL and SMTP_PASSWORD fallback unset — set via UI/DB)`
      ),
      { code: 'MAILBOX_NO_PASSWORD', mailbox_id: mb.id }
    );
  }
  return effective;
}

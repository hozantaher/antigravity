---
status: draft (awaiting operator review)
date: 2026-05-29
trigger: "monkey method — plné napojení, plná editovatelnost"
---

# Plné napojení + editovatelnost audit

## Summary

- **Plné napojení gaps: 5**
- **Plná editovatelnost gaps: 9**
- **Estimated implementation effort: medium** (largest items are 1–2 days each)

---

## Plné napojení — discovered gaps

| # | Component / Page | Symptom | Suggested fix | Priority |
|---|------------------|---------|---------------|----------|
| 1 | `/vehicles` → `/vehicles/:id` | `VehiclesTableRow` calls `navigate('/vehicles/${r.id}')` on click; no such route registered in `main.jsx`; comment in `main.jsx` says "AU-F4 will add VehicleDetail"; router falls through to Navigate-to-/ | Register route + implement `VehicleDetail` page (AU-F4 as planned) | HIGH |
| 2 | `Contacts` empty-state CTA | `<a href="/contacts/import">` is a raw anchor that points to `/contacts/import`; no such route exists in `main.jsx` and no matching page file; hard 404 | Add `/contacts/import` route backed by `CrmImportModal` pattern, or change CTA to `/crm/clients` (XLSX import already works there) | HIGH |
| 3 | `VerifikaceAdresCard` — dead component | Component docstring says "mounts into PripravaRana's card list" with pause/resume/bulk-enqueue buttons; `PripravaRana.jsx` never imports it; the pause/resume API endpoints (`/api/contacts/verify/pause`, `/api/contacts/verify/resume`) are fully wired server-side but the UI is unreachable | Mount `VerifikaceAdresCard` in `PripravaRana` (where docstring says it belongs) or explicitly delete it if replaced by `VerifyQueueWidget` | HIGH |
| 4 | `MailboxDrawer` — `auto_recover_disabled` state displayed nowhere | `server.js` exposes `auto_recover_disabled: process.env.BFF_AUTO_RECOVER === '0'` in the health endpoint response; no dashboard surface renders this flag; operator cannot see when auto-recovery is disabled | Surface `auto_recover_disabled` in `MailboxDrawer` health tab or `DiagnostikaAnonymita` | MEDIUM |
| 5 | `AnalyticsCronsTab` — MIGRATED_* cron status invisible | `server.js` skips BFF cron scheduling when `MIGRATED_IMAP_POLL` / `MIGRATED_OUTBOUND_REPLY` / `MIGRATED_BOUNCE_*` / `MIGRATED_GREYLIST_RETRY` env vars are set; Crons tab shows heartbeats but no panel shows which crons are running in BFF vs delegated to Go runner | Add "Cron migration status" panel to `AnalyticsCronsTab` showing env-driven flags and their current state | MEDIUM |

---

## Plná editovatelnost — discovered gaps

| # | Value | Currently in | Should be in | Suggested UI |
|---|-------|--------------|--------------|--------------|
| 1 | `MAILBOX_MIN_SPACING_SECONDS` env (BFF fallback) | `.env` file (`operatorMetrics.js` reads `process.env.MAILBOX_MIN_SPACING_SECONDS` as fallback) | `operator_settings.mailbox_min_spacing_seconds_default` exists as DB key but is **not** in `ALLOWED_KEYS` in `operatorSettings.js` and has no UI | Add `mailbox_min_spacing_seconds_default` to `ALLOWED_KEYS` + `thresholdDefaults.js` DISTRIBUTION_CAPACITY group + render in `/settings/thresholds` | HIGH |
| 2 | `SEND_BATCH_RATE_LIMIT_MS` | `.env` file only; `campaigns.js` reads env at module load, no DB fallback path | `operator_settings` | Add to thresholdDefaults + ALLOWED_KEYS + Thresholds tab (int, ms, [1000–300000]) | MEDIUM |
| 3 | 5 threshold keys in `thresholdDefaults.js` but NOT in `ALLOWED_KEYS` | UI renders them (they come from `THRESHOLD_GROUPS`), but `PUT /api/operator-settings/:key` returns 404 for saves | Missing from `ALLOWED_KEYS` set in `operatorSettings.js`: `auth_fail_pause_threshold`, `spam_complaint_pause_threshold`, `imap_inbox_audit_gap_threshold`, `imap_inbox_audit_enabled`, `presend_smtp_probe_high_risk_domains` | Add 5 keys to `ALLOWED_KEYS`; also add type validation specs for the two new numeric keys if missing from server-side `SPEC_BY_KEY` | HIGH |
| 4 | `MIGRATED_IMAP_POLL`, `MIGRATED_OUTBOUND_REPLY`, `MIGRATED_BOUNCE_FLIP`, `MIGRATED_BOUNCE_THROTTLE`, `MIGRATED_BOUNCE_RATE_MONITOR`, `MIGRATED_MAILBOX_HEALING`, `MIGRATED_GREYLIST_RETRY` | `.env` file only; control which crons run in BFF vs Go runner; changing requires `.env` edit + BFF restart | `operator_settings` with a dedicated "Cron migration" section | Add 7 boolean keys to `operator_settings`; server.js reads DB at startup (DB wins over env); surface in `AnalyticsCronsTab` "Cron routing" section with toggle buttons | MEDIUM |
| 5 | `BFF_AUTO_RECOVER` | `.env` file only; disabling prevents BFF from healing quarantined mailboxes | `operator_settings.bff_auto_recover_enabled` (boolean) | Add to `operator_settings` + `/settings/thresholds` Toggles group | MEDIUM |
| 6 | `VERIFY_LOOP_CONTACTS_ENABLED` env (boot-gate) | `.env` file — still acts as a boot-gate; if unset, cron is only enabled by DB flag; but if set to `'false'` in env it overrides DB | Code comment says "DB is authoritative per-tick"; env is only a boot log annotation now; however `verifyLoop.js` reads `process.env.VERIFY_LOOP_CONTACTS_ENABLED === 'true'` as a fallback at 3 call sites | Deprecate env fallback in `verifyLoop.js`; rely solely on `operator_settings.verify_loop_enabled` (already in ALLOWED_KEYS + UI) | LOW |
| 7 | `EMAIL_VERIFY_SMTP` / `EMAIL_VERIFY_FROM` | `.env` file only; controls whether contact verify uses SMTP probes and which from-address | `operator_settings.email_verify_smtp_enabled` + `operator_settings.email_verify_from_address` | Add to `operator_settings` + Thresholds tab (boolean + string) | LOW |
| 8 | `WIREPROXY_POOL_CONFIG` | `.env` file as JSON array; parsed in `mailboxes.js` and `poolCapacityMonitor.js` | No DB fallback; complex JSON structure not suited for operator_settings free-form string | Add a dedicated `PoolConfig` panel in `DiagnostikaAnonymita` page (read-only display + paste-to-update) | LOW |
| 9 | `EXPECTED_EGRESS_COUNTRIES` | `.env` file only; used in preflight check for egress country validation (default `'CZ'`) | `operator_settings.expected_egress_countries` (CSV string) | Add to `operator_settings` + `/settings/branding` or Thresholds tab | LOW |

---

## Top 10 highest-impact wins

1. **Add 5 missing keys to `ALLOWED_KEYS`** (gap E3) — one-liner fix in `operatorSettings.js`; unblocks existing threshold UI rows that silently fail on Save; zero UX change required. ~30 min.

2. **Wire `/vehicles/:id` route** (gap N1) — every vehicle row click currently navigates to `/`; AU-F4 is the planned work; stub page acceptable as intermediate. ~2h.

3. **Mount `VerifikaceAdresCard` in `PripravaRana`** (gap N3) — full pause/resume/bulk-enqueue UI exists and is server-wired; it just needs an import + JSX mount. ~1h.

4. **Add `mailbox_min_spacing_seconds_default` to ALLOWED_KEYS + Thresholds tab** (gap E1) — the DB column is already queried; just missing from API allowlist + thresholdDefaults. ~1h. Directly impacts send pacing control without env edits.

5. **Fix `/contacts/import` dead CTA** (gap N2) — either add a route or redirect CTA to `/crm/clients` which already has XLSX import. ~30 min.

6. **Surface MIGRATED_* flags in AnalyticsCronsTab** (gap N5 + E4) — operator cannot tell which crons are active without reading `.env`; read-only display at minimum, toggles as stretch. ~2h.

7. **Add `SEND_BATCH_RATE_LIMIT_MS` to operator_settings** (gap E2) — currently requires env edit + restart to change send throttle. ~1h.

8. **Add `BFF_AUTO_RECOVER` to operator_settings** (gap E5) — operator cannot disable auto-recovery during incidents without `.env` edit. ~1h.

9. **Add `EMAIL_VERIFY_SMTP` + `EMAIL_VERIFY_FROM` to operator_settings** (gap E7) — verify loop probe config requires restart to change. ~1h.

10. **Deprecate `VERIFY_LOOP_CONTACTS_ENABLED` env fallback** (gap E6) — DB flag already works correctly; remove env reads from 3 call sites in `verifyLoop.js` to avoid operator confusion about which value wins. ~30 min.

---

## Open questions for operator

1. **AU-F4 timeline**: Is `VehicleDetail` page still planned? The row click actively navigates users to `/` — should it be disabled until AU-F4 lands, or should AU-F4 be expedited?

2. **`VerifikaceAdresCard` status**: Was this intentionally removed from `PripravaRana`, or is it an accidental omission? The component is 600 LOC and fully functional. Does `VerifyQueueWidget` (which IS mounted) replace it, or are they complementary?

3. **MIGRATED_* flags in DB**: These control which crons run in BFF vs Go runner (Z3 migration). Is the intent to eventually read them from DB so the operator can flip without `.env` edit, or are they permanent env-only deployment-time switches?

4. **`contacts/import` page**: Was `/contacts/import` (from the empty-state CTA) ever implemented? Or should the CTA redirect to `/crm/clients` where XLSX import already exists?

5. **`WIREPROXY_POOL_CONFIG` editability**: The JSON structure is complex (`[{label,socks_addr,...}]`). Should it stay env-only (sysadmin territory) or should there be a UI panel for adding/removing pool endpoints?

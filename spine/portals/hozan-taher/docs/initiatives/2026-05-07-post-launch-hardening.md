# Post-launch hardening — outreach platform

**Status:** Open
**Datum:** 2026-05-06
**Trigger:** 4 round audit dnes (pre-launch campaign 457) odhalil systematic gaps. Většina nezablokovala launch (workaround inline), ale tvoří technický dluh.

## Cíl
Sjednotit dvě paralelní send paths do jedné, eliminovat data integrity rizika, zavést observability + drift detection, a uzavřít compliance-side mezery zaregistrované při launch prep.

## Sprint H1 — Architectural unification (HIGH, 1-2 týdny)

Dual send path: Go daemon čte `.tmpl` soubor, Node script čte `email_templates` DB. Dnešní launch jsme to obešli (campaign nechán v draft, sendováno čistě skriptem), ale je to fragility waiting to happen.

- H1.1 Zvolit primary path. Doporučení: Go daemon refactor aby četl z DB, protože daemon má víc operačních feature (warmup, rate limit, retry, scheduling) než Node script. Skripty zůstávají jako break-glass tool.
- H1.2 Refactor `features/outreach/campaigns/content/template.go` `Render()` — accept DB connection, fallback `email_templates` row před `os.ReadFile`. File je seed/dev fallback, DB authoritative.
- H1.3 Migrate operator workflow z `campaign-send-batch.mjs` na dashboard "Aktivovat" → daemon path.
- H1.4 Audit ratchet: `TestTemplate_DBPreference` co kontroluje že produkční render path consume DB before file.

## Sprint H2 — Concurrency + idempotency (HIGH, 1 týden)

`campaign-send-batch.mjs` má dvě race holes co dnešnímu launchu nezpůsobily problém jen protože operator je pečlivý.

- H2.1 `SELECT … FOR UPDATE SKIP LOCKED` v transaction wrapping send + UPDATE.
- H2.2 Idempotency check: před POST /v1/submit query `operator_audit_log` na `(campaign_id, contact_id)` — pokud existuje envelope_id, skip s warning.
- H2.3 Crash-resistant state machine: write `attempted_at` ihned po /v1/submit success, ne až po update status.
- H2.4 Convert ad-hoc script na BFF endpoint POST `/api/campaigns/:id/send-batch?count=N`.

## Sprint H3 — Bounce pipeline real validation (MEDIUM, po launchi 24h)

`bounce_events` tabulka prázdná. Pipeline kód existuje, unit testy procházejí, ale end-to-end na production datech nikdy neproběhl.

- H3.1 Po launchi 100 contacts sledovat 24h `bounce_events` table.
- H3.2 Zařadit fixture pro každý hlavní bounce typ (5xx permanent, 4xx temp, OOO, blacklist).
- H3.3 Document bounce processor architecture v `docs/subsystem-maps/bounce-handling.md`.

## Sprint H4 — Operational observability (MEDIUM, 2 týdny)

Dnes jsem několikrát létal naslepo (relay queue stuck, deploy SHA mismatch, daemon vs script status).

- H4.1 BFF endpoint `/api/launch-readiness` rozšířit o relay queue depth alert, daemon last-tick timestamp, deployed SHA per service, drift check `.tmpl` file vs DB.
- H4.2 Sentry alert: relay queue oldest_pending_age > 600s = stuck drain.
- H4.3 Sentry alert: daemon scheduler campaign tick > 5min absent = daemon dead.
- H4.4 End-of-day report generator (cron 17:00 weekday).

## Sprint H5 — Compliance gap closing (MEDIUM, 1 měsíc)

- H5.1 S5 pgcrypto rollout dokončit — mailbox passwords aktuálně cleartext.
- H5.2 Railway DPA finalizovat (preexisting accepted debt).
- H5.3 LIA NACE scope dokumentovat na DB úrovni s alertem na out-of-scope sends.
- H5.4 GDPR Article 14 retention period inline disclosure — zvážit tradeoff.

## Sprint H6 — Cleanup hygiene (LOW, průběžně)

- H6.1 Smaž SMOKE-D contacts + campaigns post-launch (campaign 461 + 462).
- H6.2 Decision o dvou Railway services FAILED (`outreach-dashboard` Nuxt, redeploy attempts).
- H6.3 e2e_test mailbox (id=11583) přesunout do separate seed/test environment.

## Sprint H7 — Documentation + operator runbook (LOW-MEDIUM, 1 týden)

- H7.1 `docs/playbooks/campaign-launch-runbook.md` — krok-za-krokem HARD RULES + ramp commands + halt criteria.
- H7.2 Update `CLAUDE.md` o template DB↔file relationship.
- H7.3 Subsystem map `docs/subsystem-maps/send-paths.md` — diagram daemon vs script flow.

## Sprint S3 — Personalization + segment expansion prep (MEDIUM, pre scale >500/day)

### S3.4 Personalization status (verified 2026-05-06)

- Aktuální `intro_machinery.tmpl` (post PR #960 + PR #995) neobsahuje žádné template variables kromě `{{.UnsubURL}}` — všichni recipienti dostanou identický body. Toto je intentional pro první launch (anonymous outreach feel, žádná mailmerge).
- `substituteVars()` v `campaign-send-batch.mjs` podporuje oba styly placeholderů: `{{.Firma}}` (Go-style) i `{{firma}}` (Node-style). Pipeline je připravena pro variables bez změny infrastruktury.
- Pro S3 segment expansion (>500/day) přidat variables: `{{.Firma}}`, `{{.Region}}`, případně `{{.Jmeno}}` pro osobnější touch. DB pole `company_name`, `region`, `first_name` jsou k dispozici na `contacts` tabulce a jsou mapovány při contact query v skriptu.
- Rendering pipeline verified: `substituteVars()` + `buildUnsubToken()` handle variables i no-variables case bez chyby.
- **Operator decision flag:** před S3 scale rozhodnout — plain text zachovat NEBO aktivovat `{{.Firma}}`/`{{.Region}}` — editace v `email_templates` row id=1889 (DB) nebo v `intro_machinery.tmpl` (file).

**Tests:** 20 cases v `features/platform/outreach-dashboard/tests/unit/scripts/personalization.test.mjs`
- TC01–TC02: Happy path (uppercase + lowercase placeholders)
- TC03–TC05: Empty / null fields — no "null"/"undefined" literals v output
- TC06–TC10: Special chars, Czech diacritics, long strings, emoji, newline injection attempt
- TC11–TC12: Multiple uses of same variable + subject + body substitution
- TC13: Backward compat — plain no-variable template renders without error
- TC14–TC20: HMAC unsub token — length, determinism, campaign/contact ID isolation, verify accept/reject, URL format

## Prioritization

| Sprint | Před launch 457 | Před scale (>500/day) | Před prod release |
|---|---|---|---|
| H1 architectural | netřeba | musí | musí |
| H2 concurrency | mitigated by operator discipline | musí | musí |
| H3 bounce validation | post-launch | musí | musí |
| H4 observability | nice-to-have | musí | musí |
| H5 compliance | post-launch | post | musí |
| H6 cleanup | nice-to-have | průběžně | průběžně |
| H7 docs | post | musí | musí |

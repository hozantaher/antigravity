# Mailbox Lifecycle Protection Framework

**Status:** Open
**Datum:** 2026-05-08
**Trigger:** nowak.gorak@email.cz + goran.nowak@email.cz prohlášeny za "po smrti" 2026-05-08 ~14:00 UTC. Seznam fraud-detection lock po 30 minutách operatorem-řízeného testování. Existující ochranné mechanismy nestačily: warmup ramp byl optional/manual, send rate guard byl bypass-friendly, IMAP poll byl bez quota, full-check probe se mohl spustit 20× za minutu, multi-country IPs nebyly detekované, auth-fails se neauto-quarantinovaly.

Sprint AO řeší **kde** data tečou (single egress per mailbox). Tato iniciativa řeší **kolik a jak často** + **co se může dít s mailboxem v kódu**, aby žádná operator-řízená sekvence nedokázala mailbox zabít znovu.

## Cíl

Po dokončení iniciativy platí:

1. **Žádný operátor (ani autonomní agent) nemůže obcházet warmup ramp** — kód tvrdě odmítne send pokud `sends_today >= warmup_cap_for_age_in_days`. UI nedovolí, BFF endpoint odmítne, Go runner refuse.
2. **Mailbox má locked egress endpoint per lifetime** — první send/probe pinuje endpoint v DB, všechny následné operace MUSÍ stejný endpoint. Změna jen přes operator override s reason audit.
3. **Hard rate limits per operation** — IMAP poll max 4×/h per mailbox; full-check probe max 1× za 30 min; SMTP probe max 1× za 5 min. Kód odmítne víc.
4. **Multi-country detection alarm** — cron každých 5 min; ANY mailbox vidět ze 2+ zemí v 1h okně → auto-status='egress_chaos_detected', alert, operator must investigate.
5. **Test fixture isolation** — produkční kód odmítne použít `outreach_mailboxes WHERE environment='test'`; test/dev kód odmítne `environment='production'`.
6. **Auth-fail auto-quarantine** — 3 auth fails v 1h → status='auth_locked'; operator must manual unlock with reason.

## Sprint AP1 — Warmup ramp enforced in code (P0)

**Co je špatně:** Aktuálně warmup ramp ramp-script je advisory; operátor může poslat 100/day z fresh mailboxu. nowak.gorak dostala 6 sendů + 10 probe v 30 min na den 0 = bot signal.

**Co uděláme:**

- Migrace `068_mailbox_lifecycle_caps.sql`:
  - `outreach_mailboxes.created_at` (already exists)
  - `outreach_mailboxes.lifecycle_phase` (NEW): `warmup_d0` / `warmup_d7` / `warmup_d14` / `production`
  - `outreach_mailboxes.daily_cap_effective` (NEW): readonly computed column from lifecycle_phase
- Trigger before INSERT into `send_events`: SELECT count(*) WHERE mailbox_used=$1 AND sent_at >= today; if >= daily_cap_effective REJECT
- Daily cap formula:
  - Day 0-2: cap=5
  - Day 3-6: cap=10
  - Day 7-13: cap=25
  - Day 14-29: cap=50
  - Day 30+: cap=100 (or operator-set override max 200)
- BFF send-test endpoint refuses with HTTP 429 + Retry-After header
- Go runner refuses with sender.ErrWarmupCapExceeded

**Effort:** 1d. **P0**.

## Sprint AP2 — Per-mailbox egress endpoint pin (P0)

**Co je špatně:** PR #1100 (Sprint AN) `preferred_country` je suggestion, ne pin. Pool může fallback na jiný endpoint pokud preferred quarantined. Pre-PR-#1100 affinity expirovala po 5 sendech. Žádný persistent record.

**Co uděláme:**

- Migrace `069_mailbox_egress_pin.sql`:
  - `outreach_mailboxes.pinned_endpoint_label` (NEW): TEXT, např. 'sk-bts-wg-001'
  - `outreach_mailboxes.pinned_endpoint_at` (NEW): TIMESTAMPTZ
- 1st send/probe of new mailbox: wgpool.Pick chooses from preferred_country, label is recorded back to DB
- 2nd+ operation: wgpool.Pick READS pinned_endpoint_label, uses ONLY that endpoint
- If pinned endpoint quarantined: refuse send + Sentry alert (operator must investigate, NEVER fallback)
- Operator override via `POST /api/mailboxes/:id/repin` with reason field; audit log row
- Backward compat: existing mailboxes get pinned on next send

**Effort:** 1.5d. **P0**.

## Sprint AP3 — Hard rate limits per operation type (P0)

**Co je špatně:** IMAP polling rate not limited per mailbox. full-check spustitelný libovolně. SMTP probe ditto. Operator clicked refresh 5× v UI = 5× IMAP login v 10s = bot signal.

**Co uděláme:**

- Tabulka `mailbox_op_rate_log (mailbox_id, op_type, occurred_at)` — append-only
- Per-mailbox rate caps:
  - `imap_poll`: max 4/h
  - `full_check`: max 2/h
  - `smtp_probe`: max 12/h
  - `imap_inbox_fetch`: max 6/h (operator UI refresh)
  - `send`: governed by AP1 daily cap
- Pre-op check: SELECT count(*) FROM mailbox_op_rate_log WHERE mailbox_id=$1 AND op_type=$2 AND occurred_at > now() - interval '1 hour'; if >= cap REJECT
- INSERT into log on every successful op
- Cleanup cron daily: DELETE WHERE occurred_at < now() - interval '7 days' (privacy + size)

**Effort:** 1d. **P0**.

## Sprint AP4 — Multi-country detection alarm (P0)

**Co je špatně:** nowak.gorak byla viděna ze 4-7 zemí v 30 min. Žádný alarm nezahájil. Žádné auto-pause.

**Co uděláme:**

- Tabulka `mailbox_egress_observation (mailbox_id, egress_ip, country, op_type, observed_at)` — append-only audit
- Insert na každou outbound operation (send, probe, IMAP)
- Cron každých 5 minut:
  ```sql
  SELECT mailbox_id, count(distinct country) AS c
  FROM mailbox_egress_observation
  WHERE observed_at > now() - interval '1 hour'
  GROUP BY mailbox_id
  HAVING count(distinct country) > 1;
  ```
- For each row: UPDATE outreach_mailboxes SET status='egress_chaos_detected'; Sentry alert
- Status 'egress_chaos_detected' is added to email_status enum, blocks sends
- Operator must manually clear via UI with reason

**Effort:** 1d. **P0**.

## Sprint AP5 — Test fixture isolation (P1)

**Co je špatně:** Memory `feedback_no_fabricated_test_data` říká "real data nebo nic" ale **dev/test může omylem hit production mailboxes**. Localhost BFF cron (pnpm dev) běžel proti prod nowak.gorak — kontaminoval reputaci.

**Co uděláme:**

- `outreach_mailboxes.environment` already exists ('production', 'test', 'dev', 'staging')
- Production code (Go runner, BFF send paths) read-only filter: `WHERE environment='production'`
- Test/dev code: read-only filter: `WHERE environment IN ('test', 'dev')` — refuse otherwise with PRODUCTION_LOCK error
- Boundary check at startup: BFF reads NODE_ENV, refuses to start if production code path connects to test mailboxes (and vice versa)
- Audit ratchet test: SELECT FROM outreach_mailboxes scans must include environment filter; baseline 0 violations

**Effort:** 1.5d. **P1**.

## Sprint AP6 — Auth-fail auto-quarantine (P1)

**Co je špatně:** `outreach_mailboxes.auth_fail_count` exists but has no auto-trigger. nowak.gorak post-lock has unlimited retries possible (if operator tries again, more auth-fails accumulate).

**Co uděláme:**

- Existing column `auth_fail_count` + `auth_fail_at`
- Trigger logic: any op (SMTP send, IMAP poll, full-check) gets auth-fail → INSERT into `mailbox_auth_fails (mailbox_id, op_type, error_msg, observed_at)` (table exists per memory)
- Cron every 5 min: count auth_fails per mailbox in last 1h; if >= 3 → UPDATE outreach_mailboxes SET status='auth_locked'
- Status 'auth_locked' blocks all operations
- Operator unlock via `POST /api/mailboxes/:id/clear-auth-lock` with reason
- 24h auto-cooldown: `auth_locked` mailbox can't be unlocked operator-side for 24h (Seznam recovery window)

**Effort:** 1d. **P1**.

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AP1 warmup cap | žádná | 1d | P0 |
| AP2 egress pin | AO1+AO2 (consistent egress) | 1.5d | P0 |
| AP3 op rate limits | žádná | 1d | P0 |
| AP4 multi-country alarm | AP3 (uses op_log table) | 1d | P0 |
| AP5 test isolation | žádná | 1.5d | P1 |
| AP6 auth-fail quarantine | žádná | 1d | P1 |

Total ~7 dní. AP1+AP3+AP5+AP6 nezávislé, paralelně. AP2+AP4 čekají na AO base.

## Otevřené otázky

1. **Operator emergency override** — jak rychle může operátor v UI obejít AP1 warmup cap (např. legitimate emergency)? Reason field + Sentry alert + 1h auto-revert?
2. **Recovery procedure pro nowak.gorak / goran.nowak** — confirm: oba dead. Vytvořit 4 nové schránky (různé osoby, různé email.cz aliases) hardened-from-day-0 přes AP1-AP6.
3. **AP4 false positive rate** — multi-country alarm na první send/probe (legitimate first egress) by triggered. Need warmup days exemption: alarm only kicks in after lifecycle_phase != warmup_d0.
4. **Test mailbox creation flow** — operator creates test mailboxes how? Migration seed? Manual UI flow? Memory `feedback_no_fabricated_test_data` complicates.

## Co tato iniciativa NEDĚLÁ

- IP rotation for sending (memory `project_egress_canonical` — Mullvad-only)
- Captcha / 2FA for operator UI (out of scope)
- Cross-account suspension propagation (only per-mailbox)
- Auto-recovery from Seznam (none possible — manual support contact only)

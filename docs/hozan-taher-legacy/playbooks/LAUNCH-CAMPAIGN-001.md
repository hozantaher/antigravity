# Launch Playbook — Soft Launch 001 (machinery, 20 kontaktů)

> **Status**: připraveno k execution. Čeká na operátora — viz blockery níže.
> **Datum příprava**: 2026-04-25
> **Scope**: první ostrá B2B kampaň, 20 kontaktů, machinery-relevant tagy, single-step (initial.tmpl bez follow-upu).
> **Sender**: 2× Seznam mailbox (mb=631, mb=632) přes anti-trace-relay + SOCKS5.

Tento playbook spouští `scripts/campaigns/launch-001-machinery-soft-20.sql` end-to-end.
Má dvě fáze — **prep** (operátor odblokuje) a **launch** (operátor spustí jednotlivé kroky postupně).

---

## 0. Hard prerequisites (blockery)

Bez splnění VŠECH tří se launch nesmí pustit.

### 0.1 Mailbox passwords v DB (SEND-S1, task #19)

Seznam app passwords pro `mb=631` a `mb=632` musí být v `outreach_mailboxes.password`.
Per memory `feedback_mailbox_passwords_via_db.md` — **výhradně DB**, ne env vars.

Operator-only krok (já tě sem nedostanu — destruktivní op s creds):
```sql
-- Railway psql, aktualizuj přes pgAdmin / dashboard / psql přímo:
UPDATE outreach_mailboxes SET password = '<seznam_app_password_631>' WHERE id = 631;
UPDATE outreach_mailboxes SET password = '<seznam_app_password_632>' WHERE id = 632;

-- Verify (NEVER print password v logu):
SELECT id, from_address, status, length(password) > 0 AS has_password FROM outreach_mailboxes WHERE id IN (631, 632);
```

Heslo nikdy nesmí jít do Slack / git / DM. Pokud se exfiltrovalo, rotovat ihned.

### 0.2 Anti-trace-relay běží

Runner v `features/inbound/orchestrator` panikuje na chybějící `AntiTraceClient` (sender.ErrAntiTraceRequired).
Verifikuj:
```bash
# Z lokálního shellu (přes Railway proxy nebo public URL relay):
curl -sf "${ANTI_TRACE_URL}/health" -H "Authorization: Bearer ${ANTI_TRACE_TOKEN}" | jq .
```
Očekávaný výstup: `{"status":"ok",...}`.

Pokud relay down, nesmí se spouštět nic. Sender je relay-only (SMTP-egress lockdown R4).

### 0.3 Suppression listy populated

Preflight gate v BFF (`features/platform/outreach-dashboard/campaignPreflight.js`) blokne unpause pokud
UNION obou tabulek je prázdný. Verifikace via preview script (sekce 3) níže.

---

## 1. Pre-flight (operator, ~5 min, bezpečné — read-only)

```bash
# Z lokálu, přes Railway proxy nebo přímo na production DB:
psql "${DATABASE_URL}" -f scripts/campaigns/preview-001-machinery-soft-20.sql
```

Co kontrolovat ve výstupu:

| Sekce | Co musí platit |
|---|---|
| 1. Eligible candidates | ≥ 20 v sumě napříč tagy. Pokud jeden tag dominuje (např. construction = 80%), přijatelné — script bere top-20 dle consent_score. |
| 2. Top-20 preview | Žádné role-based emaily (info@, kontakt@, podatelna@), žádné interní/test domény, žádné spam-trapy. Eyeball-check 20 řádků. |
| 3. Suppression health | Obě tabulky non-empty. Pokud `outreach_suppressions = 0` AND `suppression_list = 0`, ZASTAV — preflight gate stejně blokne. |
| 4. Mailbox readiness | mb=631 i mb=632 jsou status='active', password_set=true, has_proxy=true, last_check_ok=true, check_age_minutes < 360 (6h). |
| 5. Relay config | anti_trace_url has '✓ set'. Pokud '✗ EMPTY', viz blocker 0.2. |
| 6. Existing campaigns | Žádná running/active kampaň se stejnými kontakty (jinak naše top-20 bude prázdné — script má NOT EXISTS guard, ale preview to prozradí dřív). |

Pokud cokoli selže, fix-and-rerun preview. Nikdy neskákat na launch s tichým signálem.

---

## 2. Launch (operator, ~2 min, IDEMPOTENTNÍ)

```bash
psql "${DATABASE_URL}" -f scripts/campaigns/launch-001-machinery-soft-20.sql
```

Skript:
1. Pre-flight assert (≥20 kandidátů, jinak EXCEPTION)
2. INSERT kampaně (idempotent — re-run nepřepíše)
3. Resolve campaign_id
4. INSERT 20 řádků do `campaign_contacts` (ON CONFLICT DO NOTHING)
5. Print summary: campaign_id, enrolled_count

**Očekávaný výstup**:
```
NOTICE:  pre-flight OK: 1247 candidates eligible
NOTICE:  campaign resolved: id=42, status=draft
 campaign_id |     campaign_name      | campaign_status | enrolled_count
-------------+------------------------+-----------------+----------------
          42 | Soft launch 001 — ...  | draft           |             20
```

Pokud `enrolled_count < 20`, zastav a investigate. Pokud `status != 'draft'`, někdo už kampaň aktivoval — ZASTAV.

---

## 3. Dry-run smoke test (operator, ~10 min, povinné před send)

### 3.1 UI smoke

1. Otevři dashboard → **Campaigns** → najdi `Soft launch 001`
2. Klikni na detail. Zkontroluj:
   - **Enrolled** = 20
   - **Status** = draft
   - **Preflight gate**: všech 5 checků GREEN (proxy_assignments, full_check_fresh, suppression_populated, daily_capacity, templates_valid)

### 3.2 Send-test na vlastní adresu

Z UI nebo via API:

```bash
# Posli z mb=631 na svou vlastní adresu (NE z poolu kontaktů)
curl -X POST "${BFF_URL}/api/mailboxes/631/send-test?force=1" \
  -H "x-api-key: ${OUTREACH_API_KEY}" \
  -H "content-type: application/json" \
  -d '{"to":"<tva_osobni@adresa.cz>","subject":"smoke test","text":"smoke"}'

# To samé pro mb=632:
curl -X POST "${BFF_URL}/api/mailboxes/632/send-test?force=1" \
  -H "x-api-key: ${OUTREACH_API_KEY}" \
  -H "content-type: application/json" \
  -d '{"to":"<tva_osobni@adresa.cz>","subject":"smoke test","text":"smoke"}'
```

Očekávané: `{"ok":true,"send_event_id":...}`. Email dorazí do inboxu během minuty.

Pokud selže:
- 400 `je na suppression listu` → dobré, BFF gate funguje (ale tvůj test email neni v suppression — investigate)
- 500 `auth failed` → password v DB je špatné, fix v 0.1
- 500 `dial tcp timeout` → relay down, fix v 0.2
- Email nedorazí → SOCKS proxy nefunguje nebo Seznam soft-blokl. Zkontroluj `mailbox_alerts` table.

---

## 4. Activate (operator, ~10s)

Pouze pokud sekce 3 dopadla úspěšně:

```bash
# Via UI: klik "Run" / "Aktivovat" na detailu kampaně
# nebo via API:
curl -X POST "${BFF_URL}/api/campaigns/42/run" \
  -H "x-api-key: ${OUTREACH_API_KEY}"
```

Status flipne na `running`. Scheduler (běží každých 60s v orchestratoru) ji pickne v dalším ticku
a začne enqueueovat kontakty do sender engine.

---

## 5. Monitoring (operator, prvních 24h)

Sledovat:

| Co | Kde | Práh alertu |
|---|---|---|
| `send_events.status` distribuce | dashboard Campaigns/42 stats | bounced/sent > 5% → PAUSE |
| `mailbox_alerts.severity='critical'` | dashboard Mailboxes nebo `SELECT * FROM mailbox_alerts WHERE created_at > now() - interval '24h' ORDER BY created_at DESC` | jakýkoli critical → investigate |
| `reply_inbox` rows | dashboard Replies / Leads | normální, ne alert — toto je signál co cílíme |
| Per-domain bounce rate | `domain_bounces` map (in-memory engine state) | implicitní — circuit breaker řeší automaticky |
| `healing_log` | `SELECT * FROM healing_log WHERE created_at > now() - interval '24h'` | auto-pause hits → zkontroluj reason |

### 5.1 Reply classification

Po prvním replyu (typically 4-48h):

```sql
-- Co dorazilo:
SELECT id, contact_id, classification, from_email, subject, created_at
FROM reply_inbox
WHERE campaign_id = 42
ORDER BY created_at DESC;
```

Klasifikace `negative` → kontakt automaticky do `suppression_list` (per code).
Klasifikace `positive`/`interested` → manual review v UI Leads.

### 5.2 Sledování reputace

Pokud po 6h:
- `bounce_rate > 5%` → pause + investigate template/list
- `reply_rate > 10%` → výborně, eskaluj na 50 v dalším sprintu (po warmup gate)
- `reply_rate < 0.5%` after 50+ sends → revize template, ne segment

---

## 6. Pause / rollback (operator, kdykoli)

```bash
curl -X POST "${BFF_URL}/api/campaigns/42/pause" -H "x-api-key: ${OUTREACH_API_KEY}"
```

Mid-tick pause check (commit `052b636`) zastaví další enqueue do 10 kontaktů.
Už odeslané emaily nelze stáhnout — zvaž suppression bulk-add pokud je problém.

```sql
-- Plně rollback (jen pokud kampaň ještě nikam neposlala):
DELETE FROM campaign_contacts WHERE campaign_id = 42;
UPDATE campaigns SET status = 'archived' WHERE id = 42;
```

---

## 7. Po dokončení batch (24-48h)

1. Final stats z UI nebo:
```sql
SELECT status, COUNT(*)
FROM send_events WHERE campaign_id = 42
GROUP BY status;

SELECT classification, COUNT(*)
FROM reply_inbox WHERE campaign_id = 42
GROUP BY classification;
```

2. Decision:
   - reply_rate ≥ 5% + bounce_rate ≤ 3% → second batch (50 kontaktů, stejná logika, edit `BATCH_LIMIT` v launch script)
   - reply_rate < 1% → revize template (ne segmentu — segment je pravděpodobně OK podle template-fit analýzy v audit fázi)
   - bounce_rate > 5% → revize email validation gate (verifier není dost přísný); pause warmup, fix, znovu

3. Save výsledky do `docs/playbooks/launch-001-results.md` (operátor, manuálně).

---

## 8. Známé limity tohoto launchu

| Limit | Důvod | Fix kdy |
|---|---|---|
| Single-step (žádný follow-up) | Při 20 kontaktech to nedává smysl, odolnost soft-launchu | Přidat followup1.tmpl do sequence_config v dalším batchi (50+) |
| Industry_tags filter, ne category_path | Go runner.enrollContacts používá category_path; tento script jde mimo runner | Cesta B (BFF bridge) — task #31 follow-up |
| BFF /api/campaigns POST nedělá enrollment | Architektonický dluh | Cesta B (BFF bridge) — task #31 follow-up |
| GH billing blokuje CI na PR #25 | Task #28 — operator fix | Před merge |

---

## Reference

- SQL launch: `scripts/campaigns/launch-001-machinery-soft-20.sql`
- SQL preview: `scripts/campaigns/preview-001-machinery-soft-20.sql`
- Initial template: `features/outreach/campaigns/configs/templates/initial.tmpl` (odkup použitých strojů)
- Memory: `feedback_campaign_send.md` (HARD RULE: nikdy nespouštět bez explicitního souhlasu)
- Memory: `feedback_mailbox_passwords_via_db.md` (HARD RULE: passwords pouze v DB)
- Memory: `project_two_suppression_tables.md` (UNION at every read)
- Existing plan: `docs/playbooks/FIRST-CAMPAIGN-PLAN.md` (širší rámec)

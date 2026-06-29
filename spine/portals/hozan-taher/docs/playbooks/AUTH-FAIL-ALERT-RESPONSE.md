# AUTH-FAIL-ALERT — operator response runbook

**Kdy:** watchdog poslal alert `mailbox_auth_fail_alert` (log / Slack webhook / watchdog_events).
**Pre-read:** [SEND-S6.3 implementation](../../modules/outreach/internal/watchdog/auth_fail_alert.go), [MAILBOX-PASSWORD-UPDATE.md](./MAILBOX-PASSWORD-UPDATE.md).

## Co alert znamená

Mailbox nashromáždil ≥ **3 SMTP AUTH failures během posledních 15 minut**. Circuit breaker ještě **není** otevřený (trigger při 5/15min) — alert slouží jako předčasné varování **předtím**, než se schránka auto-paused a přijde o capacity.

Typické root-causes (historicky, od 2026-04):

| Symptom | Root cause | Fix |
|---|---|---|
| Heslo v DB je placeholder / prázdné | nebyl proveden initial setup | [MAILBOX-PASSWORD-UPDATE.md](./MAILBOX-PASSWORD-UPDATE.md) |
| Heslo v DB bylo nedávno změněno + AUTH fail | špatný app-password (Seznam 2FA) | regenerovat app-password, zapsat přes dashboard UI |
| Všechny mailboxy fail současně | proxy pool degradace | check `/v1/proxy-pool` na relay |
| Jedna schránka fail, ostatní OK | Seznam rate limit / account block | login do webmailu ověřit, kontaktovat Seznam support |
| 535 5.7.8 konkrétně | credentials invalid | DB mismatch — read `outreach_mailboxes.password` vs what you think you set |

## Kroky (≤ 5 minut)

### 1. Identifikuj mailbox

Alert payload obsahuje `mailbox_id` + `from_address` + `fail_count`. Z logu nebo Slack webhook:
```json
{"event": "mailbox_auth_fail_alert", "mailbox_id": 3, "from_address": "a.mazher@email.cz", "fail_count": 4}
```

### 2. Ověř DB stav

```bash
cd features/platform/outreach-dashboard
node --env-file=.env -e "
const pg = await import('pg');
const p = new pg.default.Pool({connectionString: process.env.DATABASE_URL});
const r = await p.query(\`SELECT id, from_address, status, status_reason,
  length(password) AS pwd_len, consecutive_bounces, auth_fail_count,
  to_char(auth_fail_at, 'YYYY-MM-DD HH24:MI') AS last_fail
  FROM outreach_mailboxes WHERE id = \$1\`, [MAILBOX_ID]);
console.log(r.rows); await p.end();
"
```

Očekávané signály:
- `pwd_len < 10` nebo password LIKE `123p%` → **placeholder**, jdi na krok 4
- `status = 'paused'` → circuit breaker už trippl, řešit podle rozhodnutí v kroku 4
- `auth_fail_count > 3` → systém už viděl opakované fail

### 3. Probe AUTH přes relay (read-only ověření)

```bash
PASSWORD="<aktuální heslo z DB — ne paste do chatu>"
curl -sS -H "Authorization: Bearer $ANTI_TRACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"smtp_host\":\"smtp.seznam.cz\",\"smtp_port\":465,\
\"smtp_username\":\"<from_address>\",\"password\":\"$PASSWORD\"}" \
  https://anti-trace-relay-production-a706.up.railway.app/v1/auth-check
```

- `ok: true` → false alarm? (unlikely — alert by nefiril); možná transient, pokračovat v kroku 5.
- `ok: false, error: "535 5.7.8"` → **credentials invalid**, jdi na krok 4.
- Jiný error (TLS, timeout, connection refused) → problém v transport, ne v AUTH. Check relay healthz.

### 4. Fix credentials

Postupuj dle [MAILBOX-PASSWORD-UPDATE.md](./MAILBOX-PASSWORD-UPDATE.md):

1. Loginni do webmailu pro danou schránku (https://email.seznam.cz)
2. Zjisti 2FA stav (Účet → Zabezpečení)
3. 2FA ON → vygeneruj nové "heslo pro aplikace"; 2FA OFF → resetuj login password
4. Zapiš přes dashboard UI `http://localhost:18175/mailboxes` → [schránka] → heslo → save
5. Re-probe přes relay `/v1/auth-check` → musí `ok: true`

### 5. Reset circuit + status

**Preferovaně přes UI** (SEND-S2, od 2026-04-22):

- Dashboard → `/mailboxes` → klik na řádek → drawer **Overview** → tlačítko **"Reset AUTH"**
- Viditelné pouze když `auth_fail_count > 0` OR `circuit_opened_at != NULL`
- Dělá atomicky: vynulování counter, uzavření circuit, označení otevřených `auth_fail_alert` watchdog_events jako `auto_healed=true` → banner na všech stránkách okamžitě zmizí
- Audit row `auth_reset` v `watchdog_events` pro timeline

Pod kapotou volá `POST /api/mailboxes/:id/auth-reset` — stejný endpoint lze volat přímo:

```bash
curl -sS -X POST http://localhost:18001/api/mailboxes/<ID>/auth-reset \
  -H 'content-type: application/json' \
  -d '{"reason":"runbook-step-5"}'
```

**Fallback přes SQL** (pokud BFF down):

```sql
UPDATE outreach_mailboxes
  SET status = 'active',
      status_reason = NULL,
      circuit_opened_at = NULL,
      auth_fail_count = 0,
      auth_fail_at = NULL
  WHERE id = <MAILBOX_ID>;

UPDATE watchdog_events
  SET auto_healed = true, healed_at = now()
  WHERE mailbox_id = <MAILBOX_ID>
    AND event_type = 'auth_fail_alert'
    AND auto_healed = false;
```

Watchdog registry cache se refreshuje max po 30s (viz [SERVICES.md](./SERVICES.md)).

### 6. Self-send smoke test

```bash
# Přes prod relay /submit endpoint
curl -sS -H "Authorization: Bearer $ANTI_TRACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"<from_address>","to":"<same from_address>","subject":"SEND-S6.3 self-test","body":"ok"}' \
  https://anti-trace-relay-production-a706.up.railway.app/submit
```

Ověř v Seznam webmail Inbox že přišlo.

### 7. Zapiš do rotation logu

Updatuj `docs/playbooks/SECRET-ROTATION-LOG.md` s:
- Datum + čas
- Mailbox ID + from_address
- Důvod (alert triggered)
- Outcome (resolved / escalated)

## Cooldown

Alert primitive má **1h cooldown per mailbox** — pokud fixuješ a re-alert přijde během hodiny, **fix neuspěl**. Zkontroluj znovu step 2-5.

## Když nic nepomáhá

1. Logs na relay: `railway logs --service anti-trace-relay --lines 200 | grep -i auth`
2. Logs na machinery-outreach: `railway logs --service machinery-outreach --lines 200 | grep -i mailbox`
3. Check pool health `/v1/proxy-pool` — pokud <5 working proxies, problém je v egress, ne AUTH
4. Kontaktovat Seznam support pokud account-level block (stalo se 0× za celou historii, ale není vyloučeno)

## Related

- [SEND initiative](../initiatives/2026-04-22-send-pipeline-unblock.md)
- [MAILBOX-PASSWORD-UPDATE](./MAILBOX-PASSWORD-UPDATE.md)
- [SEND-OPERATIONS](./SEND-OPERATIONS.md) — další bottlenecky (circuit, warmup, window)
- [DISCIPLINE](./DISCIPLINE.md) — secret rotation policy
- memory: `feedback_mailbox_passwords_via_db.md`, `feedback_no_direct_smtp.md`

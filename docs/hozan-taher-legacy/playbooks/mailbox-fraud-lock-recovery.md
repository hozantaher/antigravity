# Mailbox Fraud-Lock Recovery (Seznam)

**Status:** Active  
**Sprint:** AO6 — 2026-05-08  
**Trigger:** goran.nowak (id=12834) locked by Seznam after multi-country egress detection

---

## Kdy se spustí tento postup

Schránka je ve fraud-lock pokud nastane alespoň jeden z těchto signálů:

- `status = 'auth_locked'` v `outreach_mailboxes` (AP6 — 3 auth-fails za hodinu)
- `status = 'egress_chaos_detected'` (AP4 — 2+ countries za 60 minut)
- Seznam vrací SMTP 535 na více operacích najednou
- `mailbox_egress_observation` ukazuje záznamy z různých zemí ve stejné hodině

Zkontroluj v DB:

```sql
SELECT id, from_address, status, status_reason, auth_locked_at,
       auth_locked_reason, updated_at
FROM outreach_mailboxes
WHERE status IN ('auth_locked', 'egress_chaos_detected')
ORDER BY updated_at DESC;
```

---

## Fáze 1 — Zastavení škod (0–15 minut)

**Cíl:** přestat dál generovat podezřelou aktivitu ze schránky.

1. Zkontroluj stav schránky v dashboardu (sekce Schránky) nebo v DB (dotaz výše).
2. Pokud je status `auth_locked` nebo `egress_chaos_detected`, schránka je již automaticky vyřazena z odesílání a IMAP pollingem. Žádný manuální zásah k zastavení odesílání není nutný.
3. Ověř, že žádná kampaň tuto schránku nepoužívá:

```sql
SELECT c.id, c.name, c.status
FROM campaigns c
JOIN send_events se ON se.campaign_id = c.id
JOIN outreach_mailboxes m ON m.from_address = se.mailbox_used
WHERE m.id = <mailbox_id>
  AND c.status = 'running';
```

Pokud existuje běžící kampaň → pauznout ji přes dashboard nebo SQL:

```sql
UPDATE campaigns SET status = 'paused' WHERE id = <campaign_id>;
```

4. Zkontroluj Sentry — v projektu `outreach-dashboard` hledej event s tagem `mailbox_id=<id>` a komponentou `egress_chaos_detection` nebo `auth_quarantine`. To dá přesný čas incidentu a seznam zemí.

---

## Fáze 2 — Cooldown (15 minut – 2 hodiny)

**Cíl:** nechat Seznam "zapomenout" na podezřelou aktivitu, zjistit příčinu.

### Zjisti příčinu multi-country problému

Podívej se na egress historii schránky:

```sql
SELECT egress_country, egress_endpoint_label, op_type, observed_at
FROM mailbox_egress_observation
WHERE mailbox_id = <mailbox_id>
  AND observed_at > NOW() - INTERVAL '2 hours'
ORDER BY observed_at DESC;
```

Typické scénáře:
- **SMTP z CZ, IMAP z jiné země** → IMAP polling nešel přes SOCKS5 (viz AO1). Zkontroluj logy `[imapPoll]` v Railway na chybu `imap_socks_unavailable`.
- **Více Mullvad endpointů** → schránka neměla pin na jeden endpoint. Použij repin (Fáze 3).
- **Warmup race condition** → schránka v `warmup_d0` první 24 hodin; po uplynutí se to samo vyřeší.

### Izolace vadného Mullvad endpointu

Pokud egress log ukazuje konkrétní `egress_endpoint_label` s nestabilním chováním:

```sql
-- Podívej se na ostatní schránky na stejném endpointu
SELECT id, from_address, status, pinned_endpoint_label
FROM outreach_mailboxes
WHERE pinned_endpoint_label = '<problematic_endpoint>'
  AND status NOT IN ('retired', 'paused');
```

Pokud je endpoint problematický pro více schránek → kontaktuj Mullvad support nebo přepin všechny schránky na jiný endpoint přes `/api/mailboxes/:id/repin`.

### Ověř dostupnost relay SOCKS5

```bash
# Zkontroluj relay health
curl $ANTI_TRACE_RELAY_URL/v1/health
curl $ANTI_TRACE_RELAY_URL/v1/pool-status
```

Pokud relay vrací 502 nebo "no endpoints" pro CZ → toto je architektonická ceiling (CZ free SOCKS5 supply je omezená, viz memory `seznam_proxy_geo_mismatch`). V takovém případě je třeba buď koupit Mullvad dedicated CZ server nebo počkat na obnovení poolu.

---

## Fáze 3 — Pokus o obnovení (2–24 hodin)

**Cíl:** vrátit schránku do provozuschopného stavu.

### Pokud je status `auth_locked`

Obnovení je možné nejdříve 24 hodin po zamknutí (AP6 cooldown).

1. Ověř, že 24 hodin uplynulo:

```sql
SELECT id, from_address, auth_locked_at,
       EXTRACT(EPOCH FROM (NOW() - auth_locked_at))/3600 AS hours_since_lock
FROM outreach_mailboxes
WHERE id = <mailbox_id>;
```

2. Zkontroluj a resetuj heslo schránky přes dashboard UI (sekce Schránky → PATCH heslo). Nikdy přes env vars.

3. Odemkni schránku:

```bash
curl -X POST http://localhost:18001/api/mailboxes/<id>/clear-auth-lock \
  -H "X-Confirm-Send: yes" \
  -H "Content-Type: application/json" \
  -d '{"reason": "credentials verified after fraud lock"}'
```

Vrátí `status = 'paused'` — schránka je úmyslně pauznutá, ne aktivní. Operátor musí explicitně aktivovat.

4. Ověř přihlašovací údaje ručně (web login přes Seznam webmail). Pokud přihlášení selže → heslo bylo zneplatněno Seznamem → nutná Fáze 4.

5. Pokud přihlášení funguje → aktivuj schránku:

```bash
curl -X PATCH http://localhost:18001/api/mailboxes/<id> \
  -H "Content-Type: application/json" \
  -d '{"status": "active"}'
```

### Pokud je status `egress_chaos_detected`

1. Repin schránku na stabilní CZ Mullvad endpoint:

```bash
curl -X POST http://localhost:18001/api/mailboxes/<id>/repin \
  -H "Content-Type: application/json" \
  -d '{"new_endpoint_label": "cz-prg-1", "reason": "fraud lock recovery - repin to CZ"}'
```

2. Aktivuj schránku:

```sql
UPDATE outreach_mailboxes
SET status = 'active',
    status_reason = 'manual_recovery_after_egress_chaos'
WHERE id = <mailbox_id>
  AND status = 'egress_chaos_detected';
```

3. Spusť kontrolní sondu přes dashboard (Full Check) a ověř, že SMTP i IMAP projdou.

4. Sleduj egress audit panel (nový, Sprint AO6) — měl by ukazovat pouze jednu zemi v dalších 30 minutách.

---

## Fáze 4 — Manuální podpora (>24 hodin)

**Cíl:** eskalace na Seznam, pokud vlastní recovery selže.

### Podmínky pro eskalaci

- Heslo nefunguje ani po resetu přes seznam.cz webmail
- Schránka vrací 535 i po úspěšném webmail loginu
- Problém přetrvává >24 hodin od incidentu

### Postup

1. Přihlas se do seznam.cz webmailu schránky (přes Tor nebo čistý CZ IP, ne přes Mullvad).
2. Pokud vidíš bezpečnostní upozornění nebo CAPTCHA → proveď ověření identity.
3. Pokud je schránka blokovaná i po ověření → kontaktuj pomoc@seznam.cz s popisem situace (B2B odesílání z oprávněné kampaně, omylem spuštěna bezpečnostní pojistka).
4. Typická MTTR se Seznamem: 24–48 hodin v pracovní dny.

### Zatímco čekáš na unblock

- Přesměruj kampaně na jiné aktivní schránky (PATCH `mailbox_used` není možný — přiřazení schránek je per-kampaň v konfiguraci).
- Zkontroluj, zda máš dostatečnou kapacitu zbývajících schránek pro aktuální denní objem.
- Zdokumentuj incident do `operator_audit_log`:

```sql
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES ('fraud_lock_escalated', 'operator', 'mailbox', '<id>',
        '{"reason": "seznam_support_contact", "contacted_at": "2026-05-08T14:00:00Z"}'::jsonb);
```

---

---

## Drill — ověření playbooku

Tento playbook musí být ověřen simulací před každým produkčním incidentem.

**Spuštění drill skriptu:**
```bash
DATABASE_URL="$DATABASE_URL" \
BFF_BASE_URL="http://localhost:18001" \
bash scripts/drills/mailbox-fraud-lock-drill.sh
```

Drill simuluje celý průběh fraud-lock recovery na testovací schránce id=11583:
- Fáze 1: Nastavení `status='auth_locked'`
- Fáze 2: Ověření cooldown výpočtu (24h)
- Fáze 3: Předčasný pokus o odemknutí → HTTP 425
- Fáze 4: Backdatování o 25h + retry clear-auth-lock → HTTP 200
- Fáze 5: Ověření `status='paused'` (ne `'active'`)

CI workflow (manuální): `.github/workflows/playbook-drill.yml`

**Historie testů:**
<!-- Po každém úspěšném drill spuštění přidej řádek: -->
<!-- Tested: YYYY-MM-DD OK (viz GitHub Actions run #<run_id>) -->

---

## Prevence opakování

1. **Egress Audit panel** (AO6) sleduje historii zemí per schránce. Otevři ho pravidelně nebo nastav alert přes Watchdog.
2. **Repin po každém incidentu** — jakmile je schránka obnovena, vždy repin na konkrétní CZ endpoint (ne auto-select).
3. **IMAP přes SOCKS5 vždy** — audit ratchet `no_raw_imap_socket.test.js` hlídá, že se nezavede přímé IMAP spojení.
4. **Warmup d0 exemption** — první 24 hodin se egress chaos ignoruje. Nová schránka může mít první SMTP z jiné země. AP4 to ošetřuje automaticky.

---

## Rychlá reference — DB dotazy

```sql
-- Aktuální stav schránek s problémem
SELECT id, from_address, status, status_reason, auth_locked_at, updated_at
FROM outreach_mailboxes
WHERE status IN ('auth_locked', 'egress_chaos_detected')
ORDER BY updated_at DESC;

-- Egress historie za posledních 24 hodin
SELECT mailbox_id, egress_country, egress_endpoint_label, op_type,
       COUNT(*) as cnt, MIN(observed_at) as first, MAX(observed_at) as last
FROM mailbox_egress_observation
WHERE mailbox_id = <id>
  AND observed_at > NOW() - INTERVAL '24 hours'
GROUP BY mailbox_id, egress_country, egress_endpoint_label, op_type
ORDER BY last DESC;

-- Chaos detekce za poslední hodinu (stejná funkce co AP4 cron)
SELECT * FROM detect_mailbox_egress_chaos(60);

-- Nouzový SQL unlock (pouze po 24h a po ověření hesla)
UPDATE outreach_mailboxes
SET status = 'paused',
    auth_locked_at = NULL,
    auth_locked_reason = NULL,
    auth_locked_by_observer = NULL
WHERE id = <id>
  AND status = 'auth_locked';
```

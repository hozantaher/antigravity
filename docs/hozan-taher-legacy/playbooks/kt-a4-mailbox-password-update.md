# KT-A4 — Vyplnění hesel pro 24-mailbox Seznam fleet

> **Sprint:** KT-A4 (GH issue #298)
> **Status:** připraveno k execution. **Operator-only krok** — Chat A/B nesmí na hesla sahat.
> **Doba:** 30–45 min (po vygenerování app passwords v Seznam UI pro všech 24 schránek)
> **Předpoklad:** přístup do Seznam webmailu pro všech 24 schránek, přístup k Railway Postgres (psql / pgAdmin / dashboard UI).

Tento playbook nastavuje produkční Seznam SMTP/IMAP credentials pro **všech 24 mailboxů** Seznam fleet, které pošlou kampaň výkupu (KT-A5). Hesla **musí být v DB**, nikdy v env vars (HARD RULE — viz memory `feedback_mailbox_passwords_via_db.md`).

> **Scope rozšíření 2026-04-30:** Původní playbook pokrýval jen 2 schránky (mb=631, mb=632). Strategická decize 2026-04-30 zvedla scope na 24 mailboxů: 24 × 20/den plateau = **480 mailů/den** fleet capacity. First-day batch při warmup day 1 = 24 × 2 = **48 mailů**. Per-mailbox warmup curve viz `features/outreach/campaigns/configs/warmup.yaml` plán `vykup_24mb`.

---

## 1. Schema reality check

Kanonická schema podle `scripts/migrations/003_encrypt_mailbox_passwords.sql` + `004_populate_mailbox_password_encrypted.sql`:

```
outreach_mailboxes
  id                     INT PRIMARY KEY
  from_address           TEXT (např. 'b.maarek@email.cz')
  display_name           TEXT
  smtp_host              TEXT (např. 'smtp.seznam.cz')
  smtp_port              INT (465)
  smtp_username          TEXT (typicky = from_address)
  imap_host              TEXT
  imap_port              INT
  imap_username          TEXT
  password               TEXT (legacy plaintext — phase 1 deprecated)
  password_encrypted     BYTEA (pgp_sym_encrypt s MAILBOX_SECRET_KEY)
  status                 TEXT ('active' | 'paused')
  status_reason          TEXT
  daily_cap_override     INT
  warmup_plan            TEXT (např. 'vykup_24mb' pro 24-mailbox kampaň)
  warmup_day             INT (current ramp day, advances by daemon)
  ...
```

> **POZOR — odlišnost od původního skeletu v sprint zadání.** Zadání úkolu navrhovalo `crypt('...', gen_salt('bf'))` (bcrypt). Ale **bcrypt je hash function — nereversibilní**. SMTP klient potřebuje **plaintext heslo** k AUTH. Tato repo proto používá **symmetric encryption** (`pgcrypto.pgp_sym_encrypt`), ne bcrypt. Nepoužívej `crypt()/gen_salt('bf')` — sender by se neuměl autentizovat.

---

## 2. Pre-flight — současný stav 24 mailboxů

```sql
SELECT id,
       from_address,
       smtp_host,
       smtp_port,
       smtp_username,
       status,
       status_reason,
       warmup_plan,
       warmup_day,
       daily_cap_override,
       (password IS NOT NULL AND length(password) > 0) AS has_plaintext,
       (password_encrypted IS NOT NULL)                AS has_encrypted,
       length(password)            AS plaintext_len,
       length(password_encrypted)  AS encrypted_len
FROM outreach_mailboxes
WHERE smtp_host = 'smtp.seznam.cz'
ORDER BY id;
```

Očekávaný stav PŘED tímto playbookem (per `docs/handoff/BOARD.md` blocked sekce):
- 24 řádků v table (operator založil INSERT před spuštěním playbooku)
- `has_plaintext = false` u nově založených, NEBO `plaintext_len ≈ 15` s placeholder `123p123p123p123` u dříve testovaných
- `status = 'paused'` u nově založených, NEBO `'active'` se selháváním AUTH
- `status_reason ~ '535 5.7.8 incorrect credentials'` u testovaných
- `warmup_plan = 'vykup_24mb'` (operator nastaví per INSERT)
- `warmup_day = 1` (default)

Pokud řádků < 24 → operator musí dokončit INSERT batch před tímto playbookem.

---

## 3. Kde získat reálná Seznam app passwords

Tomáš je generuje a uchovává lokálně (per memory: hesla nikdy nejsou v repu, .env nebo logs). Pro 24-mailbox batch doporučení: 1Password / Bitwarden vault s 24 entries `mailbox-{id}-{from_address}`.

Per-mailbox postup (opakuj 24×):

1. Přihlas se do `https://email.seznam.cz/` jako konkrétní `<from_address>`
2. **Pro vývojáře → Hesla pro aplikace** (vyžaduje 2FA — pokud není ZAPNUTO, zapni; SMTP nedrží interactive 2FA)
3. Vygeneruj nové **heslo pro aplikace** (16 znaků, bez mezer)
4. Zkopíruj hodnotu **HNED** do password manageru — Seznam ji už nezobrazí (jen prefix v seznamu)
5. Pokračuj na další mailbox

Heslo nikdy:
- nepaste do chatu / IDE / Slack / `.env`
- nepřepisuj do commit messages
- neprohýbej Railway env vars (`HARD RULE`)

Detail: [`docs/playbooks/MAILBOX-PASSWORD-UPDATE.md`](./MAILBOX-PASSWORD-UPDATE.md) §3.

---

## 4. Update — varianty

### 4.A (DOPORUČENO) — přes dashboard UI batch

Pokud BFF už běží produkčně (KT-A3 done):

1. Otevři `${BFF_URL}/mailboxes`
2. Filter `provider=seznam` → měl bys vidět všech 24
3. Pro každý řádek (postupně, 24×):
   - **Edit** → paste 16znakové app password z password manageru → **Save**
   - Verify status flipne na `active`, status_reason vyčistí
4. Po dokončení: ověř, že **24 řádků má `has_password=true`** (viz §5.1 verify SQL)

BFF endpoint:
- ukládá heslo přes Go orchestrator (X-API-Key gated)
- Go zapíše do `outreach_mailboxes.password` (případně `password_encrypted` pokud `MAILBOX_SECRET_KEY` env je set + S5 phase 3 deploy)
- audit log entry vytvořen automaticky pro každý update

**Plus:** žádný direct SQL, encryption-aware code path, audit-logged, paste-only (heslo nejde do shell history), per-mailbox audit row.
**Minus:** vyžaduje BFF deployed (KT-A3 done) + 24× klik (cca 10–15 min).

### 4.B — direct SQL přes psql batch loop (fallback pokud BFF down)

Předpoklad: máš `DATABASE_URL` (Railway Postgres connection string) + 24 hesel připravených v password manageru.

```bash
# Připoj se v INTERAKTIVNÍM módu — vyhneme se shell history:
psql "$DATABASE_URL"
```

V interaktivním psql shellu (heslo se nikdy neobjeví v `.psql_history` pokud začínáš příkaz mezerou):

```sql
\set quiet on

-- Per-mailbox blok — opakuj pro každý ze 24 mailboxů.
-- ID každého mailboxu znáš z pre-flight SELECT v §2.

\prompt 'Heslo pro mailbox <id>: ' pwd

UPDATE outreach_mailboxes
SET password = :'pwd',
    status = 'active',
    status_reason = NULL
WHERE id = <id>;

INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
VALUES ('mailbox_password_set', 'operator', 'outreach_mailbox', '<id>',
        jsonb_build_object('source', 'kt-a4-direct-sql', 'reason', 'KT-A4 24-mailbox fleet launch'));

\unset pwd

-- Pokračuj dalším mailboxem...
```

> **NIKDY nepiš `UPDATE ... SET password = '<actual-16-chars>'` jako jeden řádek** — heslo by skončilo v `.psql_history`, terminal scrollback, případně Railway audit logu.

Pokud `MAILBOX_SECRET_KEY` env je set a chceš populate encrypted column zároveň (S5 phase 2 patern), pošli secret přes `-v`:

```bash
psql -v secret="$MAILBOX_SECRET_KEY" "$DATABASE_URL"
```

a v každém bloku navíc:

```sql
UPDATE outreach_mailboxes
SET password_encrypted = pgp_sym_encrypt(:'pwd', :'secret')
WHERE id = <id>;
```

### 4.C — pgAdmin / Railway Dashboard UI (pokud psql není po ruce)

Otevři Railway → service `Postgres` → Data → tabulka `outreach_mailboxes` → klik na řádek → edit cell `password` → paste → save. Per-mailbox 24× (15–20 min). Audit-log entries doplnit ručně (jeden batch INSERT po dokončení):

```sql
INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
SELECT 'mailbox_password_set', 'operator', 'outreach_mailbox', id::text,
       jsonb_build_object('source', 'railway-ui', 'reason', 'KT-A4 24-mailbox fleet launch')
FROM outreach_mailboxes
WHERE smtp_host = 'smtp.seznam.cz'
  AND length(password) >= 16
  AND status = 'active';
```

---

## 5. Verifikace (povinná)

### 5.1 Stav v DB

```sql
SELECT id,
       from_address,
       status,
       status_reason,
       warmup_plan,
       warmup_day,
       (password IS NOT NULL AND length(password) > 0) AS has_password,
       length(password) AS password_len,
       (password_encrypted IS NOT NULL) AS has_encrypted
FROM outreach_mailboxes
WHERE smtp_host = 'smtp.seznam.cz'
ORDER BY id;
```

Očekávané po updatu (24 řádků):
- Všech 24: `status = 'active'`, `status_reason = NULL`, `has_password = true`, `password_len = 16`
- Všech 24: `warmup_plan = 'vykup_24mb'`, `warmup_day = 1` (před první send)

Aggregate sanity check:

```sql
SELECT
  count(*) FILTER (WHERE status='active' AND length(password) >= 16) AS ready,
  count(*)                                                            AS total,
  min(length(password))                                              AS min_pwd_len,
  max(length(password))                                              AS max_pwd_len
FROM outreach_mailboxes
WHERE smtp_host = 'smtp.seznam.cz';
-- Očekávání: ready=24, total=24, min_pwd_len=16, max_pwd_len=16
```

### 5.2 AUTH probe přes anti-trace-relay (per-mailbox loop)

Pro každý ze 24 mailboxů:

```bash
# z lokálního shellu nebo z Railway shell:
curl -sS -X POST "${ANTI_TRACE_RELAY_URL}/v1/auth-check" \
  -H "Authorization: Bearer ${ANTI_TRACE_RELAY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"host":"smtp.seznam.cz","port":465,"username":"<from_address>","password":"<paste-16-chars>"}'
```

Očekávaný JSON: `{"ok": true, "auth_method": "AUTH PLAIN" }` (nebo `LOGIN`).

Pokud `{"ok": false, "error": "535 5.7.8 ..."}`:
- App password byl zkopírovaný se zalomením / mezerou → vygeneruj znovu v Seznamu
- Seznam zatím app password nepropagoval (občas trvá 1-2 min)
- Mailbox je rate-limited z předchozích neúspěšných pokusů — počkej 15 min

**Done gate:** 24/24 mailboxů vrací `{"ok": true}`.

### 5.3 Send-test do operátorské schránky (per-mailbox cross-check)

Pouze pokud relay AUTH probe prošla pro všech 24:

```bash
# Per-mailbox, 24× (lze skriptovat — bash for loop přes id seznam):
curl -X POST "${BFF_URL}/api/mailboxes/<id>/send-test?force=1" \
  -H "x-api-key: $OUTREACH_API_KEY" \
  -H "content-type: application/json" \
  -d '{"to":"<tva_osobni@adresa.cz>","subject":"KT-A4 smoke <id>","text":"smoke test mb=<id>"}'
```

Pro batch ověření recommended skript:

```bash
for ID in $(psql "$DATABASE_URL" -tAc "SELECT id FROM outreach_mailboxes WHERE smtp_host='smtp.seznam.cz' ORDER BY id"); do
  curl -sS -X POST "${BFF_URL}/api/mailboxes/${ID}/send-test?force=1" \
    -H "x-api-key: $OUTREACH_API_KEY" \
    -H "content-type: application/json" \
    -d "{\"to\":\"<tva_osobni@adresa.cz>\",\"subject\":\"KT-A4 smoke ${ID}\",\"text\":\"smoke test mb=${ID}\"}"
  echo
  sleep 2
done
```

V operátorské schránce by mělo dorazit 24 mailů během ~5 min. Verify per email:
- Headers: `Return-Path` a `From` shodné s `from_address` toho mailboxu
- DKIM `pass` (Seznam podpisuje automaticky)
- SPF `pass` (relay používá Seznam IP / domain alignment)
- Inbox (ne spam)

### 5.4 Audit log

```sql
SELECT created_at, action, actor, entity_id, details
FROM operator_audit_log
WHERE entity_type = 'outreach_mailbox'
  AND action = 'mailbox_password_set'
  AND created_at > now() - interval '1 day'
ORDER BY created_at DESC;
```

Měl by vrátit **24 entries** `mailbox_password_set` z dnešního dne.

---

## 6. Done gate (uzavři issue #298)

- [ ] Všech 24 Seznam mailboxů má v DB neprázdné heslo (`length(password) >= 16`)
- [ ] `status = 'active'`, `status_reason = NULL` u všech 24
- [ ] `warmup_plan = 'vykup_24mb'`, `warmup_day = 1` u všech 24
- [ ] AUTH probe přes relay → `{"ok": true}` pro všech 24
- [ ] Send-test dorazil do operátorské schránky pro všech 24
- [ ] Audit log obsahuje 24 `mailbox_password_set` entries z dnešního dne
- [ ] HISTORY check: `history | grep -i password | wc -l` v shellu = 0 (heslo se neuložilo do `~/.zsh_history` / `~/.psql_history`)
- [ ] Password manager (1Password / Bitwarden) má všech 24 credentials backed-up

```
gh issue close 298 --comment "Mailbox passwords set for 24-mailbox Seznam fleet (operator).
Všech 24 AUTH probe ok, send-test landed in operator inbox.
Warmup plán vykup_24mb, day=1, ready pro KT-A5 staircase.
Audit log: 24 mailbox_password_set entries."
```

---

## 7. Známé pasti

| Past | Symptom | Fix |
|---|---|---|
| 2FA u Seznam vypnuté na některém z 24 účtů | login password nefunguje s SMTP | zapni 2FA + vygeneruj app password (§3) |
| App password expirovalo (Seznam revoked) | AUTH 535 i s "správným" heslem | vygeneruj nové app password pro postižený mailbox |
| Plaintext + encrypted oba populated, ale různé hodnoty | sender vidí decrypt mismatch nebo fallback k plaintext | Phase 2 migration musí zachovat oba shodné |
| `MAILBOX_SECRET_KEY` env nemá Railway, ale code path očekává encrypted | sender použije fallback k plaintext (S5 phase 1 backward-compat) — funguje | OK pro phase 1; phase 3 deploy by se rozbil |
| Heslo má mezery / newline z paste | AUTH 535 | `length(password)` musí být přesně 16 znaků |
| Mailbox `status='paused'` po předchozím failure | Sender ho ignoruje i s novým heslem | UPDATE status='active', status_reason=NULL |
| Operator přeskočil pre-flight count → < 24 řádků | KT-A5 step 2 (24 × 1 cross-fleet) selže | INSERT chybějící mailbox rows + repeat playbook pro ně |
| Per-mailbox warmup_plan ≠ 'vykup_24mb' | warmup ramp jde na default 30d (10/den day 1) místo conservative 2/den | UPDATE warmup_plan='vykup_24mb' for all 24 |

---

## 8. Bezpečnostní HARD RULES (memory: `feedback_mailbox_passwords_via_db.md`)

1. Hesla **NIKDY** v env vars (Railway, .env, Docker secrets — ne)
2. Hesla **NIKDY** v repu (gitleaks hook tě zastaví, nepolez na to)
3. Hesla **NIKDY** v chatu / Slack / Sentry breadcrumb / log line
4. Při exposure (screen share, screenshot leak) → **okamžitá rotace**
5. Po rotaci: zapsat do [`docs/playbooks/SECRET-ROTATION-LOG.md`](./SECRET-ROTATION-LOG.md) datum + důvod (nikdy hodnotu)
6. **Batch operace 24×** zvyšuje riziko paste-mistake → vždy verify §5.1 (`length(password)=16`) a §5.2 (AUTH `ok=true`) **per mailbox** před přechodem na další

Pokud Chat A/B navrhne přidat heslo do .env / env var / commit / chat — **REFUSE** a odkaž tento dokument.

---

## 9. Reference

- [`docs/playbooks/MAILBOX-PASSWORD-UPDATE.md`](./MAILBOX-PASSWORD-UPDATE.md) — kanonický flow pro libovolnou Seznam schránku
- [`docs/playbooks/S5-mailbox-encryption.md`](./S5-mailbox-encryption.md) — encryption phase plan
- [`docs/playbooks/LAUNCH-CAMPAIGN-001.md`](./LAUNCH-CAMPAIGN-001.md) — launch playbook
- `features/outreach/campaigns/configs/warmup.yaml` — `vykup_24mb` warmup plán pro 24-mailbox fleet
- `scripts/migrations/003_encrypt_mailbox_passwords.sql` — encrypted column schema
- `scripts/migrations/004_populate_mailbox_password_encrypted.sql` — phase 2 populate
- Memory `feedback_mailbox_passwords_via_db.md` — HARD RULE
- GH issue #298 — sprint definition

# Nová schránka — provisioning postup

> Status: ACTIVE  
> Datum: 2026-05-13  
> Použij: vždy když operator chce přidat novou schránku do system

## TL;DR

Otevři `/mailboxes` → klikni **Přidat schránku** → vyplň modal → Uložit. Heslo a credentials zůstávají v DB, nikdy ne v env (HARD RULE).

## Co potřebuješ předem připravit

Než kliknes "Přidat schránku" musíš mít:

1. **Plnou e-mailovou adresu** (např. `nova.schranka@seznam.cz`)
2. **Heslo** (vytvoř v provider UI — seznam.cz / post.cz Nastavení → Hesla pro aplikace)
3. **SMTP credentials** — pro Seznam: `smtp.seznam.cz:465 SSL` nebo `:587 STARTTLS`; pro Post: `smtp.post.cz:465 SSL`
4. **IMAP credentials** — pro Seznam: `imap.seznam.cz:993 SSL`; pro Post: `imap.post.cz:993 SSL`
5. **Display name** (Co se zobrazí v "From" headeru — např. "Hozan Taher")
6. **Lifecycle phase**:
   - `warmup_d0` — úplně nová, prvních 0-2 dny (cap 5/den, okno 10-14h)
   - `warmup_d3` — 3-6 dní (cap 10/den, okno 9-17h)
   - `warmup_d7` — 7-13 dní (cap 25/den, okno 8-18h)
   - `warmup_d14` — 14-29 dní (cap 50/den, okno 8-19h)
   - `production` — 30+ dní (cap 100/den, okno 8-20h)

> ℹ️ Pro nové schránky vždy `warmup_d0`. Po 2 dnech cron `advance_lifecycle_phase()` posune automaticky.  
> Výjimka: pokud schránku přebíráš s historií (např. po Seznam migraci), můžeš nastavit přímo `production` — ale jen s evidencí předchozího sendu.

## Postup v UI

### Krok 1 — Otevři Mailboxes

`https://outreach-dashboard-production-e4ce.up.railway.app/mailboxes`

### Krok 2 — Klikni "Přidat schránku"

Modal "Přidat schránku" se otevře.

### Krok 3 — Vyplň pole

| Pole | Hodnota | Pozn. |
|---|---|---|
| `from_address` | `nova.schranka@seznam.cz` | Plná e-mailová adresa |
| `display_name` | `Hozan Taher` | Co uvidí příjemce |
| `smtp_host` | `smtp.seznam.cz` | Provider SMTP |
| `smtp_port` | `465` | SSL = 465, STARTTLS = 587 |
| `smtp_username` | `nova.schranka@seznam.cz` | = from_address obvykle |
| `imap_host` | `imap.seznam.cz` | Provider IMAP |
| `imap_port` | `993` | SSL = 993 |
| `imap_username` | `nova.schranka@seznam.cz` | = from_address obvykle |
| `password` | `<plaintext>` | Heslo aplikace, ne hlavní heslo účtu |
| `locale` | `cs` | Důležité — Go runner padá na NULL (po T3 fix funguje i tak, ale nech `cs`) |
| `tz` | `Europe/Prague` | Pro phase send window |
| `environment` | `production` | Ne `staging` |
| `lifecycle_phase` | `warmup_d0` | Pro novou; viz tabulka výše |
| `status` | `active` | Pause na "paused" jen pokud chceš dočasně vyřadit |

### Krok 4 — Uložit

Klikni "Přidat". Toast "Schránka přidána".

### Krok 5 — Verify

Vrať se na `/mailboxes`, najdi nový řádek. Klikni na něj → MailboxDrawer:
- ✅ IMAP host viditelný
- ✅ Status = active
- ✅ Lifecycle phase = warmup_d0 (nebo co jsi nastavil)

### Krok 6 — Smoke test

V MailboxDrawer klikni **Otestovat odesílání** (mb.from_address → tvůj e-mail) → ověř příchod do 30 s.

Pokud test fail → MailboxDrawer ukáže AUTH error. Klikni **Resetovat AUTH** → re-test.

## Co se stane v DB

```sql
INSERT INTO outreach_mailboxes
  (from_address, display_name, smtp_host, smtp_port, smtp_username,
   imap_host, imap_port, imap_username, password,
   locale, tz, environment, lifecycle_phase, status, daily_cap_override)
VALUES
  ('nova.schranka@seznam.cz', 'Hozan Taher',
   'smtp.seznam.cz', 465, 'nova.schranka@seznam.cz',
   'imap.seznam.cz', 993, 'nova.schranka@seznam.cz', '<plaintext>',
   'cs', 'Europe/Prague', 'production', 'warmup_d0', 'active', NULL);
```

Plus audit row v `operator_audit_log`.

## Sanity check po INSERT

```sql
SELECT id, from_address, status, lifecycle_phase, locale, tz,
       (password IS NOT NULL AND length(password) > 0) AS has_pw
FROM outreach_mailboxes WHERE from_address = 'nova.schranka@seznam.cz';
```

Pokud `has_pw = f` → MUSÍŠ heslo doplnit přes UI Edit modal, ne přes env.

## HARD RULES

- ❌ **Nikdy heslo do env** — feedback_mailbox_passwords_via_db (T0)
- ❌ **Nikdy heslo do commit / log / curl heredoc** — feedback_no_pii_in_commands (T0)
- ❌ **Nikdy přímý SMTP/IMAP** — všechno přes anti-trace-relay (feedback_no_direct_smtp T0); provisioning je pouze záznam v DB, samotný send dělá relay
- ✅ **Schema verify před INSERT** — `psql \d outreach_mailboxes` ověř column names a NOT NULL constraints (feedback_schema_verify_before_sql T0)

## Časté chyby

| Chyba | Příčina | Fix |
|---|---|---|
| "warmup_cap_exceeded" v send-batch | Schránka má `daily_cap_override > 0` nebo už dosáhla phase cap | NULL override, nebo počkat do druhého dne |
| AUTH fail při test send | Heslo app-specific neexistuje nebo bylo zneplatněno provider UI | Vytvořit nové heslo aplikace, Edit modal → Uložit |
| Schránka neaktivní v UI dropdown | status != active | UI Edit → status=active → Uložit |
| Send-batch vrátí mailbox locked | Předchozí cron drží advisory lock | `SELECT pg_try_advisory_lock_status FROM mailbox_locks`; pokud stale → manual release |

## Po přidání 5+ nových schránek

1. Otevři `/campaigns/457` → Sekvence — ověř, že segment_pool zahrnuje nové schránky (Round-robin distribuce).
2. Cron `advance_lifecycle_phase()` běží denně 03:00 Prague — schránky se postupně posunou na warmup_d3 → d7 → d14 → production.
3. Sleduj `/mailboxes/health` — bounce rate per mailbox; pokud > 2% → schránka půjde do `paused` automaticky.


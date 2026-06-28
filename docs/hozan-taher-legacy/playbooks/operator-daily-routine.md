---
Status: Active
Datum: 2026-05-28
Trigger: Story HANDOVER-5 — Operator onboarding + handover readiness
Revize: 1.0
---

# Denní rutina operátora — Outreach Dashboard

Dashboard běží **výhradně lokálně** na Tomášově Macu.
Spuštění: `cd features/platform/outreach-dashboard && pnpm dev` (Vite :18175) + `node server.js` (BFF :18001).
Po restartu Macu spustit obojí, než začneš pracovat.

---

## Ráno (06:30+)

### 1. Zkontroluj briefingový email (Story XXVI)

Cron se spouští každý den v **06:00 Prague**. Dorazí na operátorův email
s přehledem stavu kampaně za minulý den (počet odeslaných, bounce %, reply queue,
streak dní).

Pokud email nedorazil → BFF nebyl spuštěn před 06:00. Spusť `node server.js` —
příště pošle. Formát e-mailu: `operator_settings.morning_briefing_format`
(`soused` = default, přirozené věty).

### 2. Home (`/`) — ranní pohled

Stránka se načítá z `/api/dashboard/summary` (30s autorefresh).

| Widget | Co hlídat |
|---|---|
| **LiveActivityTicker** | 3 pilulky — odesláno/odpovězeno/problémy. Pokud jsou všechny šedé = BFF cron nevyběhl |
| **InboxBurndownWidget** | 7d sparkline reply saldo. Trend dolů = dobře (vyřizuješ víc, než přichází) |
| **BounceTrendMiniChart** | 14d bounce %. Nad 2 % → zkontroluj `/mailboxes` |
| **SendPacingWidget** | Horizontální bar — kolik sendů dnes odešlo vs. denní cap |
| **MailboxPulseWidget** | Kompaktní řádky per-mailbox. Červená = problém, zelená = v pořádku |
| **TodaysTargetsCard** | Top 5 leadů na dnes (Story LXXVIII) |

Pokud data vypadají stará: topbar tlačítko **"Obnovit vše"** (Story LXXIX) —
invaliduje všechny cache a vynutí re-fetch.

---

## Odpovědi (vysoká frekvence)

### Triage queue (`/replies/triage`)

Bulk harness pro zpracování reply backlogu. Zkratky:

| Klávesa | Akce |
|---|---|
| `J` / `K` | Přechod na další / předchozí reply |
| `1` | Dispozice: zájem (interested) |
| `2` | Dispozice: nezájem (uninterested) |
| `3` | Dispozice: automatická odpověď (auto_reply) |
| `R` | Načíst AI draft odpovědi |

Bulk reklasifikace přes Ollama: tlačítko na stránce `/replies` nebo triage.
Funguje jen pokud je `LLM_RUNNER_URL` nastaveno v `.env` a `features/platform/llm-runner`
běží. Bez Ollamiho klasifikuje regex engine (stále spolehlivý pro CZ B2B tóny).

### Inbox (`/replies`)

Standardní pohled na reply vlákna se statusem. Kliknutím na vlákno → `/replies/:id`
(ThreadDetail) — plný kontext konverzace.

---

## Pipeline (leady)

### Dnešní cíle

**TodaysTargetsCard** na Home ukazuje top 5 leadů doporučených pro kontakt dnes.
Kliknutím přejdeš na LeadDetail.

Plná pipeline: `/pipeline?sub=smart` — řazeno dle skóre + stáří + disposition.

### Dispozice flip

Na každém leadu máš **DispositionControl** (LeadDetail pravý panel + Pipeline inline).
Stavy: `new` → `contacted` → `interested` / `not_interested` / `nurture`.

Bulk flip pro velké kohorty: `/contacts/bulk-disposition`
— vždy zobrazí preview počtu dotčených kontaktů před aplikací.

---

## Kontakty

### Rychlé přidání

**QuickContactForm** na Home (`/`) — jméno + email + IČO, stiskni Enter.
Pro plný formulář: `/contacts` → tlačítko "Přidat kontakt".

### Vyhledávání

- **Cmd+K** (nebo `/search`) — CommandPalette — rychlé hledání přes celý dashboard
- `/search` — LeadSearch — text + tagy + disposition + skóre

---

## Operátorské akce na LeadDetail (`/leads/:contactId`)

### Telefonát

**PhoneCallTimer** — tlačítko "Zahájit hovor" → timer → tlačítko "Ukončit" → modal
pro zaznamenání výsledku. Záznam se ukládá do timeline kontaktu.

### Poznámky

**ContactNotesTimeline** na pravém panelu — chronologická timeline poznámek.
Přidáš kliknutím na textové pole + Ctrl+Enter.

### Compose

**ComposeToolbar** (Story LXII) — výběr šablony + pole pro personalizaci.
Šablony jsou v DB (`/templates`), ne v repozitáři.

---

## Urgentní situace

### Emergency pause

Topbar tlačítko **"Pozastavit vše"** (Story LXXX) — okamžitě pauzuje všechny
aktivní kampaně. Cooldown 30 s (prevence náhodného kliknutí). Použij při:
- Detekce bounce spike (BounceTrendMiniChart > 2 %)
- Podezřelá aktivita v logách
- Před ručním zásahem do DB

### Watchdog / upozornění mailboxů

`/mailboxes?tab=alerts` — přehledy alert stavů mailboxů (auth_locked, throttled, paused).
WatchdogReaperBadge v topbaru — červené číslo = klikni, uvidíš detail.

### Notifikační zvonek

**NotificationBell** v topbaru (Story LXXIII) — 10 prioritizovaných položek.
Kliknutím přejdeš na `/notifications` pro plný list.

---

## Konec dne

### Den summary strip

**OperatorTodaySummary** (Story LXXI) — úzký strip na spodku Home —
kolik leadů jsi dnes přidal, kolik dispozic flipnul, kolik odpovědí zpracoval.

### Večerní email (Story XXVI)

Cron **21:00 Prague** pošle "soused píše sousedovi" denní souhrn.
Formát stejný jako ranní briefing, ale s důrazem na výsledky dne a co čekat zítra.

### InboxBurndown trend

**InboxBurndownWidget** — 7d sparkline. Pokud salto roste (víc přichází, než odcházíš)
→ příští den prioritizuj triage před pipeline.

---

## Spuštění po restartu

```bash
# Terminal 1 — BFF
cd features/platform/outreach-dashboard && node server.js

# Terminal 2 — Vite UI
cd features/platform/outreach-dashboard && pnpm dev
```

Pak otevři `http://localhost:18175` v prohlížeči.
`/api/*` volání jdou přes Vite proxy na lokální BFF (:18001).

**Nikdy nepoužívej Railway** pro outreach-dashboard — v1 byl na Railway, od 2026-05-14
je kompletně lokální (HARD RULE `feedback_outreach_dashboard_local_only`).

---

## Rychlá mapa URL

| Co | URL |
|---|---|
| Ranní pohled | `/` (Home) |
| Triage odpovědí | `/replies/triage` |
| Všechny odpovědi | `/replies` |
| Pipeline leadů | `/pipeline` |
| Top cíle dnes | `/priprava/top-targets` |
| Kontakty | `/contacts` |
| Detail leadu | `/leads/:id` |
| Bulk dispozice | `/contacts/bulk-disposition` |
| Hledání | `/search` |
| Mailboxy | `/mailboxes` |
| Nastavení | `/settings` |
| Analýzy / crony | `/analytics?tab=crony` |
| Notifikace | `/notifications` |

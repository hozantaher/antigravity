# Superplán — B2B Outreach Platform

> **Verze:** 2.0
> **Datum:** 2026-04-21
> **Stav:** Finální — připraveno pro implementaci
> **Metoda:** TDD (Red → Green → Refactor)
> **Stack:** Go 1.25 + React 19 + Express 5 BFF + PostgreSQL

---

## Obsah

1. [Produkt & Persona](#1-produkt--persona)
2. [Design system](#2-design-system)
3. [Navigace & routing](#3-navigace--routing)
4. [Obrazovky — wireframy](#4-obrazovky--wireframy)
5. [Data model](#5-data-model)
6. [API kontrakt](#6-api-kontrakt)
7. [Background tasks](#7-background-tasks)
8. [Business rules](#8-business-rules)
9. [MVP roadmap — 28 milestones](#9-mvp-roadmap)
10. [TDD metodika](#10-tdd-metodika)
11. [Testing strategie](#11-testing-strategie)
12. [Security](#12-security)
13. [Deployment & infra](#13-deployment--infra)
14. [Metriky úspěchu](#14-metriky-úspěchu)
15. [Rizika & mitigace](#15-rizika--mitigace)

---

## 1. Produkt & Persona

### 1.1 Vize

B2B sales-engagement platforma pro český trh. Propojuje veřejné obchodní registry (ARES, firmy.cz) s automatizovaným, reputation-safe, anonymním emailovým oslovením. Operátor definuje koho oslovit — platforma zajistí doručení, měření, a konverzaci.

### 1.2 Klíčový koncept: jedno vlákno per kontakt

Platforma NENÍ email klient. Je to konverzační nástroj:

```
Vlákno: jan.novak@firma.cz (Kampaň: Excavator Q1)
─────────────────────────────────────────────────────
[auto]  Step 1 odesláno             15.4 10:23  ✓ opened
[auto]  Step 2 odesláno             19.4 09:15  ✓ opened
[in]    "Máte nabídku na Volvo?"    19.4 14:32  → positive
[out]   "Posílám katalog…" +PDF     19.4 15:01
[in]    "Kdy byste mohli přijet?"   20.4 09:44  → meeting
─────────────────────────────────────────────────────
Stav: Meeting request │ Lead ✓ │ Kampaň pozastavena
```

Thread key: `(campaign_id, contact_id)`. Groupuje auto-sendy, příchozí odpovědi, manuální reply chronologicky.

### 1.3 Persona: Operátor

| Atribut | Hodnota |
|---|---|
| Role | Obchodní zástupce / sales manager |
| Firma | Dealer těžké techniky (bagry, nakladače, jeřáby) |
| Počet | 1 člověk (single-tenant) |
| Tech level | Střední — umí email, CRM, nemusí CLI |
| Denní čas v platformě | 2–4 hodiny |
| Jazyk UI | Čeština |
| Zařízení | Desktop (laptop), občas tablet. Mobil ne. |

### 1.4 Typický den operátora

```
07:00  Denní report email (automatický, BFF cron)
       → Shrnutí: X odesláno, Y odpovědí, Z bouncí

08:30  Otevře dashboard (/)
       → Vidí: 3 unhandled replies, 1 watchdog alert, 2 active campaigns
       → Klikne na "3 nové odpovědi"

08:35  Inbox (/replies)
       → Tab "Nezpracované" (3 vlákna)
       → Klikne na první → ThreadDetail
       → Čte konverzaci, vidí: positive reply + příloha (PDF poptávka)
       → Stáhne PDF, napíše odpověď, přiloží katalog, odešle
       → Automaticky: handled ✓, lead created

08:50  Druhá odpověď: negative ("nemáme zájem")
       → Automaticky: suppressed, thread closed
       → Operátor jen potvrdí "handled"

09:00  Třetí: OOO auto-reply
       → Automaticky: thread paused 14 dní
       → Operátor ignoruje

09:05  Dashboard → Watchdog alert
       → Mailbox a.mazher@email.cz auto-paused (3 consecutive bounces)
       → Klikne → Mailboxes → vidí důvod → opraví → resume

09:15  Campaigns (/campaigns)
       → Chce spustit novou kampaň
       → "Nová kampaň" → wizard (4 kroky)
       → Quality gate: 85% valid emails, kapacita 150/den, ~4 dny
       → Potvrdí → kampaň running

09:30  Odchází dělat jinou práci

14:00  Vrátí se, zkontroluje CampaignDetail
       → Vidí KPIs: 45 sent, 12 opened, 2 replied
       → Vše OK, nechá běžet

17:00  Konec dne. Platforma posílá dál (do 17:00 business hours).
```

### 1.5 Notifikace

| Kanál | Kdy | Detail |
|---|---|---|
| Dashboard badge | Real-time | Unhandled reply count v sidebar |
| Denní report email | 07:00 CET | BFF cron, shrnutí za 24h |
| Dashboard watchdog | Real-time | Kritické alerty (mailbox down, high bounce) |
| Push/Slack | Není v scope | Operátor kontroluje dashboard ručně |

### 1.6 Co platforma NENÍ

- Email klient (nekomponuje volné emaily, jen odpovídá na vlákna)
- Multi-tenant SaaS (1 instance = 1 zákazník)
- CRM (leads se exportují do externího CRM)
- Marketing automation (žádné landing pages, formuláře, A/B web)
- Mobilní app

---

## 2. Design system

### 2.1 Palette (Linear-inspired)

```css
/* Light theme */
--bg:       #F5F6F8    /* page background */
--surface:  #FFFFFF    /* cards, panels */
--surface2: #EEEFF1    /* sidebar, hover */
--surface3: #E2E3E6    /* deeper hover */
--border:   #D4D5D9    /* dividers */
--text:     #0A0B0D    /* primary text */
--muted:    #55585F    /* secondary text */
--accent:   #4B57C2    /* indigo — CTAs, active states */
--green:    #4CB782    /* success */
--red:      #E5484D    /* error, danger */
--yellow:   #E2B04A    /* warning */
--blue:     #5EA8D8    /* info */
--orange:   #E08C3E    /* attention */

/* Dark theme */
--bg:       #111214
--surface:  #1A1B1E
--surface2: #222326
--accent:   #8891F7    /* lighter indigo */
```

### 2.2 Typography

```css
--font-sans: 'Inter', system-ui, sans-serif;   /* UI text */
--font-mono: 'JetBrains Mono', monospace;       /* code, IDs */

--text-2xs:  10px    --text-xs:   11px
--text-sm:   12px    --text-base: 13px
--text-md:   14px    --text-lg:   16px
--text-xl:   19px    --text-2xl:  25px
--text-3xl:  31px
```

### 2.3 Spacing scale

```css
--s-0: 2px   --s-1: 3px   --s-2: 6px   --s-3: 10px
--s-4: 13px  --s-5: 15px  --s-6: 19px  --s-7: 25px
--s-8: 37px  --s-9: 51px  --s-10: 76px
```

### 2.4 Layout constants

```css
--sidebar:           244px
--sidebar-collapsed: 48px
--topbar-h:          48px
--row-h:             30px
--page-pad:          19px  /* var(--s-6) */
--drawer-w:          302px
--modal-w:           480px
--modal-lg-w:        640px
```

### 2.5 Border radius & shadows

```css
--radius-sm: 3px   --radius: 4px
--radius-lg: 7px   --radius-xl: 10px

--shadow-sm:  0 1px 2px rgba(0,0,0,.06)
--shadow-md:  0 2px 8px rgba(0,0,0,.08)
--shadow-lg:  0 4px 16px rgba(0,0,0,.12)
```

### 2.6 Component vocabulary

| Component | CSS class | Použití |
|---|---|---|
| Button primary | `.btn .btn-primary` | CTA akce |
| Button ghost | `.btn .btn-ghost` | Sekundární akce |
| Button icon | `.btn .btn-icon` | Ikona bez textu |
| Modal | `.modal .modal-bg` | Dialogový overlay |
| Modal large | `.modal-lg` | Wizard, formuláře |
| Toast | `.toast .toast-ok/err/info` | Notifikace |
| Badge | `.badge-green/yellow/red/gray/blue` | Status indikátor |
| Drawer | `.drawer-panel` | Detail panel vpravo (302px) |
| Table | `.table-wrap .dt` | Datová tabulka |
| KPI cell | `.kpi-cell` | Metrika s labelem a hodnotou |
| Skeleton | `Skeleton` component | Loading placeholder |
| Spinner | `Spinner` component | Loading indikátor |
| Search | `SearchInput` component | Vyhledávací pole |

---

## 3. Navigace & routing

### 3.1 Sidebar

```
┌──────────────────────┐
│  LOGO / Workspace    │
├──────────────────────┤
│  ● Přehled      ⌘1  │  → /
│    Odpovědi  (3) ⌘2  │  → /replies        badge: unhandled count
│    Kampaně       ⌘3  │  → /campaigns
│    Firmy         ⌘4  │  → /companies
│    Analytika     ⌘5  │  → /analytics
├──────────────────────┤
│  DATA                │
│    Kontakty          │  → /contacts
│    Uložené filtry    │  → /segments
├──────────────────────┤
│  NASTAVENÍ           │
│    Schránky          │  → /mailboxes
│    Šablony           │  → /templates
│    Skórování         │  → /scoring
│    Upozornění        │  → /watchdog
├──────────────────────┤
│  [avatar] Workspace ▾│  Theme toggle, Help, Cmd palette
└──────────────────────┘
```

### 3.2 Routes

| Path | Component | Popis |
|---|---|---|
| `/` | Dashboard | Landing page, přehled |
| `/replies` | Replies | Thread list + slide-over |
| `/replies/:id` | ThreadDetail | Konverzace + reply compose |
| `/campaigns` | Campaigns | Seznam + create modal |
| `/campaigns/:id` | CampaignDetail | KPIs, sequence, sends |
| `/companies` | Companies | Filtrovaný seznam + drawer |
| `/contacts` | Contacts | Contact list + drawer |
| `/segments` | Segments | Saved filters + QueryBuilder |
| `/mailboxes` | Mailboxes | Config, health, warmup |
| `/templates` | Templates | CRUD + preview |
| `/analytics` | Analytics | KPIs, timeline chart, campaign table |
| `/scoring` | Scoring | Tier management |
| `/watchdog` | Watchdog | Self-healing event log |

### 3.3 Keyboard shortcuts

| Shortcut | Akce |
|---|---|
| `⌘K` | Command palette |
| `⌘N` | Nová kampaň |
| `⌘1-5` | Navigace (Přehled → Analytika) |
| `/` | Focus search |
| `?` | Help overlay |
| `Esc` | Zavřít modal/drawer |

---

## 4. Obrazovky — wireframy

### 4.1 Dashboard (/) — EXISTUJE ✅

```
┌─ Přehled ──────────────────────────────────────────┐
│                                                     │
│  Dobré ráno ☀️  21. dubna 2026                      │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ Watchdog │  │ 3 nové   │  │ Mailbox  │          │
│  │ 1 alert  │  │ odpovědi │  │ 1 issue  │          │
│  │ ⚠ yellow │  │ → /reply │  │ → /mail  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                     │
│  Kampaně                                            │
│  ┌─────────────────────────────────────────┐        │
│  │ Excavator Q1   running  120 sent  6.7% │        │
│  │ Loader Promo   paused    45 sent  4.4% │        │
│  └─────────────────────────────────────────┘        │
│                                                     │
│  Healing log                                        │
│  ┌─────────────────────────────────────────┐        │
│  │ a.mazher@.. auto_pause  3h ago          │        │
│  └─────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

### 4.2 Replies (/replies) — EXISTUJE ✅, POTŘEBUJE ROZŠÍŘENÍ

Současný stav: tabulka + slide-over panel (302px). Potřebuje: lepší thread preview.

```
┌─ Odpovědi ─────────────────────────────────────────────────────────┐
│                                                                     │
│  [Vše] [Nezpracované(3)] [Zájem] [Odmítnutí] [Auto-reply]         │
│                                                                     │
│  ┌─────────────────────────────────────────────┬───────────────┐   │
│  │ Thread list                                  │ Slide-over   │   │
│  ├──────────┬──────────┬────────┬──────┬───────┤               │   │
│  │ Kontakt  │ Předmět  │ Kampaň │ Klas.│ Čas   │ Jan Novák    │   │
│  ├──────────┼──────────┼────────┼──────┼───────┤ jan@firma.cz │   │
│  │•Jan Nov. │ RE: Naše │ Exc Q1 │ 🟢  │ 1h    │              │   │
│  │ Petr Dv. │ Odhlaste │ Exc Q1 │ 🔴  │ 2h    │ Klasifikace: │   │
│  │ Auto     │ OOO: Jsem│ Load P │ ⚪  │ 3h    │ 🟢 Positive  │   │
│  │          │          │        │      │       │              │   │
│  │          │          │        │      │       │ Kampaň:      │   │
│  │          │          │        │      │       │ Excavator Q1 │   │
│  │          │          │        │      │       │              │   │
│  │          │          │        │      │       │ Předmět:     │   │
│  │          │          │        │      │       │ RE: Naše     │   │
│  │          │          │        │      │       │ nabídka      │   │
│  │          │          │        │      │       │              │   │
│  │          │          │        │      │       │ [Handled ✓]  │   │
│  │          │          │        │      │       │ [→ Vlákno]   │   │
│  └──────────┴──────────┴────────┴──────┴───────┴───────────────┘   │
│                                                                     │
│  [Načíst další]                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Klik na řádek → slide-over. Klik na "→ Vlákno" → `/replies/:id` (ThreadDetail).

### 4.3 ThreadDetail (/replies/:id) — EXISTUJE ✅, POTŘEBUJE PŘESTAVBU

Současný stav: jednoduchý detail + textarea. Cílový stav: plná konverzace s přílohy.

```
┌─ ← Zpět   jan.novak@firma.cz                                      ┐
│  Kampaň: Excavator Q1 │ 🟢 Positive │ Lead ✓                      │
│─────────────────────────────────────────────────────────────────────│
│                                                                     │
│  KONVERZACE                                   KONTEXT              │
│  ┌────────────────────────────────────┐  ┌──────────────────┐      │
│  │                                    │  │ Firma            │      │
│  │  [auto] Step 1         15.4 10:23  │  │ Novák s.r.o.     │      │
│  │  ┌──────────────────────────────┐  │  │ IČO: 12345678    │      │
│  │  │ Dobrý den pane Nováku,      │  │  │ Stavebnictví     │      │
│  │  │ píšu Vám ohledně naší       │  │  │ Praha            │      │
│  │  │ nabídky bagrů Volvo...      │  │  │                  │      │
│  │  └──────────────────────────────┘  │  │ Kampaň           │      │
│  │                                    │  │ Excavator Q1     │      │
│  │  [auto] Step 2         19.4 09:15  │  │ Status: running  │      │
│  │  ┌──────────────────────────────┐  │  │ Sent: 120        │      │
│  │  │ Dovolujeme si navázat...    │  │  │ Replied: 8       │      │
│  │  └──────────────────────────────┘  │  │                  │      │
│  │                                    │  │ Klasifikace      │      │
│  │  [in] Odpověď          19.4 14:32  │  │ 🟢 Positive      │      │
│  │  ┌──────────────────────────────┐  │  │                  │      │
│  │  │ Dobrý den,                  │  │  │ Kontaktováno     │      │
│  │  │ máte nabídku na Volvo       │  │  │ 3× (step 1,2 +  │      │
│  │  │ EC300? Posílám poptávku.    │  │  │ reply)           │      │
│  │  │                             │  │  │                  │      │
│  │  │ 📎 poptavka.pdf (245 KB)    │  │  │ [Handled ✓]      │      │
│  │  │    [Stáhnout]               │  │  └──────────────────┘      │
│  │  └──────────────────────────────┘  │                            │
│  │                                    │                            │
│  │  [out] Manuální reply  19.4 15:01  │                            │
│  │  ┌──────────────────────────────┐  │                            │
│  │  │ Dobrý den pane Nováku,      │  │                            │
│  │  │ posílám katalog a ceník...  │  │                            │
│  │  │                             │  │                            │
│  │  │ 📎 katalog-volvo.pdf (1.2M) │  │                            │
│  │  └──────────────────────────────┘  │                            │
│  │                                    │                            │
│  │  ─────────── REPLY ──────────────  │                            │
│  │  ┌──────────────────────────────┐  │                            │
│  │  │ Napište odpověď...           │  │                            │
│  │  │                              │  │                            │
│  │  │                              │  │                            │
│  │  └──────────────────────────────┘  │                            │
│  │  📎 Přiložit (max 3, 10MB each)   │                            │
│  │  [Odeslat]                         │                            │
│  └────────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

Layout: 70/30 split. Vlevo konverzace. Vpravo kontext (firma + kampaň + klasifikace).

Zprávy mají vizuální odlišení:
- `[auto]` — šedý bg, malý font, collapsed by default
- `[in]` — bílý bg, zelený/červený left border dle klasifikace
- `[out]` — accent bg (light indigo), right-aligned

### 4.4 Campaigns (/campaigns) — EXISTUJE ✅

```
┌─ Kampaně ─────────────────────────────── [+ Nová kampaň] ──────────┐
│                                                                     │
│  ┌──────────┬─────────┬───────┬─────────┬──────────┬─────────────┐ │
│  │ Název    │ Status  │ Sent  │ Replied │ Vytvořena│ Akce        │ │
│  ├──────────┼─────────┼───────┼─────────┼──────────┼─────────────┤ │
│  │ Excav Q1 │ 🟢 run  │ 120   │ 8 (6.7%)│ 14.4     │ ⏸ 🗑      │ │
│  │ Loader P │ ⏸ pause │  45   │ 2 (4.4%)│ 19.4     │ ▶ 🗑      │ │
│  │ Crane 26 │ ○ draft │   0   │ 0       │ 21.4     │ ▶ 🗑      │ │
│  └──────────┴─────────┴───────┴─────────┴──────────┴─────────────┘ │
│                                                                     │
│  Row click → /campaigns/:id (CampaignDetail)                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.5 CampaignDetail (/campaigns/:id) — EXISTUJE ✅

```
┌─ ← Kampaně   Excavator Q1  🟢 running  [⏸ Pozastavit] [↻]────────┐
│                                                                     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐           │
│  │ Fronta │ │Odesláno│ │Otevřeno│ │Odpovědi│ │Bounced │           │
│  │   45   │ │  120   │ │   30   │ │    8   │ │    2   │           │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘           │
│                                                                     │
│  ┌── Funnel: Sent(120) → Opened(30) → Replied(8) ──┐              │
│                                                                     │
│  ┌─ Sekvence ──────────────┐  ┌─ Targeting ─────────────────┐     │
│  │ Step 1: Úvodní šablona  │  │ Kategorie: Stavebnictví/*   │     │
│  │ Step 2: Follow-up (+3d) │  │ Match: prefix               │     │
│  │ Step 3: Reminder (+5d)  │  │ Odhad kontaktů: 250         │     │
│  └─────────────────────────┘  └──────────────────────────────┘     │
│                                                                     │
│  ┌─ Poslední odeslané ──────────────────────────────────────┐      │
│  │ Kontakt      │ Předmět        │ Step │ Status │ Odesláno│      │
│  │ jan@firma.cz │ Naše nabídka   │ 1    │ ✓ sent │ 21.4    │      │
│  │ petr@co.cz   │ Naše nabídka   │ 1    │ ✓ sent │ 21.4    │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.6 CampaignNew wizard (Modal) — POTŘEBUJE DOKONČIT

4-krokový stepper v modal-lg (640px):

```
┌─ Nová kampaň ────────────────────────────────── ✕ ──┐
│                                                      │
│  ① Základní  ② Šablona  ③ Segment  ④ Sekvence      │
│  ─────●────────○──────────○──────────○──────        │
│                                                      │
│  KROK 1: Základní údaje                              │
│  ┌──────────────────────────────────────────┐        │
│  │ Název kampaně *                          │        │
│  │ [________________________]               │        │
│  │                                          │        │
│  │ Popis (volitelný)                        │        │
│  │ [________________________]               │        │
│  │ [________________________]               │        │
│  │                                          │        │
│  │ Kategorie (volitelné)                    │        │
│  │ [Stavebnictví, Strojírenství]            │        │
│  │                                          │        │
│  │ Match type                               │        │
│  │ (●) Prefix  ( ) Exact                    │        │
│  └──────────────────────────────────────────┘        │
│                                                      │
│                            [Zpět]  [Další →]         │
└──────────────────────────────────────────────────────┘

KROK 2: Výběr šablon
  → Seznam šablon s preview (subject + body snippet)
  → Multi-select pro sekvenci

KROK 3: Výběr segmentu
  → Dropdown existujících segmentů
  → Preview: "Segment 'Stavební firmy' — 1 250 firem"
  → Nebo inline QueryBuilder pro ad-hoc filtr

KROK 4: Sekvence
  → Řazení vybraných šablon (drag or arrows)
  → Delay mezi kroky (dny)
  → Preview celé sekvence
  → [Vytvořit kampaň]
```

### 4.7 Quality Gate Modal — POTŘEBUJE VYTVOŘIT

Zobrazí se po kliknutí "Spustit" na CampaignDetail:

```
┌─ Kontrola před spuštěním ─────────────────── ✕ ──┐
│                                                    │
│  Email quality                                     │
│  ┌──────────────────────────────────────────┐      │
│  │ Celkem kontaktů:  250                    │      │
│  │ ✅ Valid:          195 (78%)              │      │
│  │ ⚠️ Risky:           12 (5%)              │      │
│  │ ⚠️ Catch-all:       18 (7%)              │      │
│  │ ❌ Invalid:           8 (3%)             │      │
│  │ ❓ Neověřeno:        17 (7%)             │      │
│  │                                          │      │
│  │ [████████████████░░░] 78% valid          │      │
│  └──────────────────────────────────────────┘      │
│                                                    │
│  Kapacita                                          │
│  ┌──────────────────────────────────────────┐      │
│  │ Aktivní schránky:  3                     │      │
│  │ Denní kapacita:    150 emails            │      │
│  │ Odhad dokončení:   ~4 dny               │      │
│  └──────────────────────────────────────────┘      │
│                                                    │
│  DNS check                                         │
│  ┌──────────────────────────────────────────┐      │
│  │ ✅ SPF: pass                             │      │
│  │ ✅ DKIM: pass                            │      │
│  │ ✅ DMARC: pass                           │      │
│  └──────────────────────────────────────────┘      │
│                                                    │
│  ⚠ 17 kontaktů nemá ověřený email.                │
│                                                    │
│  [Zrušit] [Ověřit neověřené] [Spustit kampaň]     │
└────────────────────────────────────────────────────┘
```

### 4.8 Companies (/companies) — EXISTUJE ✅

```
┌─ Firmy (48 320) ──────────────────────────────────────────────────┐
│                                                                    │
│  [🔍 Hledat...] [Hledat] [Kategorie ▾] [Vyčistit]                │
│  [Preset ▾]                                                        │
│                                                                    │
│  Chips: [Stavebnictví ✕] [Praha ✕] [ICP A ✕]                     │
│                                                                    │
│  Filtry: ICP | Velikost | Skóre [====] | Region | Sektor          │
│          Engagement | Datum | Email conf. | Web | Email status    │
│                                                                    │
│  ┌────────┬──────────┬──────┬─────┬───────┬──────┬──────────────┐ │
│  │ Firma  │ Kategorie│ Město│ ICP │ Email │ Kont.│ Skóre        │ │
│  ├────────┼──────────┼──────┼─────┼───────┼──────┼──────────────┤ │
│  │ Novák  │ Staveb.  │ Praha│  A  │ ✅85% │ 14.4 │ ████░ 78     │ │
│  │ s.r.o. │          │      │     │       │      │              │ │
│  └────────┴──────────┴──────┴─────┴───────┴──────┴──────────────┘ │
│                                                                    │
│  Row click → CompanyDrawer (302px, right)                          │
│  Drawer: Score breakdown, email verify, contacts, campaigns        │
└────────────────────────────────────────────────────────────────────┘
```

### 4.9 Segments (/segments) — EXISTUJE ✅

```
┌─ Uložené filtry ──────────────────────── [+ Nový filtr] ──────────┐
│                                                                     │
│  ┌──────────┬──────────────────────┬───────┬──────────┐            │
│  │ Název    │ Filtr                │ Firem │ Rebuild  │            │
│  ├──────────┼──────────────────────┼───────┼──────────┤            │
│  │ Stavební │ ICP A+B, Praha, >50  │ 1 250 │ 2h ago   │            │
│  │ firmy    │                      │       │          │            │
│  └──────────┴──────────────────────┴───────┴──────────┘            │
│                                                                     │
│  Row click → SegmentDrawer (right panel)                            │
│  [+ Nový filtr] → SegmentModal (QueryBuilder + preview)             │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.10 Mailboxes (/mailboxes) — EXISTUJE ✅

```
┌─ Poštovní schránky ──────────────────── [+ Přidat] ───────────────┐
│                                                                     │
│  [🔍 Hledat...] [Status: Všechny stavy ▾]                         │
│                                                                     │
│  Celkem: 5 schránek (3 aktivní, 1 paused, 1 bounce hold)          │
│                                                                     │
│  ┌──────────────┬────────┬──────┬────────┬──────────┬─────────┐   │
│  │ Email        │ Status │ Sent │ Bounce │ Warmup   │ Proxy   │   │
│  ├──────────────┼────────┼──────┼────────┼──────────┼─────────┤   │
│  │ a.mazher@    │ 🟢 act │ 382  │ 2.1%   │ Day 7    │ ✅ CZ   │   │
│  │ mazher.a@    │ ⏸ pau  │   0  │ 0%     │ —        │ ❌ none │   │
│  └──────────────┴────────┴──────┴────────┴──────────┴─────────┘   │
│                                                                     │
│  Row click → Mailbox detail drawer/expanded row                     │
│  (SMTP check, IMAP check, warmup config, pipeline test,            │
│   send log, bounce status, cooldown log, alerts, proxy check)      │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.11 Templates (/templates) — EXISTUJE ✅

```
┌─ Šablony ────────────────────────────── [+ Nová šablona] ─────────┐
│                                                                     │
│  ┌──────────────┬──────────────────────────┬──────────┬──────┐     │
│  │ Název        │ Předmět                  │ Vytvořena│ Akce │     │
│  ├──────────────┼──────────────────────────┼──────────┼──────┤     │
│  │ Úvodní       │ Naše nabídka pro {{fi... │ 21.4     │ ✏ 🗑│     │
│  │ Follow-up    │ Navazuji na předchozí... │ 21.4     │ ✏ 🗑│     │
│  └──────────────┴──────────────────────────┴──────────┴──────┘     │
│                                                                     │
│  [+ Nová] / [✏ Edit] → TemplateModal                               │
│  Fields: name, subject, body (textarea with {{vars}})               │
│  Preview: rendered with sample data                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.12 Analytics (/analytics) — EXISTUJE ✅

```
┌─ Analytika ────────────────────────────────────────────────────────┐
│                                                                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │Odesláno │ │Reply    │ │Open     │ │Bounce   │ │Aktivní  │    │
│  │ 1 234   │ │rate 5%  │ │rate 25% │ │rate 1.5%│ │kampaně 1│    │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘    │
│                                                                     │
│  Vývoj v čase  [7d] [14d] [30d]                                    │
│                [Odesláno] [Odpovědi] [Otevřeno]                    │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │  ▄                                                      │       │
│  │  █ ▄     ▄                                              │       │
│  │  █ █ ▄ ▄ █ ▄     ▄ ▄   ▄                               │       │
│  │  █ █ █ █ █ █ ▄ ▄ █ █ ▄ █  (SVG bar chart)              │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  Výkonnost kampaní                                                  │
│  ┌──────────┬────────┬───────┬────────┬───────┬────────┐          │
│  │ Kampaň   │ Status │ Sent  │ Replied│ Opened│ Bounced│          │
│  ├──────────┼────────┼───────┼────────┼───────┼────────┤          │
│  │ Excav Q1 │ active │ 120   │ 8      │ 30    │ 2      │          │
│  └──────────┴────────┴───────┴────────┴───────┴────────┘          │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.13 Contacts (/contacts) — EXISTUJE ✅

Tabulka kontaktů se search, status filtr (chips), drawer detail s email verify a send history.

### 4.14 Scoring (/scoring) — EXISTUJE ✅

Tier management, weight config, preview, recompute.

### 4.15 Watchdog (/watchdog) — EXISTUJE ✅

Self-healing event log, daemon status, protection probe results.

---

## 5. Data model

### 5.1 ER diagram (zjednodušený)

```
campaigns ──1:N──→ campaign_contacts ──N:1──→ contacts
    │                     │
    │                     ├──1:N──→ send_events ──1:N──→ tracking_events
    │                     │              │
    │                     │              ├──1:N──→ bounce_events
    │                     │              │
    │                     │              └──1:1──→ protection_trace
    │                     │
    └──1:N──→ outreach_threads ──1:N──→ outreach_messages
                                              │
                                              └──1:N──→ attachments (MVP)

segments ──M:N──→ companies (via segment_memberships)

outreach_mailboxes ──1:N──→ mailbox_warmup
                   ──1:N──→ mailbox_auth_fails
                   ──1:N──→ mailbox_cooldown_log
                   ──1:N──→ watchdog_events

contacts ──1:N──→ leads
         ──1:N──→ unsubscribes
         ──1:1──→ blacklist (via email)

companies ──1:N──→ contacts (via ico)

categories ──1:N──→ category_suppressions
```

### 5.2 Tabulky — kompletní katalog

#### Kontakty & firmy

**contacts** — unified contact schema (Schema A)
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| email | TEXT NOT NULL | |
| email_hash | TEXT UNIQUE | SHA256 hash pro dedup |
| first_name, last_name | TEXT | |
| company_name, ico | TEXT | Vazba na companies |
| region, industry | TEXT | |
| company_size | TEXT | |
| score | SMALLINT 0-100 | ICP skóre |
| status | TEXT | active/bounced/blacklisted/unsubscribed/opted_out |
| validation_result | JSONB | Výsledek email verifikace |
| source | TEXT | ares/firmy/csv_import |
| imported_at, validated_at, last_contacted | TIMESTAMPTZ | |
| created_at, updated_at | TIMESTAMPTZ | |

**companies** — Czech commercial registry
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| ico | TEXT UNIQUE | IČO |
| name | TEXT | Obchodní název |
| sector_primary, sector_tags | TEXT, TEXT[] | Odvětví |
| nace_codes, nace_primary | TEXT[], TEXT | NACE klasifikace |
| email, website | TEXT | Kontaktní údaje |
| region_normalized | TEXT | Kraj |
| company_size, legal_form | TEXT | |
| icp_score | INTEGER | ICP skóre |
| icp_tier | TEXT | A/B/C/D |
| email_status | TEXT | unverified/verified/risky/invalid |
| exclusion_status | TEXT | pending/approved/soft_block/hard_block |
| icp_factors | JSONB | Score breakdown |
| description_tags | JSONB | Enrichment metadata |
| created_at, updated_at | TIMESTAMPTZ | |

**outreach_contacts** — legacy schema B (being migrated to contacts)
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| email, email_hash | TEXT | |
| domain_id | FK→domains | |
| industry_tags | TEXT[] | |
| consent_score | INTEGER | |
| total_sent/opened/replied/bounced | INTEGER | Engagement counters |
| status | TEXT | |

#### Kampaně & sending

**campaigns**
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| name, description | TEXT | |
| status | TEXT | draft/running/paused/completed |
| segment_query | JSONB | Filter definice |
| sequence_config | JSONB | [{step, delay_days, template}] |
| sending_config | JSONB | Timing, limits |
| stats | JSONB | Cached aggregáty |
| started_at, completed_at | TIMESTAMPTZ | |
| created_at, updated_at | TIMESTAMPTZ | |

**campaign_contacts** — enrollment M:N
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| campaign_id | FK→campaigns | |
| contact_id | FK→contacts | |
| current_step | SMALLINT | Aktuální krok sekvence |
| status | TEXT | pending/in_sequence/completed/bounced |
| next_send_at | TIMESTAMPTZ | Kdy poslat další |
| UNIQUE | (campaign_id, contact_id) | Dedup constraint |

**send_events** — každý odeslaný email
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| campaign_id, contact_id | FK | |
| step | SMALLINT | Krok sekvence |
| mailbox_used | TEXT | From address |
| message_id | TEXT INDEXED | RFC Message-ID |
| subject, content_hash | TEXT | |
| status | TEXT | queued/sent/bounced/failed |
| smtp_response | TEXT | |
| message_type | TEXT | campaign/manual_reply (MVP) |
| sent_at | TIMESTAMPTZ | |

**tracking_events** — open/click events
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| send_event_id | FK→send_events | |
| event_type | TEXT | open/click |
| metadata | JSONB | URL, source |
| ip_address | INET | |
| user_agent | TEXT | |

**bounce_events** — hard/soft/complaint
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| send_event_id | FK→send_events | |
| contact_id | FK→contacts | |
| bounce_type | TEXT | hard/soft/complaint |
| bounce_code, bounce_reason | TEXT | |
| raw_message | TEXT | |

#### Vlákna & odpovědi

**outreach_threads** — konverzace (campaign × contact)
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| contact_id | FK→contacts | |
| campaign_id | INTEGER | |
| status | TEXT | new/active/paused/completed/error |
| current_step | INTEGER | |
| next_action_at | TIMESTAMPTZ | |
| next_action | TEXT | send_next/wait_reply/manual_follow |
| pause_until | TIMESTAMPTZ | OOO/later pause |

**outreach_messages** — zprávy ve vláknu
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| thread_id | FK→outreach_threads | |
| direction | TEXT | inbound/outbound |
| message_id, in_reply_to, references_header | TEXT | RFC threading |
| subject, body_preview | TEXT | |
| body_hash | TEXT | Dedup |
| sentiment | TEXT | positive/negative/neutral/ooo/meeting |
| reply_type | TEXT | direct/forward/auto |
| sent_at, delivered_at, opened_at, replied_at, bounced_at | TIMESTAMPTZ | |
| mailbox_used | TEXT | |
| humanize_applied | BOOLEAN | |
| is_bump | BOOLEAN | Auto follow-up |

**attachments** — přílohy (migration 046, MVP)
| Sloupec | Typ | Popis |
|---|---|---|
| id | BIGSERIAL PK | |
| message_type | TEXT | reply/manual_reply |
| message_id | BIGINT | FK na outreach_messages |
| filename | TEXT | Původní název |
| content_type | TEXT | MIME type |
| size_bytes | INTEGER | |
| data | BYTEA | Binární obsah |
| INDEX | (message_type, message_id) | |

Limity: max 10 MB/soubor, max 3/zpráva. Kampaňové emaily NIKDY nemají přílohy.

#### Mailboxy

**outreach_mailboxes** — registry
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| from_address | TEXT UNIQUE | |
| display_name, persona_slug | TEXT | |
| smtp_host, smtp_port, smtp_username | TEXT, INT, TEXT | |
| imap_host, imap_port, imap_username | TEXT, INT, TEXT | |
| daily_cap_override | INTEGER NULL | NULL = use warmup |
| tz, locale | TEXT | |
| status | TEXT | active/paused/bounce_hold/retired |
| status_reason | TEXT | |
| last_send_at | TIMESTAMPTZ | |
| consecutive_bounces | INTEGER | |
| total_sent, total_bounced | INTEGER | |

**mailbox_warmup** — ramp schedule
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| from_address | TEXT | |
| warmup_day | INTEGER | Den rampu (1-30) |
| daily_limit | INTEGER | Limit pro daný den |
| sent_today | INTEGER | Dnešní počítadlo |
| last_send_at | TIMESTAMPTZ | |

**mailbox_auth_fails** — auth failure log
**mailbox_cooldown_log** — hold/release/retire audit
**watchdog_events** — self-heal events (bounce_decay, auth_spike, proxy_swap, circuit_trip/close)

#### Segmenty & kategorie

**segments** — named audience filters
| Sloupec | Typ | Popis |
|---|---|---|
| id | SERIAL PK | |
| name | TEXT UNIQUE | |
| description | TEXT | |
| query | JSONB | {op:"AND", conditions:[{field,op,value}]} |
| company_count | INTEGER | Cached count |
| last_built_at | TIMESTAMPTZ | |

**segment_memberships** — segment→company M:N
| Sloupec | Typ | Popis |
|---|---|---|
| segment_id | FK→segments | PK |
| company_id | FK→companies | PK |
| added_at | TIMESTAMPTZ | |

**categories** — email category classification
**category_suppressions** — per-category suppression rules

#### Suppression & compliance

**blacklist** — global suppression (hard bounces + complaints)
| email | TEXT UNIQUE | |
| domain | TEXT | |
| reason, source_event_id | TEXT, FK | |

**unsubscribes** — explicit opt-outs
| contact_id | FK | |
| email | TEXT | |
| token | TEXT UNIQUE | Unsubscribe link token |

**outreach_suppressions** — thread-level (negative reply suppression)

#### Audit & protection

**audit_log** — general entity change log (INSERT only, immutable)
**operator_audit_log** — dashboard operator actions
**protection_probes** — L2/L3 probe results
**protection_trace** — per-send protection layer status
**protection_alerts** — escalation tracking

#### Other

**leads** — lead/opportunity tracking (migration 044)
| id, contact_id (FK), campaign_id (FK), status, source, notes |
| UNIQUE: (contact_id, campaign_id) |

**manual_reply_outbox** — operator-composed replies
**outreach_config** — singleton global config (key-value)

---

## 6. API kontrakt

### 6.1 Go backend endpoints

#### Public (no auth)
| Method | Path | Popis |
|---|---|---|
| GET | `/o` | Open pixel tracking |
| GET | `/c` | Click redirect tracking |
| GET | `/healthz` | Health check |
| GET | `/unsubscribe` | Self-service unsubscribe (token) |
| GET | `/metrics` | Prometheus metrics |

#### Protected (X-API-Key)
| Method | Path | Popis |
|---|---|---|
| GET | `/health` | Detailed health status |
| GET | `/dashboard` | Dashboard index |
| POST | `/recalc?contact_id=` | Recalculate contact score |
| GET | `/api/campaigns` | List campaigns |
| POST | `/api/campaigns` | Create campaign |
| GET | `/api/campaigns/:id` | Campaign detail |
| PATCH | `/api/campaigns/:id` | Update campaign |
| POST | `/api/campaigns/:id/dry-run` | Preview send |
| GET | `/api/segments` | List segments |
| POST | `/api/segments` | Create segment |
| GET | `/api/segments/:id` | Segment detail |
| PATCH | `/api/segments/:id` | Update segment |
| POST | `/api/segments/:id/rebuild` | Rebuild membership |
| POST | `/api/segments/:id/apply?campaign_id=` | Apply to campaign |
| GET | `/api/categories` | List categories |
| POST | `/api/replies/:id/reply` | Record manual reply |
| POST | `/api/contacts/import` | Bulk CSV import |
| POST | `/api/suppressions/bulk` | Bulk suppress |
| GET | `/api/dns-audit` | DNS audit |
| GET | `/api/v1/health/deliverability` | Deliverability stats |
| POST | `/api/mailboxes/release-hold` | Release bounce-hold |

### 6.2 BFF endpoints (Express, server.js)

#### Companies & scoring (20+ endpoints)
| Method | Path | Popis |
|---|---|---|
| GET | `/api/companies` | Paginated list + filters |
| GET | `/api/companies/stats` | Total count |
| GET | `/api/companies/regions` | Autocomplete |
| GET | `/api/companies/sectors` | Autocomplete |
| GET | `/api/companies/facets` | Filter facet counts (cached 30s) |
| GET | `/api/companies/:ico` | Detail |
| POST | `/api/companies/:ico/verify-email` | Email verification |
| POST | `/api/companies/bulk-verify-email` | Batch verify (max 50) |
| GET | `/api/companies/:ico/verification-history` | Audit log |
| GET | `/api/companies/:ico/recompute-score` | Recompute |
| GET | `/api/companies/:ico/expected-value` | EV + propensity |
| GET | `/api/companies/:ico/data-quality` | Quality metrics |
| GET | `/api/companies/:ico/readiness` | Verification readiness |
| GET | `/api/companies/:ico/lookalike` | Lookalike matches |
| POST | `/api/companies/:ico/facts` | Upsert fact |
| GET | `/api/companies/:ico/facts` | Fact history |
| GET | `/api/scoring/config` | Current weights |
| PUT | `/api/scoring/config` | Update weights |
| POST | `/api/scoring/preview` | Preview on sample |
| POST | `/api/scoring/recompute-all` | Bulk recompute |
| POST | `/api/scoring/learn` | Logistic regression train |
| GET | `/api/scoring/stats` | Tier distribution |

#### Campaigns (10 endpoints)
| Method | Path | Popis |
|---|---|---|
| GET | `/api/campaigns` | List |
| POST | `/api/campaigns` | Create |
| GET | `/api/campaigns/:id` | Detail |
| PATCH | `/api/campaigns/:id` | Update |
| DELETE | `/api/campaigns/:id` | Delete |
| GET | `/api/campaigns/:id/sends` | Send events |
| GET | `/api/campaigns/:id/estimate` | Target + capacity |
| GET | `/api/campaigns/:id/email-quality` | Quality assessment |
| GET | `/api/campaigns/:id/capacity` | Mailbox capacity |
| POST | `/api/campaigns/:id/run` | Start |
| POST | `/api/campaigns/:id/pause` | Pause |

#### Segments (6 endpoints)
| Method | Path | Popis |
|---|---|---|
| GET | `/api/segments` | List |
| POST | `/api/segments` | Create |
| PATCH | `/api/segments/:id` | Update |
| DELETE | `/api/segments/:id` | Delete |
| POST | `/api/segments/preview` | Preview count |
| POST | `/api/segments/:id/rebuild` | Rebuild |

#### Templates (4 endpoints)
| GET | `/api/templates` | List |
| POST | `/api/templates` | Create |
| PUT | `/api/templates/:id` | Update |
| DELETE | `/api/templates/:id` | Delete |

#### Mailboxes (25+ endpoints)
| Method | Path | Popis |
|---|---|---|
| GET | `/api/mailboxes` | List |
| POST | `/api/mailboxes` | Create |
| PATCH | `/api/mailboxes/:id` | Update |
| DELETE | `/api/mailboxes/:id` | Retire |
| GET | `/api/mailboxes/:id/stats` | Performance |
| GET | `/api/mailboxes/:id/send-log` | Recent sends |
| PATCH | `/api/mailboxes/:id/warmup` | Warmup config |
| POST | `/api/mailboxes/:id/warmup/start` | Start warmup |
| GET | `/api/mailboxes/:id/warmup-status` | Warmup state |
| GET | `/api/mailboxes/:id/smtp-check` | SMTP probe |
| GET | `/api/mailboxes/:id/imap-check` | IMAP probe |
| POST | `/api/mailboxes/:id/header-probe` | Header analysis |
| POST | `/api/mailboxes/:id/pipeline-test` | Full test send |
| GET | `/api/mailboxes/:id/pipeline-results` | Test results |
| GET | `/api/mailboxes/:id/full-check` | Comprehensive health |
| GET | `/api/mailboxes/:id/imap-inbox` | Inbox messages |
| POST | `/api/mailboxes/bulk-assign-proxy` | Batch proxy assign |
| POST | `/api/mailboxes/bulk-check` | Batch health check |
| POST | `/api/mailboxes/import-csv` | CSV import |
| GET | `/api/mailboxes/:id/proxy-live-check` | SOCKS5 probe |
| GET | `/api/mailboxes/:id/cooldown-log` | Cooldown history |
| GET | `/api/mailboxes/:id/send-rate` | Rate telemetry |
| GET | `/api/mailboxes/:id/bounce-status` | Bounce classification |
| GET | `/api/mailboxes/health-summary` | Aggregate health |
| GET | `/api/mailboxes/send-trends` | 24h trends |
| GET | `/api/mailboxes/:id/alerts` | Alerts |
| PATCH | `/api/mailboxes/:id/alerts/:alertId/resolve` | Resolve alert |
| POST | `/api/mailboxes/:id/send-test` | End-to-end test |

#### Replies & inbox (3 endpoints)
| GET | `/api/replies` | List (filter: handled, classification) |
| PATCH | `/api/replies/:id` | Mark handled |
| GET | `/api/replies/stats` | Summary counts |

#### Analytics (3 endpoints)
| GET | `/api/analytics/overview` | KPIs |
| GET | `/api/analytics/timeline` | Daily timeline |
| GET | `/api/analytics/campaigns` | Per-campaign metrics |

#### Contacts & suppression (5 endpoints)
| GET | `/api/contacts` | List + filter |
| PATCH | `/api/contacts/:id` | Update |
| GET | `/api/contacts/:id` | Detail + send history |
| POST | `/api/contacts/:id/verify-email` | Verify |
| GET/POST/DELETE | `/api/suppression` | CRUD |

#### Health & system (8 endpoints)
| GET | `/api/version` | Git SHA + build |
| GET | `/api/health/system` | DB, pool, watchdog |
| GET | `/api/health/guards` | Stale-guard state |
| GET | `/api/health/drift` | Config drift |
| GET | `/api/health/watchdog` | Watchdog events |
| GET | `/api/health/protections` | Readiness |
| GET | `/api/anti-trace/health` | Relay health |
| GET | `/api/proxy-pool` | Available proxies |

#### Protection (4 endpoints)
| GET | `/api/protections/matrix` | Layer × level results |
| GET | `/api/protections/trace/:messageId` | Per-send trace |
| GET | `/api/protections/alerts` | Open alerts |
| POST | `/api/protections/alerts/:id/ack` | Acknowledge |

#### Healing (2 endpoints)
| GET | `/api/healing/log` | Recovery event log |
| GET | `/api/healing/stats` | Recovery summary |

#### Categories (4 endpoints)
| GET | `/api/meta/categories` | List |
| GET | `/api/meta/categories/tree` | Tree structure |
| GET | `/api/meta/categories/search` | Search |
| GET | `/api/categories/:slug/companies` | Companies by category |

### 6.3 Response format

```json
// Success
{ "data": [...], "total": 100 }    // list
{ "campaign": {...}, "stats": {...}} // detail

// Error
{ "error": "message" }              // status 4xx/5xx
```

---

## 7. Background tasks

### 7.1 Go daemons

| Daemon | Interval | Popis |
|---|---|---|
| Campaign runner | 15 min | Process running campaigns, send emails |
| Watchdog | 5 min | Bounce decay, auth spike detection, circuit breaker |
| Intelligence | 1 hour | ARES sync, classify, promote Schema B→A |
| Protection probes | L2: 30-60s, L3: 15min | Health checks |

### 7.2 BFF cron engine (server.js)

| Task | Interval | Popis |
|---|---|---|
| Proxy refresh | 30 min | SOCKS5 pool from 3+ sources |
| Proxy probe | 5 min | Health check top-N proxies |
| Full mailbox check | 4 hours | SMTP/IMAP/config audit |
| IMAP poll | 15 min | Fetch unseen → classify → suppress |
| Warmup advance | Daily 05:00 | Auto-escalate warmup day |
| Daily report | Daily 07:00 | Operator email summary |
| Midnight reset | Daily 00:00 | Bounce escalation cooldown |
| Campaign watchdog | 60 min | Status sync + event log |
| Bounce flip | 15 min | bounced → unverified recovery |
| Greylisting retry | 10 min | Requeue greylisted domains |
| Email reverify | Daily 03:00 | Batch re-verification |
| Scoring recompute | 60 min | Stale-first batch (500/hour) |
| Facts MV refresh | 10 min | Materialized view sync |
| Enrichment worker | 30 sec | Data source processing |
| Adaptive refresh | 6 hours | Enqueue stale facts |
| Stale-guard | 60 sec | Check + auto-recover |
| Watchdog heartbeat | 60 sec | BFF alive signal |
| Mailbox auto-recover | 6 hours | Low-score recovery |
| Config drift | 5 min | Detect misconfigurations |

---

## 8. Business rules

### 8.1 Sending rules

| Rule | Detail |
|---|---|
| Business hours only | 08:00-17:00, weekdays, Europe/Prague |
| Gaussian delay | Mean 90s, stddev 45s between sends |
| Daily variation | ±15% |
| Max per domain per hour | 5 |
| Ramp-up pattern | Slow morning, peak 10-14, taper 17 |
| Micro-breaks | 5-15 min random pauses |
| Warmup | Day 1-3: 5/day → Day 22+: 100/day |
| Holding cluster | Max 1 send per parent_ico per tick |

### 8.2 Bounce handling

| Event | Action |
|---|---|
| Hard bounce (5xx) | Blacklist email + suppress globally + close thread + increment mailbox consecutive_bounces |
| Soft bounce (4xx) | Count accumulation |
| 2 soft bounces | Pause thread 7 days |
| 3 soft bounces | Mark email_status 'risky' |
| 5 soft bounces | Mark email_status 'invalid' |
| Complaint | Same as hard bounce |
| Mailbox 3 consecutive bounces | Auto-pause mailbox (bounce_hold) |
| Mailbox bounce_rate > 5% | Circuit breaker OPEN (2h cooldown) |
| Global bounce > 15% | STOP all sending |

### 8.3 Reply classification

| Classification | Action |
|---|---|
| positive/interested | Flag for manual follow-up, trigger onInterested, create lead |
| meeting | Same as positive + set next_action=manual_follow |
| negative | Close thread + suppress globally (permanent) |
| ooo | Pause thread 14 days |
| later | Pause thread 30 days |
| auto_reply | Ignore (no action) |
| objection | Flag for manual review |

### 8.4 Thread lifecycle

```
                 ┌──────────┐
                 │   NEW    │
                 └─────┬────┘
                       │ first send
                 ┌─────▼────┐
          ┌──────│  ACTIVE  │──────┐
          │      └─────┬────┘      │
     ooo/later    reply(neg)    completed
          │           │            │
    ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
    │  PAUSED  │ │COMPLETED │ │COMPLETED │
    │(14/30d)  │ │(suppress)│ │(no reply)│
    └─────┬────┘ └──────────┘ └──────────┘
          │ resume
    ┌─────▼────┐
    │  ACTIVE  │
    └──────────┘
```

### 8.5 Mailbox lifecycle

```
    ┌──────────┐
    │  ACTIVE  │
    └─────┬────┘
          │
    ┌─────┼──────────────┬─────────────┐
    │     │              │             │
  3 bounces  3 auth fails  manual pause  retired
    │     │              │             │
┌───▼────┐│        ┌─────▼────┐  ┌────▼─────┐
│BOUNCE_ ││        │  PAUSED  │  │ RETIRED  │
│HOLD    ││        └─────┬────┘  └──────────┘
└───┬────┘│              │
    │     │         manual resume
    │  watchdog          │
    │  decay (24h)  ┌────▼─────┐
    └──────────────→│  ACTIVE  │
                    └──────────┘
```

### 8.6 Campaign lifecycle

```
    ┌──────────┐
    │  DRAFT   │
    └─────┬────┘
          │ operator clicks "Spustit" + quality gate passes
    ┌─────▼────┐
    │ RUNNING  │←──── operator clicks "Obnovit"
    └─────┬────┘
          │
    ┌─────┼──────────────┐
    │     │              │
  operator  all contacts   global bounce
  pause     completed      >15%
    │     │              │
┌───▼────┐│        ┌─────▼────┐
│ PAUSED ││        │ COMPLETED│
└───┬────┘│        └──────────┘
    │     │
    └─────┘
```

### 8.7 Přílohy — pravidla

| Kontext | Pravidlo |
|---|---|
| Kampaňové emaily | NIKDY přílohy (deliverability risk) |
| Template editor | Block save pokud má attachment reference |
| Příchozí odpovědi | Parsovat MIME, uložit do attachments tabulky |
| Manuální reply | Max 3 přílohy, max 10 MB/soubor |
| Inline obrázky | Flag is_inline, preview v ThreadView |

### 8.8 Anti-trace

| Vrstva | Opatření |
|---|---|
| Headers | Strip X-Mailer, X-Originating-IP, X-Priority, List-Unsubscribe |
| Message-ID | Random format: random@domain (no platform fingerprint) |
| Header order | Randomized |
| Tracking pixel | Masked as img.customer-domain.cz/logo-podpis.png?v=TOKEN |
| Click redirect | Masked as info.customer-domain.cz/nabidka-2024?ref=TOKEN |
| Timing | Gaussian delay (mean 90s) — no machine-like patterns |
| Proxy | Per-send SOCKS5/HTTP rotation, geo-match CZ |

---

## 9. MVP roadmap — 28 milestones

### Konvence

Každý MVP:
- **Prerekvizity** — které MVP musí být hotové
- **RED** — testy napsat PRVNÍ (TDD)
- **GREEN** — minimální implementace aby testy prošly
- **REFACTOR** — cleanup
- **Exit criteria** — co musí platit aby byl MVP hotový

Effort: S = 2-4h, M = 4-8h, L = 8-16h

---

### FÁZE 0: Stabilizace

#### MVP-01: Fix failing tests [S]

**Prerekvizity:** žádné

**RED:** Testy už existují a failují.

**GREEN:**
- [ ] `src/pages/Mailboxes.components.test.jsx`: import `within`, fix filter select assertions
- [ ] `src/pages/Analytics.components.test.jsx`: `vi.stubGlobal('fetch')` fix (21/21 already passing)

**REFACTOR:**
- [ ] Doplnit chybějící MSW handlery (health-summary, send-trends, health/system, health/watchdog, health/drift)

**Exit criteria:** `pnpm test` — 0 failures.

---

#### MVP-02: Build clean + baseline [M]

**Prerekvizity:** MVP-01

**RED:**
- [ ] `vitest` coverage report: identify uncovered areas
- [ ] `pnpm build` must succeed

**GREEN:**
- [ ] Fix any TypeScript/lint errors blocking build
- [ ] Fix any import issues

**REFACTOR:**
- [ ] Remove `.stryker-tmp` if present
- [ ] Clean unused imports

**Exit criteria:** `pnpm build` clean. `pnpm test -- --coverage` generates report. Baseline coverage documented.

---

#### MVP-03: Smoke test + CI [M]

**Prerekvizity:** MVP-02

**RED:**
- [ ] `test/smoke.test.js`: health endpoints return 200
- [ ] `test/smoke.test.js`: BFF starts without crash

**GREEN:**
- [ ] Implement smoke test script hitting: /api/version, /api/health/system, /api/health/guards
- [ ] `.github/workflows/ci.yml` or pre-commit hook runs `pnpm test && pnpm build`

**REFACTOR:**
- [ ] Document CI pipeline in this plan

**Exit criteria:** Smoke test green. CI pipeline defined. `go test ./...` still passing.

---

### FÁZE 1: Campaign wizard

#### MVP-04: CampaignNew wizard — stepper skeleton [M]

**Prerekvizity:** MVP-01

**RED:**
- [ ] `src/pages/__tests__/CampaignNew.stepper.test.jsx`:
  - Renders 4-step indicator (Základní, Šablona, Segment, Sekvence)
  - Step 1 visible by default
  - "Další" advances to step 2
  - "Zpět" returns to step 1
  - Step indicator highlights current step
  - Cannot advance from step 1 without name (validation)

**GREEN:**
- [ ] `src/pages/CampaignNew.jsx` or refactor existing NewCampaignModal
- [ ] Step state management (currentStep, formData)
- [ ] Step 1: name (required) + description + category + match type
- [ ] Navigation: Zpět/Další buttons
- [ ] Validation: required fields per step

**REFACTOR:**
- [ ] Extract StepIndicator component

**Exit criteria:** Wizard opens from Campaigns page. Step 1 renders with validation. Navigation works.

---

#### MVP-05: CampaignNew — template picker [M]

**Prerekvizity:** MVP-04

**RED:**
- [ ] `src/pages/__tests__/CampaignNew.templates.test.jsx`:
  - Step 2 shows list of templates from store
  - Each template shows name + subject preview
  - Can select multiple templates (checkbox)
  - Cannot advance without at least 1 template selected
  - Selected templates carry to step 4

**GREEN:**
- [ ] Step 2 component: load templates from store
- [ ] Template list with checkboxes
- [ ] Selection state persisted across steps

**Exit criteria:** Step 2 shows templates. Selection works. Validation blocks empty selection.

---

#### MVP-06: CampaignNew — segment picker [M]

**Prerekvizity:** MVP-05

**RED:**
- [ ] `src/pages/__tests__/CampaignNew.segment.test.jsx`:
  - Step 3 shows dropdown of existing segments
  - Shows segment name + company count
  - "Preview" button shows count
  - Can alternatively build ad-hoc filter (QueryBuilder)
  - Cannot advance without segment or filter

**GREEN:**
- [ ] Step 3 component: segment dropdown + QueryBuilder fallback
- [ ] Preview count via POST `/api/segments/preview`

**Exit criteria:** Step 3 shows segments. Preview count works. Filter or segment required.

---

#### MVP-07: CampaignNew — sequence builder + submit [L]

**Prerekvizity:** MVP-06

**RED:**
- [ ] `src/pages/__tests__/CampaignNew.sequence.test.jsx`:
  - Step 4 shows selected templates in order
  - Can reorder (up/down arrows)
  - Each step has delay_days input (default 3)
  - "Vytvořit kampaň" submits POST /api/campaigns
  - On success: redirect to /campaigns/:id
  - Shows error toast on failure

**GREEN:**
- [ ] Step 4 component: ordered template list + delay inputs
- [ ] Submit handler: build sequence_config JSON, POST via store
- [ ] Redirect on success

**REFACTOR:**
- [ ] Clean up old NewCampaignModal if replaced

**Exit criteria:** Full 4-step wizard works end-to-end. Campaign created in DB. Redirect to detail.

---

#### MVP-08: Quality gate modal [L]

**Prerekvizity:** MVP-07

**RED:**
- [ ] `src/pages/__tests__/QualityGate.test.jsx`:
  - Modal opens when clicking "Spustit" on draft campaign
  - Shows email quality breakdown (valid/risky/catch-all/invalid/unverified)
  - Shows capacity info (active mailboxes, daily capacity, estimated days)
  - Shows DNS check (SPF/DKIM/DMARC)
  - "Spustit kampaň" calls POST /api/campaigns/:id/run
  - "Ověřit neověřené" calls batch verify endpoint
  - Warning banner when < 80% valid emails

**GREEN:**
- [ ] `src/components/QualityGateModal.jsx`
- [ ] Fetch: `/api/campaigns/:id/email-quality`, `/api/campaigns/:id/capacity`
- [ ] DNS check display
- [ ] Action buttons: cancel, verify, run

**Exit criteria:** Quality gate blocks launch until operator confirms. All data fetched and displayed.

---

### FÁZE 2: Campaign operations

#### MVP-09: Campaign run/pause wiring [M]

**Prerekvizity:** MVP-08

**RED:**
- [ ] `src/pages/__tests__/CampaignDetail.actions.test.jsx`:
  - "Spustit" button visible on draft/paused campaign
  - "Pozastavit" button visible on running campaign
  - Click "Spustit" → quality gate modal → confirm → campaign status changes to running
  - Click "Pozastavit" → confirm dialog → campaign status changes to paused
  - Status badge updates immediately (optimistic)
  - Toast notification on success

**GREEN:**
- [ ] Wire existing campaign run/pause buttons to store actions
- [ ] Optimistic UI update
- [ ] Toast feedback

**Exit criteria:** Operator can start and pause campaigns from CampaignDetail.

---

#### MVP-10: CampaignDetail live KPIs [M]

**Prerekvizity:** MVP-09

**RED:**
- [ ] `src/pages/__tests__/CampaignDetail.kpis.test.jsx`:
  - KPI cells show correct values from API
  - Auto-refresh every 30s while campaign is running
  - Funnel visualization renders with correct proportions
  - Send table shows recent sends with status

**GREEN:**
- [ ] Polling mechanism (setInterval 30s when status=running)
- [ ] Funnel bar widths calculated from data
- [ ] Send table pagination

**Exit criteria:** KPIs update live. Funnel accurate. Sends table paginated.

---

#### MVP-11: Campaign E2E test [M]

**Prerekvizity:** MVP-10

**RED:**
- [ ] `test/e2e/campaign-lifecycle.spec.ts` (Playwright):
  - Navigate to /campaigns
  - Click "Nová kampaň"
  - Complete 4-step wizard
  - Arrive at CampaignDetail
  - Click "Spustit" → quality gate → confirm
  - Verify campaign is running
  - Click "Pozastavit" → confirm
  - Verify campaign is paused

**GREEN:**
- [ ] E2E test with MSW or seeded test data

**Exit criteria:** E2E test green. Full campaign lifecycle verified.

---

### FÁZE 3: DNS & Preflight

#### MVP-12: DNS audit panel [M]

**Prerekvizity:** MVP-01

**RED:**
- [ ] `src/pages/__tests__/DnsAuditPanel.test.jsx`:
  - Panel renders in Mailboxes page or as standalone section
  - Shows SPF/DKIM/DMARC status for each sending domain
  - Pass = green checkmark, Fail = red X
  - "Refresh" button re-fetches
- [ ] `modules/outreach/internal/dns/audit_test.go`:
  - DNS probe returns correct SPF/DKIM/DMARC results

**GREEN:**
- [ ] `src/components/DnsAuditPanel.jsx`
- [ ] Go: `/api/dns-audit` endpoint (or enhance existing)
- [ ] BFF proxy route

**Exit criteria:** DNS audit visible. SPF/DKIM/DMARC checked per domain.

---

#### MVP-13: Preflight gate [M]

**Prerekvizity:** MVP-12, MVP-08

**RED:**
- [ ] `modules/outreach/internal/campaign/preflight_test.go`:
  - Preflight checks: DNS pass, active mailboxes > 0, segment non-empty, template valid
  - Returns list of pass/fail checks
  - Campaign cannot transition to running if any check fails
- [ ] `src/pages/__tests__/QualityGate.preflight.test.jsx`:
  - Preflight section in quality gate modal
  - Red/green indicators per check
  - "Spustit" disabled if any check fails

**GREEN:**
- [ ] Go: `preflight.go` — check functions
- [ ] Integrate into quality gate modal

**Exit criteria:** Campaign cannot launch without passing DNS + mailbox + segment + template checks.

---

### FÁZE 4: Inbox & threading

#### MVP-14: Inbox page enhancements [L]

**Prerekvizity:** MVP-01

**RED:**
- [ ] `src/pages/__tests__/Inbox.test.jsx`:
  - Renders thread list with columns: Contact, Subject, Campaign, Classification, Time
  - Tabs: Vše, Nezpracované, Zájem, Odmítnutí, Auto-reply
  - Tab counts from /api/replies/stats
  - Switching tab filters results
  - Search input filters by contact/subject
  - Pagination with "Načíst další"
  - Unhandled rows have highlighted background

**GREEN:**
- [ ] Enhance existing `Inbox.jsx` or `Replies.jsx`
- [ ] Tab state management
- [ ] Search with debounce
- [ ] Pagination (offset-based, 30/page)

**Exit criteria:** Inbox functional with tabs, search, pagination.

---

#### MVP-15: Reply slide-over enhancement [M]

**Prerekvizity:** MVP-14

**RED:**
- [ ] `src/pages/__tests__/ReplySlideOver.test.jsx`:
  - Clicking row opens slide-over (302px, right)
  - Shows: contact name, email, classification, subject, campaign
  - "Handled" button marks as handled
  - "→ Vlákno" link navigates to /replies/:id
  - Close button closes slide-over

**GREEN:**
- [ ] Enhance existing slide-over in Replies.jsx
- [ ] Add "→ Vlákno" navigation link

**Exit criteria:** Slide-over shows summary. Navigation to ThreadDetail works.

---

#### MVP-16: Nav badge [S]

**Prerekvizity:** MVP-14

**RED:**
- [ ] `src/components/__tests__/NavBadge.test.jsx`:
  - Badge shows unhandled reply count next to "Odpovědi" in sidebar
  - Count updates on store.reloadReplyStats()
  - Badge hidden when count = 0
  - Badge red background, white text

**GREEN:**
- [ ] Add badge to sidebar nav item for Odpovědi
- [ ] Source: `replyStats.unhandled` from store

**Exit criteria:** Badge visible with correct count. Updates on navigation.

---

### FÁZE 5: ThreadView přestavba

#### MVP-17: ThreadView — chronological timeline [L]

**Prerekvizity:** MVP-15

**RED:**
- [ ] `src/pages/__tests__/ThreadView.timeline.test.jsx`:
  - Page loads for /replies/:id
  - Shows header: contact email, campaign name, classification badge
  - Renders messages chronologically (oldest first)
  - Auto-sends (campaign steps) styled differently: gray bg, smaller font
  - Incoming replies: white bg, colored left border (green=positive, red=negative)
  - Manual replies: light indigo bg
  - Each message shows: sender label, timestamp, body text
  - Back button navigates to /replies

**GREEN:**
- [ ] Refactor existing `ThreadDetail.jsx` → full timeline view
- [ ] New API needed: `GET /api/threads/:id/messages` or enhance existing `/api/replies/:id`
  - Must return: campaign send_events + incoming replies + manual replies, sorted by timestamp
- [ ] BFF proxy route
- [ ] Message components: AutoSendBubble, IncomingBubble, OutgoingBubble

**Exit criteria:** ThreadView shows full conversation history. Visual distinction between message types.

---

#### MVP-18: ThreadView — incoming attachments [M]

**Prerekvizity:** MVP-17

**RED:**
- [ ] `src/pages/__tests__/ThreadView.attachments.test.jsx`:
  - Incoming reply with attachments shows attachment list
  - Each attachment: filename, size (human-readable), MIME icon
  - "Stáhnout" button triggers download
  - Inline images preview (img tag, max-width 300px)
- [ ] `modules/outreach/internal/thread/mime_test.go`:
  - IMAP MIME parser extracts text/plain body
  - Extracts attachments (filename, content_type, size, data)
  - Handles multipart/mixed, multipart/alternative
  - Rejects files > 10 MB

**GREEN:**
- [ ] Go: MIME parser in thread/ or imap/ package
- [ ] Migration 046: attachments table
- [ ] API: include attachments in thread messages response
- [ ] React: AttachmentRow component (icon + name + size + download)
- [ ] Download endpoint: `GET /api/attachments/:id/download`

**Exit criteria:** Incoming attachments visible in thread. Download works. Images preview inline.

---

#### MVP-19: ThreadView — contact context sidebar [M]

**Prerekvizity:** MVP-17

**RED:**
- [ ] `src/pages/__tests__/ThreadView.context.test.jsx`:
  - Right sidebar (30% width) shows contact info
  - Firma: name, IČO, sector, region
  - Kampaň: name, status, sent count, replied count
  - Klasifikace: badge
  - Kontaktováno: X× (step count + reply count)
  - "Handled" toggle button

**GREEN:**
- [ ] Context sidebar component
- [ ] Fetch company data by ICO from contact
- [ ] Campaign stats from API

**Exit criteria:** Context sidebar renders with correct data. 70/30 split layout.

---

### FÁZE 6: Manual reply

#### MVP-20: Reply compose textarea [M]

**Prerekvizity:** MVP-17

**RED:**
- [ ] `src/pages/__tests__/ThreadView.compose.test.jsx`:
  - Reply compose area at bottom of conversation
  - Textarea with placeholder "Napište odpověď..."
  - "Odeslat" button
  - Button disabled when textarea empty
  - Sending state: button shows spinner, textarea disabled

**GREEN:**
- [ ] Reply compose component in ThreadView
- [ ] Local state: body, sending, sent

**Exit criteria:** Compose area renders. Button states correct.

---

#### MVP-21: Go reply endpoint [L]

**Prerekvizity:** MVP-20

**RED:**
- [ ] `modules/outreach/internal/thread/reply_test.go`:
  - POST /api/threads/:id/reply accepts {body}
  - Loads thread, finds original reply
  - Selects mailbox (same as last campaign send for this thread)
  - Builds MIME message with correct headers
  - In-Reply-To: last inbound message's Message-ID
  - References: chain of Message-IDs
  - Message-ID: random@sending-domain
  - Sends via SMTP
  - Creates send_event with message_type=manual_reply
  - Creates outreach_message with direction=outbound
  - Auto-marks thread as handled
  - Skips warmup/rate-limit/delay (manual = immediate)
  - Applies anti-trace header sanitization
- [ ] BFF contract test: `test/contract/replies.test.js`

**GREEN:**
- [ ] Go: `POST /api/threads/:id/reply` handler
- [ ] SMTP send function with threading headers
- [ ] Migration 047: send_events.message_type column
- [ ] BFF proxy route

**REFACTOR:**
- [ ] Share SMTP connection logic with sender package

**Exit criteria:** Manual reply sends real email with correct threading headers. Appears in thread.

---

#### MVP-22: Reply threading headers [M]

**Prerekvizity:** MVP-21

**RED:**
- [ ] `modules/outreach/internal/thread/headers_test.go`:
  - In-Reply-To correctly set to last inbound Message-ID
  - References contains full chain
  - Reply threads correctly in Gmail (subject preserved, In-Reply-To matches)
  - Reply threads correctly in Outlook (References chain)
  - Subject prefixed with "Re: " if not already
  - Anti-trace: no platform identifiers in headers

**GREEN:**
- [ ] Header builder function
- [ ] Test with real Message-IDs

**Exit criteria:** Email clients show reply in same thread as original campaign email.

---

#### MVP-23: Reply attachments [L]

**Prerekvizity:** MVP-21, MVP-18

**RED:**
- [ ] `src/pages/__tests__/ThreadView.upload.test.jsx`:
  - File dropzone below textarea ("Přiložit soubor")
  - Max 3 files indicator
  - Max 10 MB per file indicator
  - Shows attached files: name + size + remove button
  - Rejects files > 10 MB (error toast)
  - Rejects when > 3 files already attached
  - "Odeslat" includes files in request
- [ ] `modules/outreach/internal/thread/reply_attachment_test.go`:
  - POST /api/threads/:id/reply accepts multipart/form-data
  - Body + up to 3 files
  - Files stored in attachments table
  - MIME message built with multipart/mixed
  - File size validated server-side

**GREEN:**
- [ ] React: FileDropzone component
- [ ] Multipart upload handling
- [ ] Go: multipart request parsing
- [ ] MIME builder with attachment parts
- [ ] Store in attachments table

**Exit criteria:** Operator can attach files to reply. Files visible in thread after send.

---

### FÁZE 7: Lead management

#### MVP-24: Lead auto-marking [M]

**Prerekvizity:** MVP-17

**RED:**
- [ ] `modules/outreach/internal/lead/store_test.go`:
  - On positive/interested/meeting reply → auto-create lead
  - Lead: contact_id, campaign_id, status=new, source=reply_classification
  - Idempotent: same (contact_id, campaign_id) → no duplicate
  - Lead has notes field (auto-filled from reply subject)
- [ ] `modules/outreach/internal/thread/inbound_test.go` (extend):
  - After classifying as positive → calls lead.Create()

**GREEN:**
- [ ] Go: lead/store.go with Create(), List(), Update()
- [ ] Migration 044: leads table (may already exist)
- [ ] Wire into reply classification pipeline

**Exit criteria:** Positive replies auto-create leads. No duplicates.

---

#### MVP-25: Lead list UI [M]

**Prerekvizity:** MVP-24

**RED:**
- [ ] `src/pages/__tests__/Leads.test.jsx`:
  - Page at /leads (new route)
  - Shows lead list: contact, campaign, status, source, created_at
  - Status options: new, contacted, qualified, won, lost
  - Can change status (dropdown)
  - Filter by status
  - Nav badge for "new" leads

**GREEN:**
- [ ] `src/pages/Leads.jsx`
- [ ] Add to router: `/leads`
- [ ] Add to sidebar nav (under "Data" section)
- [ ] API: `GET /api/leads`, `PATCH /api/leads/:id`
- [ ] BFF endpoints

**Exit criteria:** Lead list page works. Status changes persist. Badge shows new lead count.

---

### FÁZE 8: Analytics enhancement

#### MVP-26: Analytics date ranges + export [M]

**Prerekvizity:** MVP-01

**RED:**
- [ ] `src/pages/__tests__/Analytics.daterange.test.jsx`:
  - Date range buttons: 7d, 14d, 30d, 90d
  - Custom date picker (from/to)
  - Export button downloads CSV
  - Chart updates when range changes
  - KPIs update for selected range

**GREEN:**
- [ ] Add 90d button + custom date picker
- [ ] Export: generate CSV from timeline data (client-side)
- [ ] Update API calls with date params

**Exit criteria:** Custom date ranges work. CSV export downloads.

---

#### MVP-27: Campaign comparison [M]

**Prerekvizity:** MVP-26

**RED:**
- [ ] `src/pages/__tests__/Analytics.comparison.test.jsx`:
  - Campaign table sortable by: sent, replied, opened, bounced
  - Click on campaign → navigate to /campaigns/:id
  - Reply rate column with color coding (green > 5%, yellow 2-5%, red < 2%)
  - "Best performing" highlight on top campaign

**GREEN:**
- [ ] Sortable campaign table
- [ ] Color-coded rate columns
- [ ] Click navigation

**Exit criteria:** Campaign table sortable. Visual hierarchy clear.

---

### FÁZE 9: Intelligence

#### MVP-28: Best time to send [L]

**Prerekvizity:** MVP-10

**RED:**
- [ ] `modules/outreach/internal/intelligence/timing_test.go`:
  - Analyzes tracking_events (opens) by hour × day_of_week
  - Aggregates per recipient domain
  - Returns recommended sending window
  - Default fallback: 9-14 business hours if insufficient data
- [ ] `src/pages/__tests__/CampaignDetail.timing.test.jsx`:
  - Shows "Doporučený čas odesílání" section
  - Heatmap: hours × days (color intensity = open rate)

**GREEN:**
- [ ] Go: intelligence/timing.go
- [ ] API: `GET /api/campaigns/:id/best-time`
- [ ] React: TimingHeatmap component

**Exit criteria:** Heatmap renders with real data. Recommendation influences send window.

---

#### MVP-29: Template ranking [M]

**Prerekvizity:** MVP-10

**RED:**
- [ ] `modules/outreach/internal/intelligence/ranking_test.go`:
  - Ranks templates by reply rate across campaigns
  - Returns: template_id, name, campaigns_used, total_sent, reply_rate, open_rate
  - Sorted by reply_rate descending
- [ ] `src/pages/__tests__/Templates.ranking.test.jsx`:
  - Templates page shows performance column
  - Rank badge (🥇🥈🥉) on top 3

**GREEN:**
- [ ] Go: intelligence/ranking.go
- [ ] API: `GET /api/templates/ranking`
- [ ] React: ranking display in Templates page

**Exit criteria:** Template ranking computed from real data. Visible in UI.

---

#### MVP-30: A/B subject testing [L]

**Prerekvizity:** MVP-29

**RED:**
- [ ] `modules/outreach/internal/campaign/ab_test.go`:
  - Campaign can have 2 subject variants per step
  - 50/50 split at send time
  - After N sends (configurable, default 50), auto-select winner
  - Winner determined by open rate
- [ ] `src/pages/__tests__/CampaignNew.ab.test.jsx`:
  - Step 2 (template picker) shows "A/B test" toggle
  - When enabled: second subject input appears
  - Preview shows both variants

**GREEN:**
- [ ] Go: A/B split logic in sender
- [ ] sequence_config extended: `{step, delay_days, template, subject_b?}`
- [ ] Auto-winner selection after threshold

**Exit criteria:** A/B test runs. Winner auto-selected. Results visible in CampaignDetail.

---

### FÁZE 10: Hardening

#### MVP-31: BFF authentication [M]

**Prerekvizity:** MVP-03

**RED:**
- [ ] `test/contract/auth.test.js`:
  - Requests without valid API key return 401
  - Requests with valid key return 200
  - Key read from OUTREACH_API_KEY env var
  - Health endpoints exempt from auth

**GREEN:**
- [ ] Auth middleware in server.js
- [ ] Validate X-API-Key header on all /api/* routes (except health)
- [ ] React: include key in requests (or session-based auth)

**Exit criteria:** BFF endpoints protected. Unauthorized requests rejected.

---

#### MVP-32: Error handling standardization [M]

**Prerekvizity:** MVP-31

**RED:**
- [ ] `test/contract/errors.test.js`:
  - 400 for invalid input (missing required fields)
  - 404 for non-existent resources
  - 409 for conflicts (duplicate)
  - 500 for server errors (with generic message, no stack trace)
  - All errors return `{ error: "message", code: "ERROR_CODE" }`

**GREEN:**
- [ ] Error middleware in server.js
- [ ] Standardized error response format
- [ ] HTTP status code differentiation

**Exit criteria:** Consistent error responses across all endpoints.

---

#### MVP-33: Performance optimization [L]

**Prerekvizity:** MVP-02

**RED:**
- [ ] `test/performance/bundle.test.js`:
  - JS bundle < 300kb gzipped
  - CSS < 50kb
  - Initial load < 2s (Lighthouse)
- [ ] `modules/outreach/internal/db/query_test.go`:
  - Critical queries have EXPLAIN ANALYZE plans
  - No N+1 patterns in hot paths

**GREEN:**
- [ ] Code splitting for heavy pages
- [ ] Index optimization for hot queries
- [ ] Connection pool tuning

**Exit criteria:** Bundle within budget. Queries optimized. No N+1.

---

#### MVP-34: Security audit [L]

**Prerekvizity:** MVP-31

**RED:**
- [ ] Security checklist (manual + automated):
  - [ ] No hardcoded secrets in code
  - [ ] TLS cert validation enabled (fix `rejectUnauthorized: false`)
  - [ ] CSP headers configured
  - [ ] CSRF protection on state-changing endpoints
  - [ ] Rate limiting on public endpoints
  - [ ] Input validation on all user inputs
  - [ ] SQL injection prevention (parameterized queries)
  - [ ] XSS prevention (no dangerouslySetInnerHTML)
  - [ ] FAULT_INJECT_ALLOWED disabled in production
  - [ ] Dependency audit: `pnpm audit`, `govulncheck`

**GREEN:**
- [ ] Fix all CRITICAL and HIGH findings
- [ ] Enable TLS validation
- [ ] Disable fault injection in prod

**Exit criteria:** Security audit passes. No CRITICAL findings.

---

#### MVP-35: Production readiness [L]

**Prerekvizity:** MVP-33, MVP-34

**RED:**
- [ ] Production checklist:
  - [ ] All tests green (Go + React + E2E)
  - [ ] Coverage ≥ 80% React, ≥ 85% Go business logic
  - [ ] Build clean
  - [ ] Security audit passed
  - [ ] Anti-trace audit passed (9 checks)
  - [ ] Smoke test script works
  - [ ] Runbooks documented
  - [ ] ENV vars documented
  - [ ] Backup procedure tested
  - [ ] Monitoring configured

**GREEN:**
- [ ] Fix any remaining issues
- [ ] Deploy to Railway
- [ ] Run smoke tests against production
- [ ] Verify health endpoints

**Exit criteria:** Platform live. Operator can log in, create campaign, receive replies.

---

### MVP dependency graph

```
MVP-01 ─→ MVP-02 ─→ MVP-03 ─→ MVP-31 ─→ MVP-32 ─→ MVP-34 ─→ MVP-35
  │         │                                          ↑
  │         └─→ MVP-33 ────────────────────────────────┘
  │
  ├─→ MVP-04 ─→ MVP-05 ─→ MVP-06 ─→ MVP-07 ─→ MVP-08 ─→ MVP-09 ─→ MVP-10 ─→ MVP-11
  │                                                                      │
  │                                                                      ├─→ MVP-28
  │                                                                      └─→ MVP-29 ─→ MVP-30
  │
  ├─→ MVP-12 ─→ MVP-13 (connects to MVP-08)
  │
  ├─→ MVP-14 ─→ MVP-15 ─→ MVP-17 ─→ MVP-18 ─→ MVP-23
  │              │          │          ↑
  │              │          ├─→ MVP-19 │
  │              │          │          │
  │              └─→ MVP-16 ├─→ MVP-20 ─→ MVP-21 ─→ MVP-22
  │                         │
  │                         └─→ MVP-24 ─→ MVP-25
  │
  └─→ MVP-26 ─→ MVP-27
```

### Timeline estimate

| Fáze | MVPs | Effort | Kumulativně |
|---|---|---|---|
| 0. Stabilizace | 01-03 | ~2 dny | 2 dny |
| 1. Campaign wizard | 04-08 | ~5 dní | 7 dní |
| 2. Campaign ops | 09-11 | ~3 dny | 10 dní |
| 3. DNS & Preflight | 12-13 | ~2 dny | 12 dní |
| 4. Inbox & threading | 14-16 | ~3 dny | 15 dní |
| 5. ThreadView | 17-19 | ~4 dny | 19 dní |
| 6. Manual reply | 20-23 | ~5 dní | 24 dní |
| 7. Leads | 24-25 | ~2 dny | 26 dní |
| 8. Analytics | 26-27 | ~2 dny | 28 dní |
| 9. Intelligence | 28-30 | ~4 dny | 32 dní |
| 10. Hardening | 31-35 | ~5 dní | 37 dní |

Operátor produktivní od MVP-21 (~24 dní): může spouštět kampaně a odpovídat na reply.
Plná platforma po MVP-35 (~37 dní).

---

## 10. TDD metodika

### Cyklus pro každý MVP

```
1. RED   — Napsat testy PRVNÍ. Testy MUSÍ FAILOVAT.
           Spustit: pnpm test / go test ./...
           Ověřit: testy červené.

2. GREEN — Napsat MINIMÁLNÍ implementaci.
           Žádné optimalizace, žádný refactor.
           Spustit testy: musí projít.

3. REFACTOR — Vyčistit kód.
              Testy stále procházejí.
              Extract components, remove duplication.
              Coverage check.
```

### Pravidla

1. **Nikdy nepsat implementaci bez testu.** Test first, always.
2. **Jeden RED-GREEN-REFACTOR cyklus per feature.** Ne per MVP.
3. **Testy opravovat jen pokud jsou špatně napsané.** Jinak opravit implementaci.
4. **Coverage gate:** React ≥ 80%, Go business logic ≥ 85%, BFF contract ≥ 75%.
5. **E2E test per user story.** US-01 → campaign-lifecycle.spec.ts, atd.

### Test file naming

| Vrstva | Pattern | Příklad |
|---|---|---|
| Go unit | `*_test.go` ve stejném package | `store_test.go` |
| React component | `__tests__/Component.test.jsx` | `__tests__/CampaignNew.stepper.test.jsx` |
| BFF contract | `test/contract/*.test.js` | `test/contract/replies.test.js` |
| E2E | `test/e2e/*.spec.ts` | `test/e2e/campaign-lifecycle.spec.ts` |

---

## 11. Testing strategie

### Pyramida

```
        ╱╲
       ╱E2E╲         5-10%   Playwright, kritické user flows
      ╱──────╲
     ╱Contract╲      10-15%  BFF endpoint tests
    ╱──────────╲
   ╱Integration ╲    15-20%  Go: DB + multi-package
  ╱──────────────╲
 ╱     Unit       ╲  60-70%  Go functions, React components
╱──────────────────╲
```

### Coverage targets

| Layer | Target | Tool |
|---|---|---|
| Go business logic | ≥ 85% | `go test -coverprofile` |
| Go handlers | ≥ 70% | `go test -coverprofile` |
| Go utilities | ≥ 90% | `go test -coverprofile` |
| React pages | ≥ 80% | `vitest --coverage` |
| React components | ≥ 80% | `vitest --coverage` |
| BFF contract | ≥ 75% | `vitest --coverage` |
| E2E user stories | 100% | Playwright |

### E2E test suite (Playwright)

| Tier | Test | MVP |
|---|---|---|
| 1 | Campaign lifecycle: create → run → pause → resume | 11 |
| 1 | Inbox: open → filter → thread → handled | 17 |
| 1 | Reply: thread → compose → send → verify in thread | 21 |
| 2 | Mailbox: add → warmup → SMTP check → pipeline test | 03 |
| 2 | Segment: create filter → preview → save → use in campaign | 06 |
| 3 | Template: create → preview → use in campaign | 05 |
| 3 | Analytics: date range → export CSV | 26 |
| 4 | A/B test: create → run → auto-winner | 30 |

### Anti-trace audit (9 checks)

1. Raw email source contains zero platform identifiers
2. No X-Mailer, X-Originating-IP, X-Priority headers
3. Tracking pixel URL looks like customer domain asset
4. Click redirect URL looks like customer content page
5. `nslookup` customer domains → CNAME to relay, not platform
6. WHOIS on relay domain → no platform info
7. 10 emails: no consistent header pattern across sends
8. mail-tester.com score ≥ 9/10
9. Message-ID format: random@sending-domain (no platform tag)

---

## 12. Security

### Autentizace

| Vrstva | Mechanismus |
|---|---|
| Go backend | X-API-Key header (env: OUTREACH_API_KEY) |
| BFF | Zatím žádná auth (⚠ MVP-31) |
| Dashboard | VPN/IP whitelist (network-level) |

### Známé security issues (fix in MVP-34)

1. **BFF nemá autentizaci** — všechny endpointy přístupné bez klíče
2. **TLS cert validation vypnutá** — `rejectUnauthorized: false` v SMTP/IMAP probes
3. **FAULT_INJECT_ALLOWED** — chaos engineering endpoint nesmí být v produkci
4. **Všechny errory = 500** — žádná diferenciace, potenciální information leakage

### Security headers (server.js)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

### Secret management

Secrets ONLY in env vars: `OUTREACH_API_KEY`, `DATABASE_URL`, `MAILBOX_N_PASSWORD`, `ANTI_TRACE_TOKEN`.
Validated at startup. Never logged. Never in git.

---

## 13. Deployment & infra

### Railway topology

```
┌─ Railway Project ────────────────────────────────────┐
│                                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │ Go backend  │  │ Express BFF │  │ Anti-trace   │ │
│  │ :8080       │  │ :3100       │  │ relay :8090  │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────────┘ │
│         │                │                            │
│         └────────┬───────┘                            │
│                  │                                    │
│         ┌────────▼────────┐                           │
│         │   PostgreSQL    │                           │
│         │   (managed)     │                           │
│         └─────────────────┘                           │
│                                                       │
│  React SPA (Vite build) → served by BFF              │
└───────────────────────────────────────────────────────┘
```

### Environment variables (complete)

#### Database
- `DATABASE_URL` — PostgreSQL connection string
- `DB_SSL_MODE` — disable (dev), require (prod)

#### API
- `OUTREACH_API_KEY` — shared secret Go ↔ BFF
- `GO_SERVER_URL` — Go backend URL (default http://localhost:8080)
- `PORT` — BFF port (default 3100)
- `CORS_ORIGIN` — Vite dev origin (default http://localhost:5175)

#### Mailboxes (per mailbox, N=1,2,3...)
- `MAILBOX_N_ADDRESS`, `MAILBOX_N_SMTP_HOST`, `MAILBOX_N_SMTP_PORT`
- `MAILBOX_N_USERNAME`, `MAILBOX_N_PASSWORD`
- `MAILBOX_N_IMAP_HOST`, `MAILBOX_N_IMAP_PORT`
- `MAILBOX_N_DAILY_LIMIT`, `MAILBOX_N_WARMUP_DAY`
- `MAILBOX_N_PROXY_URL`
- `MAILBOX_N_PERSONA_{NAME,ROLE,COMPANY,PHONE,EMAIL,WEBSITE,REGION}`

#### Sending
- `SENDING_WINDOW_START` (8), `SENDING_WINDOW_END` (17)
- `SENDING_TIMEZONE` (Europe/Prague)
- `SENDING_MIN_DELAY_SECONDS` (45), `SENDING_MAX_DELAY_SECONDS` (180)
- `SENDING_MAX_PER_DOMAIN_HOUR` (5)

#### Safety
- `SAFETY_MAX_BOUNCE_RATE` (0.05), `SAFETY_MAX_COMPLAINTS_24H` (1)

#### Tracking
- `TRACKING_BASE_URL` — relay URL for pixels/clicks

#### Anti-trace
- `ANTI_TRACE_URL`, `ANTI_TRACE_TOKEN`, `ANTI_TRACE_FROM`
- `ANTI_TRACE_RELAY_URL`, `ANTI_TRACE_RELAY_TOKEN`

#### Daemons
- `INTEL_INTERVAL` (1h), `CAMPAIGN_INTERVAL` (15min), `WATCHDOG_INTERVAL` (5min)
- `DISABLE_WATCHDOG`, `DISABLE_CAMPAIGN_DAEMON`, `DISABLE_PROTECTION_PROBES`

#### LLM
- `OLLAMA_URL`, `OLLAMA_MODEL` (gemma2:2b)

#### Other
- `FIRMY_DSN` — Czech registry DB
- `SENDING_DOMAINS` — for DNS probes
- `TARGET_INDUSTRIES`
- `SKIP_CALENDAR_CHECK` — CI testing only
- `BFF_IMPORT_ONLY` — disable cron engine (testing)
- `FAULT_INJECT_ALLOWED` — NEVER in production

### Backup strategy

| Co | Jak | Frekvence |
|---|---|---|
| PostgreSQL | Railway daily snapshots, 7-day PITR | Auto |
| Suppression list | Separate CSV export, GPG encrypted | Denně |
| Config | In env vars (Railway) | N/A |

### Rollback

```bash
railway rollback    # < 5 min
```

Decision criteria: smoke test fails on 3+ endpoints, or error rate > 5%.

---

## 14. Metriky úspěchu

### Business KPIs

| Metrika | Target (MVP-21+) | Měření |
|---|---|---|
| Reply rate | > 3% | total_replied / total_sent |
| Open rate | > 25% | tracking_events(open) / total_sent |
| Bounce rate | < 5% | bounce_events / total_sent |
| Unsubscribe rate | < 1% | unsubscribes / total_sent |
| Lead conversion | > 1% | leads(positive) / total_sent |
| Inbox zero time | < 4h | avg time from reply to handled |

### Technical KPIs

| Metrika | Target | Měření |
|---|---|---|
| Uptime | > 99.5% | health endpoint monitoring |
| Build time | < 60s | CI pipeline |
| Test suite | < 120s | `pnpm test` + `go test ./...` |
| Bundle size | < 300kb gzipped | vite build |
| P95 API latency | < 200ms | health endpoint |

### Per-MVP success

Každý MVP je "done" když:
1. Všechny RED testy prošly (GREEN)
2. Refactor complete
3. Coverage gate splněn
4. Exit criteria z MVP definice splněna
5. `pnpm build` clean
6. `pnpm test` a `go test ./...` clean (zero regressions)

---

## 15. Rizika & mitigace

| # | Riziko | Prob. | Impact | Mitigace |
|---|---|---|---|---|
| 1 | SMTP deliverability degradation | Medium | High | Warmup, proxy rotation, content quality, monitoring |
| 2 | IP/doména blacklisting | Low | Critical | Proactive monitoring, quick rotation, multiple domains |
| 3 | DB data loss | Low | Critical | Railway PITR + daily backup + suppression export |
| 4 | Anti-trace relay SPOF | Medium | Medium | Fallback direct SMTP, health check, auto-recovery |
| 5 | Node 25 / MSW incompatibility | Medium | Low | vi.stubGlobal workaround, pin MSW version |
| 6 | Timeline slippage | Medium | Medium | Small MVPs, priority review, scope cut |
| 7 | Operator error (wrong campaign) | Medium | Medium | Quality gate, confirmation dialogs, undo where possible |
| 8 | Secret exposure | Low | Critical | Env vars only, rotation procedure, git audit |
| 9 | BFF server.js too large (5559 lines) | High | Medium | Refactor into route modules when touching |
| 10 | Dual schema (A/B) confusion | Medium | Medium | Document clearly, promote B→A gradually |

---

## Appendix A: Existing page inventory

| Page | Route | Status | MVP |
|---|---|---|---|
| Dashboard | `/` | ✅ Complete | — |
| Replies | `/replies` | ✅ Works, enhance | 14-16 |
| ThreadDetail | `/replies/:id` | ✅ Basic, rebuild | 17-23 |
| Campaigns | `/campaigns` | ✅ Complete | — |
| CampaignDetail | `/campaigns/:id` | ✅ Complete, enhance | 09-10 |
| CampaignNew | modal | 🔨 Incomplete | 04-07 |
| Companies | `/companies` | ✅ Complete | — |
| Contacts | `/contacts` | ✅ Complete | — |
| Segments | `/segments` | ✅ Complete | — |
| Mailboxes | `/mailboxes` | ✅ Complete | — |
| Templates | `/templates` | ✅ Complete | — |
| Analytics | `/analytics` | ✅ Complete, enhance | 26-27 |
| Scoring | `/scoring` | ✅ Complete | — |
| Watchdog | `/watchdog` | ✅ Complete | — |
| Leads | `/leads` | ❌ New | 25 |
| QualityGate | modal | ❌ New | 08 |
| DnsAudit | panel | ❌ New | 12 |

## Appendix B: Zustand store state

```javascript
{
  // Collections
  mailboxes: [],          // GET /api/mailboxes
  campaigns: [],          // GET /api/campaigns
  templates: [],          // GET /api/templates
  segments: [],           // GET /api/segments
  companies: [],          // GET /api/companies
  totalCompanies: 0,      // GET /api/companies/stats

  // Stats
  replyStats: null,       // GET /api/replies/stats
  loading: false,

  // Actions (22 total)
  loadAll(),
  reloadReplyStats(),
  reloadMailboxes(),
  addMailbox(data), updateMailbox(id, data), deleteMailbox(id),
  addCampaign(data), loadCampaign(id), setCampaignStatus(id, status), deleteCampaign(id),
  addTemplate(data), updateTemplate(id, data), deleteTemplate(id),
  addSegment(data), updateSegment(id, data), rebuildSegment(id), deleteSegment(id),
}
```

## Appendix C: Glossary

| Pojem | Definice |
|---|---|
| BFF | Backend For Frontend — Express server proxying to Go |
| Thread | Konverzace = (campaign_id, contact_id), chronologický seznam zpráv |
| Warmup | Postupné navyšování denního limitu nové schránky (5→100 za 22 dní) |
| Circuit breaker | Auto-stop sending na mailbox/doménu při high bounce rate |
| Holding cluster | Ochrana proti burst sendu na parent_ico (max 1 per tick) |
| Quality gate | Modal s pre-launch checks (email quality, capacity, DNS) |
| Preflight | Server-side checks nutné pro spuštění kampaně |
| Schema A/B | Dual contact schema: A=new (contacts), B=legacy (outreach_contacts) |
| Suppression | Permanent block on email/domain (bounce, complaint, negative reply, unsubscribe) |
| Anti-trace | Anonymizace: žádné platform identifiers v odeslaných emailech |

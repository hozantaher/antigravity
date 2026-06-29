# Operator flow & UI/UX — coherent navigation

**Status:** návrh, čeká schválení
**Datum:** 2026-04-28
**Trigger:** "stránky jsou extrémně složité a nedávají smysl a navzájem na sebe vůbec nenavazují"

## Problém

Sidebar OK, ale stránky jsou **silos**. Každá řeší svou doménu izolovaně, žádné cross-page handoffs. Operátor musí ze stránky odejít, vzpomenout si, kam jít dál, otevřít druhou stránku, najít kontext znovu.

## Operátor — co dělá denně

| Úloha | Kolik krát/den | Aktuální cesta |
|---|---|---|
| **Triage odpovědí** | 5–20× | /replies → klik → ThreadDetail → … kde je původní zpráva? Kdo to poslal? Z jaké kampaně? Není tam |
| **Spustit novou kampaň** | 0–2× | /companies filter → uložit segment → /segments → /campaigns nový → vybrat segment → vybrat šablonu → vybrat schránky → 5 stránek a 4 kontextové ztráty |
| **Zkontrolovat běžící kampaně** | 3–5× | /campaigns → klik → CampaignDetail (741 LOC dump) → kde je "co dělat dál"? |
| **Najít leady / firmy** | 2–10× | /companies filter → pak co? Žádný "Spustit kampaň pro tento filter →" |
| **Vyřešit selhání schránky** | 0–3× | /mailboxes → drawer → … žádný link "kdo z kampaní tu schránku používá" |

**Společná chyba:** stránky neukazují **co je další krok**. Po skončení akce uživatel přemýšlí "a teď?" místo aby měl button "→ Pokračovat".

## Cross-page linky, které chybí

Aktuálně neexistuje (×) / chybí (?):

| Z | Na | Stav |
|---|---|---|
| Reply | Kampaň co poslala originál | ❌ |
| Reply | Kontakt + firma + historie | ❌ |
| Kampaň | Odpovědi (filtrované na tuto kampaň) | ❌ |
| Kampaň | Schránky které používá | ❌ |
| Schránka | Kampaně co ji používají | ❌ |
| Firma | "Spustit kampaň pro tento filter →" | ❌ |
| Firma | Kontakty té firmy | ✓ ale nepřímo |
| Segment řádek | Firmy s tím filtrem (preview) | ✓ ale 0 link na "použít v kampani" |
| Šablona | Kampaně co ji používají | ❌ |
| Dashboard widget | Drill-in s kontextem | částečně |

## Nový flow (návrh)

### Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  DASHBOARD  (start každý den)                                    │
│  · "X nových odpovědí" ───────────────────┐                      │
│  · "Y schránek problém" ───────┐          │                      │
│  · "Z aktivních kampaní" ──┐   │          │                      │
└────────────────────────────│───│──────────│──────────────────────┘
                             │   │          │
                             ▼   ▼          ▼
              ┌───────────────┐ ┌──────────┐ ┌───────────────────┐
              │  CAMPAIGNS    │ │ MAILBOXES│ │  REPLIES          │
              │  list         │ │ list     │ │  inbox            │
              │  + "+ Nová"   │ │ + drawer │ │  + filtr/badge    │
              └───────┬───────┘ └────┬─────┘ └─────────┬─────────┘
                      │              │                  │
                      ▼              ▼                  ▼
              ┌───────────────┐ ┌──────────┐ ┌───────────────────┐
              │ CAMPAIGN_NEW  │ │ MAILBOX  │ │  THREAD_DETAIL    │
              │ wizard 1-5    │ │ drawer   │ │  + kampaň context │
              │               │ │ +"v kamp"│ │  + contact card   │
              └───┬───────────┘ └────┬─────┘ │  + akce: klasif./│
                  │                  │       │    odpověď       │
                  ▼                  ▼       └─────────┬─────────┘
          step1: Segment      "Používá se v        │
            ↓                  3 kampaních →"       ▼
          [Existující]                          [Kampaň]
          [Nový z filtru]                       [Kontakt]
                  │
                  ▼
          step2: Šablona
                  ↓
          step3: Schránky
                  ↓
          step4: Schedule
                  ↓
          step5: Preview + Launch
                      │
                      ▼
              ┌───────────────────────┐
              │ CAMPAIGN_DETAIL tabs  │
              │  Přehled / Odeslání / │
              │  Odpovědi / Problémy  │
              └───────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  COMPANIES (browse + filter)                                     │
│  · QueryBuilder inline                                           │
│  · top akce:                                                     │
│      "Uložit jako segment"                                       │
│      "Spustit kampaň pro tento filter →"  (přejde do wizardu)    │
│  · klik firma → drawer (kontakty + history + score)              │
└──────────────────────────────────────────────────────────────────┘
                  │
                  ▼ (z drawer firmy)
              CONTACTS — filter na company_id

┌──────────────────────────────────────────────────────────────────┐
│  SEGMENTS (přehled uložených filtrů)                             │
│  · klik segment → COMPANIES s filtrem prefilled                  │
│  · button "Použít v kampani →" → CAMPAIGN_NEW prefilled          │
└──────────────────────────────────────────────────────────────────┘
```

### 5 hlavních flow

#### Flow A — Triage odpovědi (5–20× denně)

```
DASHBOARD "12 nových odpovědí"
  ↓ klik
REPLIES list (filtr default = unhandled)
  ↓ klik řádek
THREAD_DETAIL
  ┌─ Header: kontakt jméno + firma + skóre
  ├─ Kontext box: "Z kampaně: NACE 43120 stavebnictví, odesláno 2026-04-25 12:00 přes mazher.a"
  │   [→ Otevřít kampaň]
  ├─ Historie: původní zpráva (citace)
  ├─ Aktuální odpověď
  └─ Akce:
       [Zájem]  [Není zájem]  [Otázka — odpovědět]  [Unsubscribe]  [Označit vyřízeno]
```

**Klíčové novinky:**
- Reply má **vždy kontext kampaně** (nejen subject + body)
- Klik "Otevřít kampaň" jde na CampaignDetail prefiltrovaný na ten thread
- Akce klasifikace mění status + případně přidá kontakt na suppression / contact list

#### Flow B — Nová kampaň (0–2× denně)

```
COMPANIES filter (NACE 43120, region Praha)
  ↓ "Spustit kampaň pro tento filter →"
CAMPAIGN_NEW wizard
  step 1: Segment ← prefilled z Companies filteru
          [Pojmenovat a uložit] / [Použít jednorázově]
  step 2: Šablona
          [Existující] dropdown / [Nová] inline editor
  step 3: Schránky
          checklist aktivních (default = všechny zdravé)
  step 4: Plán
          [Hned] / [Naplánovat]
          Cap/den, send window, footer
  step 5: Preview
          Sender → Příjemce vzorek (3 emaily)
          [Spustit] → CAMPAIGN_DETAIL
```

**Klíčové novinky:**
- Wizard místo monolitické stránky → operátor vidí jen aktuální krok
- Vstup z Companies filtru = 0 kontextové ztráty
- Preview ukáže reálný rendered email před launch

#### Flow C — Monitoring kampaně (3–5× denně)

```
DASHBOARD "3 aktivní kampaně" → CAMPAIGNS list
  ↓ klik
CAMPAIGN_DETAIL (4 taby místo dump):
  [Přehled]   ← stat strip + status, primary action
  [Odeslání]  ← timeline odeslaných, send-events
  [Odpovědi]  ← filtrované replies + classification breakdown
  [Problémy]  ← bounce, paused mailboxy, send-rate alerts
                + akce: Pause / Resume / Reschedule / Edit footer
```

**Klíčové novinky:**
- 4 taby místo 1 dlouhé stránky (741 LOC → ~150 per tab)
- Default tab = "Přehled" (operátor viděl status okamžitě)
- "Problémy" tab existuje jen když má co ukázat (badge counter)

#### Flow D — Lead discovery (2–10× denně)

```
COMPANIES list + filter popover
  ↓ filter: NACE 4120 + region Brno + ICP ≥ 0.7
  ↓ vidí 234 firem, prochází
  ↓ klik firma
COMPANY_DRAWER:
  - Header: name, ico, sector, score, contacts count
  - Kontakty (3) — link na ThreadDetail historii
  - Send history — z jaké kampaně poslali
  - Skóre breakdown — jak se k tomu dostalo
  - Akce: [Přidat na suppression] [Označit zájem] [Vyloučit]
  ↓ "← Zpět na seznam"
   nebo
  ↓ "Spustit kampaň pro tento filter →" (z toolbaru COMPANIES)
```

#### Flow E — Mailbox quality (0–3× denně)

```
DASHBOARD "1 schránka problém" → MAILBOXES list
  ↓ klik schránka s nízkým score
MAILBOX_DRAWER (zjednodušený, 4 sekce):
  Stav      ← score + posledních 5 checků
  Použití   ← "Použito v 3 kampaních: Stavebnictví Praha, …"
              [link → CAMPAIGN_DETAIL každá]
  Akce      ← Reset AUTH, Pause, Test odeslání
  Pokročilé ← (collapsed) full-check detail + warmup + protections
```

## Page rename / reorganizace

| Aktuálně | Nový název / pozice | Důvod |
|---|---|---|
| /segments | /segments (zachovat jako readonly index) | Vytváření přesunuto inline do /companies |
| /watchdog | smazat ze sidebaru, přístup přes Cmd+K | Audit-grade, ne daily |
| /observability | smazat ze sidebaru, přístup přes Cmd+K | Audit-grade |
| /scoring | smazat ze sidebaru, přístup přes Cmd+K | Setup-time |
| /leads | smazat (zatím) | Experimentální, zmate operátora |
| /inbox | smazat (duplikuje /replies) | Duplicate route |

**Sidebar zůstává jak je** (per uživatel "v pohodě"). Tato iniciativa řeší pouze **content + flow uvnitř stránek**.

## Konkrétní cross-link patches (S1–S5)

### S1 — Reply ↔ Campaign context (90 min)
**Soubor:** `src/pages/ThreadDetail.jsx`, `server.js`

```
S1.1  ThreadDetail header zobrazí "Z kampaně: <name>" + odkaz
S1.2  GET /api/replies/:id/context → vrátí campaign + původní zpráva + kontakt
S1.3  Akce: [Zájem]/[Otázka]/[Unsubscribe]/[Vyřízeno]
        - Update reply.classification + reply_inbox.handled
        - Při Unsubscribe → suppression INSERT
S1.4  Replies list — badge "kampaň" sloupec, default sort by handled=false DESC
```

### S2 — Companies → Campaign launch (60 min)
**Soubor:** `src/pages/Companies.jsx`, `src/pages/CampaignNew.jsx`

```
S2.1  Companies toolbar: button "Spustit kampaň pro tento filter →"
        - Předá filter state přes navigate('/campaigns?new=1&filter=…')
S2.2  CampaignNew wizard step 1: detect ?filter= query → prefill segment
        - Zobrazí "Z filtru: …" badge, možnost "Uložit jako pojmenovaný segment"
S2.3  Segments page řádek — button "Použít v kampani →"
        - navigate('/campaigns?new=1&segment=<id>')
```

### S3 — CampaignDetail tabs (90 min)
**Soubor:** `src/pages/CampaignDetail.jsx` (741 → ~400 LOC)

```
S3.1  Extract komponenty:
        - CampaignOverview (stat strip, status, primary action)
        - CampaignSends (send-events timeline)
        - CampaignReplies (filtered replies + classification breakdown)
        - CampaignIssues (bounce, paused mailboxy, alerts)
S3.2  Default tab = Overview
S3.3  Tab badges: počet replies neořezaných + počet problémů
S3.4  Issues tab existuje jen když count > 0
```

### S4 — Mailbox usage cross-link (45 min)
**Soubor:** `server.js`, `src/pages/Mailboxes.jsx`

```
S4.1  GET /api/mailboxes/:id/usage → seznam kampaní co používají schránku
        - Query: SELECT campaigns where campaign_mailboxes.mailbox_id=$1
S4.2  MailboxDrawer "Použití" sekce s linky → CampaignDetail
S4.3  CampaignDetail → ze sekce "Schránky" linky → MailboxDrawer
```

### S5 — Dashboard drill-in (30 min)
**Soubor:** `src/pages/Dashboard.jsx`

```
S5.1  Widget "X nových odpovědí" → /replies?filter=unhandled
S5.2  Widget "Y schránek problém" → /mailboxes?filter=health=warn,err
S5.3  Widget "Z aktivních kampaní" → /campaigns?status=running
S5.4  Healing log + WatchdogWidget skryto za "Pokročilé" toggle
        (nebo úplně přesunuto na /observability)
```

## Mimo scope

- Vizuální redesign (typography, colors, spacing) — separátní iniciativa
- Mobile responsive — separátní
- I18n — zatím Czech-only
- Permissions — single-tenant

## Acceptance

- [ ] Z každé Reply existuje 1-click cesta na Campaign
- [ ] Z každé Campaign existuje 1-click cesta na Replies + Mailboxy + Companies (segment)
- [ ] Z Companies existuje 1-click "Spustit kampaň pro tento filter →"
- [ ] Z Mailbox existuje 1-click na seznam Campaigns co ji používají
- [ ] Dashboard widgety mají drill-in linky s předfiltrem
- [ ] CampaignDetail rozdělené do 4 tabů, default = Přehled
- [ ] CampaignNew je wizard 5 kroků, ne dump
- [ ] LOC: Mailboxes < 800, CampaignDetail < 500, Companies < 1000

## Per-sprint approval pattern

```
OK S1                  # full sprint
OK S1.1, S1.4          # selected steps
SKIP S2                # veto
EDIT S3.2: <text>      # tweak
```

## Vazba

Nahradí návrh `2026-04-28-dashboard-operator-refactor.md` (sidebar restructure už není potřeba — uživatel řekl "levé menu je v pohodě"). Tato iniciativa řeší **content + flow uvnitř stránek**.

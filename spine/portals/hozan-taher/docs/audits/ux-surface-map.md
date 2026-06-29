# UX Surface Map — expand-then-contract Phase 1 (EXPAND)

> Status: Audit (read-only) · Datum: 2026-06-02 · Trigger: #1586 ("ux/ui je
> komplexní, rozpadlé, potřebuje expand-then-contract")
>
> Phase 1 of #1586. Read-only inventory of the entire dashboard UX surface so
> Phase 2 (CONTRACT) has a factual basis. Produced by 3 parallel Explore agents
> (v1 surface, v2 surface, overlap+token drift).

## Verdikt (TL;DR)

Dashboard běží **dvě paralelní generace UI** vedle sebe:

- **v1** — 22 stránek, ~29 živých routes (+ 7 redirectů, 1 fallback), shell `Layout`,
  **3 token namespacy** (`--` base, `--c-` Signal-desktop, inline `px`/hex). Default landing (`/`).
- **v2** — 9 stránek + 13 sub-komponent, shell `AppShellV2`, **1 čistý token namespace** (`--v2-*`,
  parchment-lab). Sibling route tree na `/v2`, **bez redirectu** z `/` — operátor musí ručně navštívit.

**7 konceptů je v aktivní duplikaci.** v2 je čistá reference (jeden scoped token set);
v1 je dluh (3 token flavors + inline styly). Žádný hard cutover naplánovaný.

## v1 inventář

22 stránek v `src/pages/` (15 lokálních + 8 z service barrelů `@hozan/*-ui`). Klíčové živé:
Home `/`, Analytics, Templates, Mailboxes, Vehicles+Detail, TopTargets, Notifications,
DiagnostikaAnonymita, DedupGuard, CrmClients, SegmentBuilder, Settings(+3 taby),
CampaignSegment, Replies+RepliesChat+ThreadDetail, Companies, Contacts, Segments,
Campaigns+CampaignDetail.

**Redirecty (tombstones smazaných stránek):** `/watchdog`→`/mailboxes?tab=alerts`,
`/priprava`→`/`, `/priprava/hesla`→`/mailboxes`, `/scoring`→`/settings/thresholds`,
`/leads`→`/contacts`, `/observability`→`/analytics?tab=crony`, `/*`→`/`.
Orphan stránky: **0** (vše routované).

**Token namespacy ve v1 (drift):**
1. `--` base (index.css) — cool indigo/clinical-white studio
2. `--c-` (tokens-claude.css) — Signal-desktop cobalt (#2C6BED) po rejectu Claude.ai look
3. inline `style={{}}` — raw hex + literal px (`borderRadius:999`, `fontSize:12`)

## v2 inventář

Nav (AppShellV2): Přehled `/v2` · Odpovědi `/v2/odpovedi` · Vozidla `/v2/vozidla` ·
Firmy `/v2/firmy` · Kontakty `/v2/kontakty` · CRM `/v2/crm` · Kampaně `/v2/kampane` ·
Kvalita dat `/v2/kvalita`. (+ `/v2/hledat` cross-entity search, není v nav.)

9 routovaných stránek, vše **live** (žádné stuby). 13 sub-komponent (MinedSignals,
SignatureCard, SavePhoneButton, ClassificationControl, HaltAdvisory, ChatThread,
ReplyComposer, AttachmentStrip, VehicleCapturePanel, VehicleStatusStepper, …).
Jeden token namespace `--v2-*` (tokens-v2.css, parchment #F1E8D2 / vermilion #A53A26 /
serif), scoped `.v2-app`. Silně proklikané (replies→vozidla→firmy/kontakty→crm).

## Overlap matrix (7 duplikovaných konceptů)

| Koncept | v1 | v2 | Pozn. |
|---|---|---|---|
| Home | Home (widget grid) | V2Home (4 stat karty) | v1 bohatší |
| Replies | Replies + RepliesChat + ThreadDetail | V2Odpovedi (mail-client) | **v2 bohatší** (mining/podpis/keyboard) |
| Vehicles | Vehicles + VehicleDetail | V2Vozidla (+DetailAside) | parita |
| Companies | Companies | V2Firmy | parita, v2 má linked vehicles |
| Contacts | Contacts | V2Kontakty | parita |
| CRM | CrmClients | V2Crm | parita |
| Campaigns | Campaigns + CampaignDetail | V2Kampane (view-only) | **v1 bohatší** (run/pause/detail) |

## Token drift — konkrétně

- bg: v1 `#F5F6F8` cool vs v2 `#F1E8D2` parchment → opačný thermal mood
- accent: v1 `#2C6BED` cobalt vs v2 `#A53A26` vermilion
- text-base: v1 13px sans vs v2 12px serif (jiná rodina)
- radius: v1 3/4/7px vs v2 5/8/12px
- v1 inline px (YesterdaySummaryWidget, ScoreRangeSlider) se do v2 scoped kontextu nezdědí

## Gap analýza — co má v1 a v2 NEMÁ (musí přibýt před cutover)

v2 nepokrývá ~11 v1 surface:
**Analytics · Templates · Mailboxes · DiagnostikaAnonymita · DedupGuard · TopTargets ·
Segments/SegmentBuilder/CampaignSegment · Notifications · Settings(branding/icp/thresholds) ·
CampaignDetail (lifecycle run/pause) · Watchdog-alerts** (dnes v Mailboxes tabu).

v2-only (v1 nemá): **Kvalita dat · Hledat** (cross-entity search).

## Navržený CONTRACT (Phase 2)

Data jsou jednoznačná: **v2 = canonical** (1 token set, čistá IA, bohatší core). Cesta:

1. **Rozhodnutí směru** (operator): v2 jako budoucnost → dokončit migraci, retire v1.
2. **Expand zbývajícího surface do v2** (staircase, po jedné): portovat 11 chybějících
   v1 stránek do v2 shellu + `--v2-*` tokenů. Priorita dle operator-use:
   Mailboxes → Templates → Settings → CampaignDetail(lifecycle) → Analytics → zbytek.
3. **Cutover** `/` → `/v2` (redirect), v1 routes → v2 ekvivalenty.
4. **Contract/smazat** v1: `src/pages/*` + `--`/`--c-` token soubory + dead test debt
   (~10 e2e specs na smazané stránky, /priprava atd.).
5. Každý krok: Playwright smoke + screenshot light+dark před/po.

**Závislosti:** #1585 (dns-audit dvě cesty), #1321 (DNS UI panel), /priprava test debt.

**Pozn.:** Tohle je multi-sprint. Jednotlivé kroky jsou samostatné PR. Doporučený
první krok Phase 2: operator potvrdí směr (v2-canonical) → pak port Mailboxes do v2.

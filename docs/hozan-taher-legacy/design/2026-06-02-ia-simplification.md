# IA Simplification Proposal — Hozan Operator Dashboard (post-v2-cutover target)

> **Status:** Návrh k schválení (DESIGN-only, žádný kód) · **Datum:** 2026-06-02
> **Trigger:** #1586 — "ux/ui je komplexní, rozpadlé … zachovat funkční
> komplexnost, ale zjednodušit UX, lépe vymyslet ux/ui".
> **Companion:** `docs/audits/ux-surface-map.md` (inventář), `docs/initiatives/2026-06-02-ux-v2-cutover.md`
> (jednotky R/A/P/C/D), `docs/design/2026-06-02-odpovedi-triage-redesign.md` (per-surface vzor).
> **Scope:** cílová IA **po** cutoveru. Nepředepisuje pořadí migrace — popisuje, do
> jaké struktury se portované povrchy poskládají (N stránek → 1 sekce s taby/perspektivami).

## 1. Diagnóza

Dvě paralelní generace (v1 22 stránek / 3 token namespacy / default `/`; v2 8 nav +
skrytý hledat / 1 čistý `--v2-*` / sibling `/v2` bez redirectu) = **~19 destinací**,
které operátor drží v hlavě. 7 konceptů duplikováno. Struktura kopíruje DB tabulky
(Firmy/Kontakty/Vozidla/CRM = 4 nav), ne práci operátora — přitom je nikdy nenavštěvuje
izolovaně (jsou to pohledy na jeden propojený graf). Systémové povrchy (Mailboxes,
Diagnostika, DedupGuard, Notifications, Settings×3, Analytics) jsou rozsypané jako
rovnocenné top-level položky promíchané s denní prací.

## 2. IA princip

> **Sekce = práce operátora (jobs-to-be-done), ne databázová tabulka. Entity nejsou
> destinace — jsou uzly v jednom prokliku-propojeném grafu, do kterého se vstupuje
> přes denní práci a naviguje se po hranách.**

Tři vrstvy dle frekvence+záměru: (A) **Denní práce** · (B) **Data/registr** ·
(C) **Provoz/systém**. Čtyři entity → jeden **Registr** s perspektivami. Po cutoveru
jeden shell, jeden token set (`--v2-*`), žádný `/v2` prefix. **~19 → 7 top-level**,
bez ztráty funkce (vše tab/perspektiva/detail).

## 3. Navržená nav (7 destinací)

1. **Přehled** `/` — ranní glance celé pipeline. (v1 Home grid > v2 4 karty — viz §7.)
2. **Odpovědi** `/odpovedi` — inbound triage (hot reply → telefon → výkup). Viz odpovedi-redesign doc. Badge nevyřízených.
3. **Registr** `/registr` — jeden propojený graf; perspektivy (taby): **Vozidla** (default, "lead=vozidlo") · Firmy · Kontakty · CRM. Detail panely se proklikávají.
4. **Cílení** `/cileni` — koho oslovit: **Top targets** · **Segmenty** (+builder).
5. **Kampaně** `/kampane` — outbound run/pause/sledovat: Seznam · Detail (lifecycle+preflight+X-Confirm-Send) · Šablony · segment v detailu.
6. **Provoz** `/provoz` — zdraví odesílací infry (reaktivní): Schránky · Upozornění · Notifikace · Anonymita · Dedup guard · Crony/Analytika.
7. **Nastavení** `/nastaveni` — Branding · ICP · Prahy · Kvalita dat.

Globálně (topbar, ne nav): **Hledat vše** (cross-entity search, dnešní `/v2/hledat`).

```
⚗ Hozan lab
── DENNÍ PRÁCE ──
  ▭ Přehled
  ✉ Odpovědi      [3]
── DATA ──
  ▦ Registr            ↳ Vozidla·Firmy·Kontakty·CRM
  ◎ Cílení             ↳ Top targets·Segmenty
  📣 Kampaně           ↳ Seznam·Detail·Šablony
── SYSTÉM ──
  ⚙ Provoz             ↳ Schránky·Upozornění·Anonymita·Dedup·Crony
  ⚙ Nastavení          ↳ Branding·ICP·Prahy·Kvalita dat
☾ Tmavý režim
topbar: [stav] ………… 🔎 Hledat vše…
```

## 4. Fold / merge / drop (všech ~19 povrchů)

| Dnešní povrch | Rozhodnutí | Cíl |
|---|---|---|
| Home (v1) | keep-merge (základ) | Přehled |
| V2Home | merge | Přehled |
| Replies+RepliesChat+ThreadDetail (v1) | drop | Odpovědi (v2) |
| V2Odpovedi | keep (+R1 redesign) | Odpovědi |
| Vehicles+Detail / Companies / Contacts / CrmClients (v1) | drop | Registr (perspektivy) |
| V2Vozidla / V2Firmy / V2Kontakty / V2Crm | keep | Registr · perspektivy |
| TopTargets / Segments / SegmentBuilder (v1) | make-tab (port) | Cílení |
| Campaigns+CampaignDetail (v1, **bohatší**) | keep (port lifecycle) | Kampaně |
| V2Kampane (view-only) | merge → v1 chování na v2 shellu | Kampaně |
| CampaignSegment / Templates (v1) | make-tab | Kampaně · Detail/Šablony |
| Mailboxes(+hesla) / Watchdog-alerts / Notifications / DiagnostikaAnonymita / DedupGuard / Analytics (v1) | make-tab (port) | Provoz |
| Settings ×3 (v1) | make-tab | Nastavení |
| V2Kvalita | keep (move) | Nastavení · Kvalita dat |
| Hledat (v2) | promote | topbar global search |
| /leads /scoring /priprava /watchdog /observability | drop tombstones | — (leady JSOU vozidla) |

Net: **22 v1 → 0 samostatných destinací; ~19 → 7 + global search.**

Rázná rozhodnutí: Registr slévá 4 entity (největší úspora); Provoz = 1 systémový dům
(6 tabů, reaktivní); **Campaigns: v1 vyhrává** (run/pause/preflight — port verbatim, P4);
Kvalita dat NENÍ vlastní nav (patří pod Nastavení).

## 5. Cross-linking (navigace po datech)

Detail = aside panel (scaffold A1 `<V2DetailAside>`), ne full-page; neztratí kontext seznamu.
Každý mezi-entitní odkaz nese identitu + breadcrumb zpět. Filtrované deep-linky místo nových
stránek (`Registr·Vozidla?company_id=…`, sdílitelné URL state). Global search = univerzální
vstup (telefon/IČO/SPZ/jméno/e-mail → typovaný výsledek → detail aside). Mined signály jsou
first-class hrany — zobrazí se na uzlu (kontakt/vozidlo), kde se rozhoduje.

> Cíl: operátor odbaví celý lead, aniž jednou klikne do sidebaru — vstoupí přes Odpovědi
> (nebo search) a putuje po hranách detail panelů.

## 6. Co zachovat

v2 design system (`--v2-*`, light+dark), bohatší v2 core (odpovedi/vozidla/firmy + proklikání),
mining, calm states, bohatší v1 chování kde vyhrává (Home grid, campaign lifecycle — port na
v2 shell), bezpečnostní gates (X-Confirm-Send, preflight, 429/425, auth-lock), quality gate
per surface (smoke + screenshot + axe + ≤800 LOC).

## 7. Otevřené otázky pro operátora

1. **Registr = 1 sekce se 4 perspektivami?** Největší zjednodušení, ale mění zvyk. Alt: Vozidla zvlášť (denní lead surface) + Registr jen Firmy/Kontakty/CRM.
2. **"Provoz" = 1 dům se 6 taby, nebo moc?** Alt: Schránky (denně) + Diagnostika (zřídka) zvlášť.
3. **Analytika** — vlastní destinace, nebo tab v Provozu? (Dle frekvence sledování metrik.)
4. **Přehled** — bohatý v1 widget grid, nebo minimal v2 4 karty?
5. **Kvalita dat** — tab v Nastavení (konfigurace), nebo vlastní destinace (denní ingest monitor)?

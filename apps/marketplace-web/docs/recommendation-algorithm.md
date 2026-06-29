# Doporučovací algoritmus inzerátů

> Jádro funkcionality pro doporučování aukčních inzerátů návštěvníkům (přihlášeným i nepřihlášeným).
> Cílové plochy: **detail inzerátu** ("Podobné inzeráty") a **newsletter** (plánováno).
> Tento dokument je návrh — referenční specifikace algoritmu, datového modelu a integrace do `garaaage-auction`.

---

## 1. Cíl a kontext

Doporučujeme **aktivní** aukční/prodejní inzeráty (`items`) tak, aby návštěvník viděl to, co ho s největší pravděpodobností zaujme. Specifika domény, která tvarují celý návrh:

- **Inzeráty jsou časově omezené.** Aukce má `startDate`/`endDate`; po skončení (`hasAuctionEnded`) nebo prodeji (`sold`) inzerát z doporučení mizí. Na rozdíl od klasického e-shopu je **kandidátní pool malý a rychle se mění** (řádově stovky aktivních položek), recency je zásadní a "stálice katalogu" neexistují.
- **Máme jen implicitní zpětnou vazbu.** Žádné hvězdičky/ratingy — pracujeme s chováním (návštěvy, doba, fotky, zoom, sdílení, oblíbené, přihození). To je klasický **implicit-feedback** problém.
- **Bohatý obsahový popis vozidel.** `items` nese strukturované atributy (kategorie, palivo, převodovka, karoserie, pohon, barva, výkon, objem, cena, země) + `specs` (značka/model/rok). To dělá **content-based** přístup velmi silným už od pár interakcí.
- **Anonymní i přihlášení.** Většina návštěvníků není přihlášená; doporučení musí fungovat bez účtu.
- **Studený start = "průměr".** Návštěvník bez statistik vidí to, co je populární napříč všemi uživateli (volitelně zúžené segmentem, který známe i bez profilu — kategorie/země/jazyk).

### Designové principy

1. **Hybridní recommender** — content-based (taste profil) ⊕ collaborative (attribute-level co-engagement) ⊕ popularity prior, spojené **confidence blendem**.
2. **Graceful degradation** — čím méně dat, tím víc se opíráme o populární průměr. Nový návštěvník = čistá populace; těžký uživatel = personalizace. Spojité, ne skokové.
3. **Neblokující sběr** — data tečou jednosměrným streamem (fire-and-forget), uživatel není nikdy zdržen.
4. **Privacy-first** — sběr až po souhlasu (`cookies-consent`), pseudonymní ID, TTL, právo na výmaz.
5. **Robustnost přes pojistky** — deterministický fallback řetězec, omezené (saturující) signály, diverzita, explorace, kill-switch. Servírovací endpoint **nikdy nespadne** — v nejhorším vrátí `defaultSort`.
6. **Konfigurovatelnost** — všechny váhy a knoby jsou data (jeden config modul), ne zadrátované konstanty; později se učí z konverzí.

---

## 2. Architektura — přehled

```
┌─────────────────────────── KLIENT (browser, anon i přihlášený) ───────────────────────────┐
│  ItemsGrid (hover / impression)   ItemGallery·Lightbox·Pano (photo / zoom / 360°)          │
│  ItemSharing (share)   useCompare (compare)   detail page (dwell / scroll / video)         │
│                          │  enqueue()  — VueUse throttle / IntersectionObserver / hover     │
│                          ▼                                                                  │
│                  useTracking.ts  ── in-memory buffer ──►  flush (interval · visibility · unload)
│                          │  navigator.sendBeacon  (fetch keepalive fallback) — fire & forget │
└──────────────────────────┼──────────────────────────────────────────────────────────────────┘
                           ▼   jednosměrný stream, neblokuje UI
                  POST /api/track     (consent-gated · rate-limited · append-only · 204 No Content)
                           ▼
                  recommendation_events     (append-only log, TTL ~365 dní)
                           │
   ┌───────────────────────┴── POST /api/cron/build-recommendations  (Cloud Scheduler) ───────┐
   │  rollup → visitor_profiles · item_features · attribute_affinity · popularity_segments      │
   └───────────────────────┬─────────────────────────────────────────────────────────────────┘
                           ▼   precompute · idempotentní · crash-safe okno
 ┌── GET /api/recommendations/item/:id ──┐  ┌──── newsletter batch ────┐  ┌── /api/recommendations/home ──┐
 │ scoring nad aktivním poolem + fallback │  │ per-user výběr + MMR + ε │  │ segment / personal (volitelně) │
 └─────────────────┬──────────────────────┘  └────────────┬─────────────┘  └───────────────┬───────────────┘
                  ▼                                        ▼                                ▼
        Detail: "Podobné inzeráty"               E-mail newsletter                 Homepage rail (volitelně)
```

**Tři vrstvy, tři rychlosti:**

| Vrstva | Kde | Latence | Co dělá |
| --- | --- | --- | --- |
| **Hot path** (sběr) | klient + `POST /api/track` | < 1 ms vnímané | jen zapíše event, žádný výpočet |
| **Batch** (agregace) | `POST /api/cron/build-recommendations` | minuty, mimo request | přepočítá profily, features, popularitu, attribute-afinitu |
| **Serving** (scoring) | `GET /api/recommendations/*` + klient | desítky ms | čte precompute, skóruje malý aktivní pool, fallback; klient ještě within-session re-rank |

Toto rozdělení je tím, co současně splňuje *"sběr nesmí zdržovat"* a *"robustní"*. Drahá matematika nikdy neběží na cestě uživatele.

---

## 3. Sběr dat — signály

Cílem je posbírat **co nejvíc** relevantních signálů, ale uložit je **odvozené a omezené** (ne syrové stopy myši). Každý signál má: způsob záchytu, transformaci (saturace/clamp) a **bázovou váhu** podle síly záměru.

### 3.1 Taxonomie signálů a váhy

Váhy jsou **ilustrativní priory** (žijí v configu, viz §13) — později se učí z konverzí (§13). `sat(x, x0) = 1 − exp(−x / x0)` je saturující transformace (výstup 0…1), která brání tomu, aby jeden extrémní signál dominoval.

| Signál | Záchyt | Surová hodnota | Transformace | Báz. váha `wₛ` | Vrstva záměru |
| --- | --- | --- | --- | ---: | --- |
| `bid_placed` | server (`bids`) | 1 | — | **10.0** | konverze (nejsilnější) |
| `offer_made` | server (`contactMessages` kind `offer`) | 1 | — | **7.0** | konverze |
| `favorite_add` | server (`users.favoriteIds`) | 1 | — | **6.0** | silný explicitní |
| `contact_seller` | server (`contactMessages` kind `contact`) | 1 | — | **4.5** | silný |
| `share` | klient (`ItemSharing`) | 1 | — | **5.0** | advokacie |
| `compare_add` | klient (`useCompare`) | 1 | — | **3.0** | zvažování |
| `pano_360_interact` | klient (`Pano`) | # interakcí | `sat(·, 3)` | **3.0** | hloubková inspekce |
| `photo_zoom` | klient (`ItemLightbox`) | # zoomů | `sat(·, 3)` | **2.5** | hloubková inspekce |
| `dwell_active` | klient (visibility heartbeat) | aktivní sekundy | `sat(·, 90)`, clamp 180 s | **2.5** | hloubka |
| `video_play` | klient (YouTube embed) | 1 | — | **2.0** | střední |
| `photo_view` | klient (galerie/lightbox) | # unikátních fotek | `sat(·, 8)` | **2.0** | střední |
| `detail_view` | klient + server | 1 | — | **1.5** | proklik |
| `search_query` | klient (`/search`) | term → atributy | mapování na features | **1.0** | záměr |
| `scroll_depth` | klient (detail) | 0…1 | lineární | **1.0** | hloubka čtení |
| `category_view` | klient (listing) | 1 | `sat` per kategorie | **0.6** | ambient |
| `card_hover_dwell` (desktop) | klient (`useElementHover`) | ms nad kartou | práh 800 ms, `sat(·, 5000)` | **0.5** | ambient |
| `card_viewport_dwell` (mobil) | klient (`IntersectionObserver`) | s ve viewportu | práh 2 s, `sat(·, 6)` | **0.5** | ambient (mobilní ekvivalent hoveru) |
| `impression` | klient (+ slot/propensity) | 1 | — | **0** (jmenovatel) | neutrální |
| **negativní:** | | | | | |
| `favorite_remove` | server | 1 | — | **−2.0** | odmítnutí |
| `short_dwell_bounce` | odvozeno (< 3 s + návrat) | 1 | — | **−0.5** | pogo-sticking |
| `impression_fatigue` | odvozeno (N zobrazení 0 prokliků) | # | `−0.3 · sat(·, 10)` (cap) | **−0.3** | únava |

**Násobiče (ne aditivní):**

- `return_visit` — opakovaná návštěva téhož detailu napříč sezeními: `× (1 + 0.3 · sat(repeats, 3))`. Loajalita k položce zesiluje, ne přidává.

### 3.2 Pohyb kurzoru a "hover bez kliknutí" (desktop i mobil)

Explicitní požadavek — zachytit *delší pohyb kurzoru nad inzerátem bez kliknutí*, i na telefonu:

- **Desktop:** na kartě v `ItemsGrid` VueUse `useElementHover` + časovač. Pokud kurzor setrvá nad kartou déle než **práh (800 ms)**, naroste `card_hover_dwell`. Emituje se **jednou** při překročení prahu + finální hodnota při `mouseleave` (saturovaná). Žádný `mousemove` log — jen výsledná doba setrvání.
- **Mobil (žádný kurzor):** ekvivalent je **doba ve viewportu**. `IntersectionObserver` (VueUse `useIntersectionObserver`) měří, jak dlouho je karta viditelná; nad **prahem 2 s** → `card_viewport_dwell`. Scrollne-li uživatel pomalu a karta "visí" na obrazovce, je to projevený zájem analogický hoveru.

Obojí je **ambient signál** (váha 0.5) — slabý, ale nasčítá se do afinity ke kategorii/značce. Důležité: **práh + saturace** brání tomu, aby otevřená záložka na pozadí generovala falešný zájem.

### 3.3 Doba na inzerátu — jen *aktivní* čas

`dwell_active` neměří wall-clock, ale **aktivní viditelný čas**: heartbeat běží jen když `document.visibilityState === 'visible'` (VueUse `useDocumentVisibility` + `useTimeoutPoll`). Záložka na pozadí, minimalizované okno nebo usnulý telefon **nepřičítají čas**. Clamp na 180 s odřízne odešlou-a-zapomněl outliery. Tím je dwell odolný proti zkreslení.

### 3.4 Fotky, zoom, 360°, video

Instrumentují se přímo existující komponenty:

- `ItemGallery` / `ItemLightbox` — `photo_view` (set unikátních zobrazených indexů → počet), `photo_zoom` (počet aktivací zoomu).
- `Pano` — `pano_360_interact` (drag/rotace 360° náhledu).
- YouTube embed — `video_play` (první play).

### 3.5 Signály, které už server sbírá (bootstrap zdarma)

Tři nejsilnější signály **už v DB jsou**, takže profil lze počítat ještě před nasazením klientského trackingu:

- `users.favoriteIds[]` → `favorite_add`
- `bids` (itemId, userId, date) → `bid_placed`
- `contactMessages` (kind `offer`/`contact`, itemId, userId) → `offer_made` / `contact_seller`

Batch job je čte přímo z produkčních tabulek — Fáze 1 personalizace tak má signál i bez jediného `track` eventu.

### 3.6 Klientský transport — neblokující jednosměrný stream

Composable `useTracking.ts`:

- **In-memory buffer** — `enqueue(event)` jen přidá do pole, **nikdy neawaituje**.
- **Throttle/debounce** drahých zdrojů (hover, scroll, mousemove) přes VueUse (`useThrottleFn`, `useDebounceFn`) — vzorkujeme, nelogujeme každý pixel.
- **Flush** se spustí: po **intervalu** (~8 s, je-li buffer neprázdný), na `visibilitychange → hidden`, na `pagehide`/`beforeunload`, a při překročení velikosti bufferu (~20 eventů).
- **Odeslání:** `navigator.sendBeacon('/api/track', batch)` — asynchronní, neblokující, **přežije unload stránky**. Fallback `fetch(url, { method: 'POST', keepalive: true, body })`. Nikdy se na to nečeká v handleru uživatelské akce.

```
klik / hover / scroll  ──►  enqueue()  ──►  [ buffer ]
                                                │  (interval | hidden | unload | full)
                                                ▼
                                       sendBeacon(batch)  ──►  /api/track  (204)
                                       └─ fire & forget, UI pokračuje bez čekání
```

### 3.7 Serverový ingest — `POST /api/track`

- **Veřejný** (anon povolen), přijímá `vid` (visitor id) + volitelně `userId` z Bearer tokenu.
- **Consent gate** — klient posílá jen po souhlasu; server navíc ověří/odmítne bez `vid`.
- **Rate-limit** přes `enforceRateLimit` (anti-bot), idempotence přes klientské `eventId` (dedupe na PK).
- **Lehká validace**, batch INSERT do `recommendation_events`, návrat **`204` co nejrychleji**. Žádný výpočet na hot path.

---

## 4. Datový model (nové tabulky)

Kysely styl dle `server/db/schema.ts` (camelCase → snake_case přes `CamelCasePlugin`), migrace `021-…`+ dle stávajícího patternu.

### 4.1 `recommendation_events` — append-only log

```ts
export interface RecommendationEventsTable {
  id: string                 // klientské UUID = idempotency klíč (dedupe)
  vid: string                // pseudonymní visitor id (cookie)
  userId: string | null      // vyplněno, je-li přihlášen
  sessionId: string | null   // sezení (pro bounce/return detekci)
  type: string               // 'detail_view' | 'photo_zoom' | 'card_hover_dwell' | …
  itemId: string | null      // soft ref (item může zaniknout)
  categoryId: string | null  // denormalizováno pro rychlý category rollup
  value: Numeric | null      // surová hodnota (sekundy, počet, ms) — transformace až v batchi
  surface: string | null     // plocha původu ('detail' | 'home' | 'listing' | 'newsletter')
  position: number | null    // slot/rank, na kterém byla položka zobrazena (impression)
  propensity: Numeric | null // P(zobrazení na daném slotu) — pro pozdější IPS debiasing
  meta: Record<string, unknown> | null  // např. { make, bodyType, priceBand } snapshot
  occurredAt: Timestamp      // čas na klientu
  createdAt: Generated<Date> // čas příjmu (audit)
}
// PK (id). Indexy: (vid, occurredAt), (userId, occurredAt), (itemId), (type, occurredAt).
// TTL: řádky starší než RECO_EVENT_TTL_DAYS maže prune pass v cron jobu.
```

Denormalizace `categoryId`/`meta` snapshotu atributů znamená, že batch nemusí joinovat na `items` za každý event (a snese i zánik položky). **`position`/`propensity` se logují od fáze 0** (použijí se až ve fázi 5): bez nich je popularita i pozdější learning-to-rank zkreslené pozicí ve výpisu a debiasing (IPS) by neměl z čeho počítat — proto se sbírají od začátku, ne až bude potřeba.

### 4.2 `visitor_profiles` — agregovaný taste profil

```ts
export interface VisitorProfilesTable {
  vid: string                          // PK
  userId: string | null               // po přihlášení (merge)
  features: VisitorFeatureVector       // JSONB: distribuce + numerická μ/σ (viz §6)
  topMakes: Array<[string, number]>    // top-K značek s vahou (high-cardinality)
  nEff: Numeric                        // evidence: decayed počet distinct zaujavších položek (ne ΣE — viz §6.3)
  alpha: Numeric                       // confidence 0…1 (= nEff/(nEff+K)) — předpočteno
  lastEventAt: Timestamp | null
  updatedAt: Generated<Date>
}
// Index (userId). vid bez aktivity > TTL se prune.
```

### 4.3 `item_features` — vektor položky + popularita

```ts
export interface ItemFeaturesTable {
  itemId: string                 // PK
  vector: ItemFeatureVector      // JSONB: one-hot kategoriálů + standardizované numeriky
  popScore: Numeric              // Bayesovsky shrunk engagement rate (§9)
  trendScore: Numeric            // velocity poslední ~72 h
  engagementSum: Numeric         // decayed engagement (čitatel popularity)
  impressionCount: Numeric       // jmenovatel
  distinctViewers: number
  qualityScore: Numeric          // úplnost inzerátu (fotky/360/specs/highlight)
  updatedAt: Generated<Date>
}
```

### 4.4 `attribute_affinity` — collaborative (attribute-level co-engagement)

```ts
export interface AttributeAffinityTable {
  dimension: string     // 'make' | 'bodyType' | 'priceBand' | 'category'
  valueA: string        // hodnota atributu (např. 'bmw')
  valueB: string        // sousední hodnota (např. 'audi')
  score: Numeric        // kosinus nad sloupci visitor×attribute engagement matice
  updatedAt: Generated<Date>
}
// PK (dimension, valueA, valueB). Jen top-K (~20) sousedů na hodnotu.
// Malá hustá matice (desítky značek/segmentů) — ne řídká item×item; přežívá obměnu inventáře.
```

### 4.5 `popularity_segments` — "průměr" pro studený start

```ts
export interface PopularitySegmentsTable {
  segmentKey: string    // 'global' | 'cat:moto' | 'country:de' | 'lang:cz' | 'device:mobile'
  ranking: Array<{ itemId: string; score: number }>  // top-N aktivních
  updatedAt: Generated<Date>
}
// PK (segmentKey). To, co vidí návštěvník bez profilu.
```

### 4.6 Identita návštěvníka (`vid`) a merge

Žádný visitor id zatím neexistuje — zavedeme **first-party cookie `vid`** (náhodné UUID), nastavenou serverem **až po souhlasu**. Protože je to cookie, **chodí i s SSR requestem** → detail umí personalizovat i server-side (token je sice jen na klientu, ale `vid` cookie server vidí).

- **Merge-on-login:** při přihlášení se `vid` přiřadí k `userId` (mapovací sloupec ve `visitor_profiles` + denormalizace do eventů), takže anonymně nasbíraný profil se nezahodí.
- **Pseudonymita:** `vid` sám o sobě není PII; bez souhlasu se nenastaví a nepersonalizuje se (jen neosobní popularita).

---

## 5. Engagement skóre `E(v, i)`

Jádro převodu signálů na číslo. Pro dvojici (visitor `v`, item `i`) sečteme transformované signály × váha × **time decay**, vynásobíme loajalitními násobiči:

```
E(v, i) =  ReturnMult(v, i) ·  Σ_s  [ wₛ · transformₛ(rawₛ) · decay(age) ]

decay(age) = exp( −ln 2 · age_days / H )          # exponenciální, half-life H (default 21 dní)
ReturnMult = 1 + 0.3 · sat(return_visits, 3)
```

- **Time decay** (`H`) zajišťuje **svěžest profilu** — zájem o vozy z minulého měsíce vyhasíná, profil sleduje aktuální vkus. Zároveň přirozeně omezuje růst (staré eventy se prune).
- **Saturace** (`transformₛ`) brání dominanci jednoho signálu (hodina dwellu ≠ nekonečné skóre).
- **Záporné signály** (bounce, fatigue, un-favorite) `E` snižují; `E` se **clampuje na ≥ 0** při tvorbě profilu (nechceme "anti-vektory"), ale záporné příspěvky korigují přefouknuté kladné.

`E(v, i)` je vstupem do tří věcí: **taste profilu** (§6), **attribute-level co-engagement** (§11) a **popularity agregátu** (§9).

---

## 6. Taste profil návštěvníka (content)

Profil je **engagement-vážený centroid položek v prostoru atributů**. Jiný tvar pro kategoriály a numeriky:

### 6.1 Kategoriální dimenze → distribuce

Pro dimenzi `d ∈ { categoryId, type, fuelType, transmission, bodyType, driveType, color, countryCode, make, model }`:

```
P_d(v)[k] =  Σ_{i : i.d = k}  E(v, i)
            ─────────────────────────────        # podíl engagementu na hodnotě k
                  Σ_i E(v, i)
```

Tj. *"uživatel je z 60 % SUV, 30 % sedan, 10 % kupé."* `make`/`model` jsou high-cardinality → držíme jen **top-K** s vahou (`topMakes`), zbytek do `other` (feature hashing volitelně).

### 6.2 Numerické dimenze → vážená μ a σ

Pro `d ∈ { price (log), year, enginePowerKw, engineDisplacementCcm }` ve **standardizovaném** (z-skóre, u ceny v log-prostoru) tvaru:

```
μ_d(v) = Σ_i E(v,i)·z(i.d) / Σ_i E(v,i)
σ_d(v) = sqrt( Σ_i E(v,i)·(z(i.d) − μ_d)² / Σ_i E(v,i) )   ,  σ_d ← max(σ_d, σ_floor)
```

Tj. *"uživatel cílí na vozy kolem r. 2018 ±2 roky, cena ~500 k ±100 k."* `σ_floor` brání nulovému rozptylu u uživatele s jedinou interakcí (robustnost).

### 6.3 Confidence `α(v)`

Kolik dat máme → jak moc profilu věřit. **Confidence řídí *počet* evidence, ne *velikost* engagementu** — jinak by jeden silný signál (`bid_placed`, w=10) přefoukl jistotu z jediné akce a záporný signál (un-favorite) by ji paradoxně *snižoval*. `E(v,i)` proto drží jen váhu v centroidu; confidence počítá počet distinct zaujavších položek:

```
n_eff(v) = Σ_i 1[E(v, i) > 0] · decay(age_i)   # evidence = decayed počet zaujavších položek (NE ΣE)
α(v)     = n_eff(v) / (n_eff(v) + K)           # K = smoothing (default 5)
```

- nový návštěvník: `n_eff = 0 → α = 0` → **čistá populace** (studený start = "průměr"),
- těžký uživatel: `α → 1` → převážně personalizace.

`α` je spojitý → žádný skokový přechod, žádné "od kolika kliků zapnout personalizaci". Oddělení od `ΣE` znamená, že 10 hoverů na jednu položku ≠ 10× jistota a negativní signál profil koriguje, aniž by snižoval confidence.

---

## 7. Skórování kandidáta — master formule

Pro plochu `S`, návštěvníka `v`, volitelnou kotvu `a` (detail) a kandidáta `c` z **aktivního validního poolu** `A`.

### 7.1 Relevance personal ⊕ popularita

```
personal(v, c) =  Σ_d ω_d · sim_d(v, c)
                 ──────────────────────          # vážený průměr přes dimenze
                       Σ_d ω_d

   kategoriál:  sim_d = P_d(v)[ c.d ]                              # masa, kterou uživatel dává hodnotě c
   numerik:     sim_d = exp( −½ · ( (z(c.d) − μ_d) / σ_d )² )      # Gaussovo jádro (proximita)

   ω_d = důležitost dimenze   (category, make ≫ … ≫ color)
```

Chybí-li `c.d` nebo uživatel nemá na `d` signál → dimenze se **přeskočí a Σω se přenormuje** (robustnost vůči chybějícím datům).

```
base(v, c) = α(v) · personal(v, c)  +  (1 − α(v)) · pop_seg(c)
```

`pop_seg(c)` = populární skóre v nejužším segmentu, který o `v` známe (§9). Tohle je **graceful degradation v jednom řádku**.

### 7.2 Kotva na detailu (kontext)

Na detailu položky `a` doporučení **ukotvíme** k `a`:

```
sim(a, c)   = γ · contentSim(a, c)  +  (1 − γ) · attrAffinity(a, c)
rel(v, c|a) = β · sim(a, c)         +  (1 − β) · base(v, c)
```

- `contentSim` = kosinus nad `item_features.vector` (stejná značka/karoserie/cenové pásmo → vysoko).
- `attrAffinity` = naučená **cross-attribute afinita** (§11): "kdo řeší značku/segment `a`, řeší i `c`" — zachytí vazby, které atributová podobnost nevidí (BMW↔Audi), a na rozdíl od item↔item **přežije obměnu inventáře**.
- `γ` je **confidence-vážené** (málo dat → spoléhej na content; s daty roste afinita).
- `β` ≈ 0.65 — na detailu dominuje kontext kotvy, ale osobní vkus stále promlouvá.

Bez kotvy (newsletter/home): `rel = base`.

### 7.3 Finální skóre + tvrdé brány

```
final(v, c) = ( w_rel·rel(v,c)  +  w_trend·trend(c)  +  w_qual·quality(c)  +  w_fresh·fresh_S(c) )
              · Valid(c)                                        # tvrdá brána 0/1
```

- `trend(c)` — velocity engagementu (vzestup zájmu) → vynáší nové žhavé položky.
- `quality(c)` — úplnost inzerátu (má fotky / 360° / specs / `priceHighlighted`) → nepředstavuj prázdné inzeráty.
- `fresh_S(c)` — **kontext-závislá svěžest** (viz §8): na webu boostuje "končí brzy", v newsletteru naopak penalizuje položky, co skončí dřív, než si mail někdo přečte.
- `Valid(c) ∈ {0,1}` — tvrdá brána (§8): vyřadí skončené/prodané/skryté/kotvu samotnou. **Korektnost, ne jen ranking.**

Po seřazení ještě **post-processing**: MMR diverzita (§10.4) + ε-explorace (§10.5).

---

## 8. Doménové constrainty aukcí (validita & svěžest)

Aukce končí — recommender to musí respektovat na dvou úrovních:

**Tvrdá brána `Valid(c)` (ranking se na ni vůbec nedostane, pokud je 0):**

```
Valid(c) = c.id ≠ anchor.id
         ∧ ¬c.hidden ∧ ¬c.sold
         ∧ itemStatus(c) ∈ { AuctionLive, AuctionSoon, BuyNow }   # ne AuctionEnd/Processing/Sold
         ∧ c ∉ alreadyConverted(v)        # už má v oblíbených / přihodil → nedoporučuj znovu
```

Využívá existující helpery z `models/Item.ts` (`itemStatus`, `hasAuctionEnded`, `isAuctionLive`).

**Měkká svěžest `fresh_S(c)` (per plocha):**

- **Detail / homepage (on-site):** mírný boost pro `AuctionLive` blízko konce (`endDate` brzy) — vytváří urgenci, ale ne přehnaně (jinak by se nikdy nedoporučovaly nové).
- **Newsletter:** **vyřaď** položky, které skončí dřív než `RECO_NEWSLETTER_HORIZON` (default 48 h) po odeslání — byly by po konci, než si mail někdo otevře. Preferuj `AuctionSoon` a aukce s komfortní rezervou + "nové od posledního newsletteru".

---

## 9. Popularita = "průměr" (studený start)

`pop_seg(c)` je to, co vidí návštěvník bez profilu — **průměr napříč všemi uživateli**, počítaný robustně.

### 9.1 Bayesovsky shrunk engagement rate

Naivní "engagement / impressions" odměňuje položku s 1 šťastným proklikem. Proto **Bayesovský průměr** (shrink k populačnímu průměru `C₀`):

```
popRate(c) =  engagementSum(c) + m · C₀
             ───────────────────────────         # m = síla prioru (default 20)
              impressionCount(c) + m

C₀ = globální průměr engagement-per-impression
```

Položka s málo zobrazeními je stažena k průměru; s rostoucími daty se prosadí její skutečný rate. Shrink ale řeší jen **šum z malých počtů**, ne **systematické zkreslení pozicí** (co je nahoře, dostane proklik bez ohledu na kvalitu). Proto se u impresí loguje `position`/`propensity` (§4.1) — `popRate` i pozdější učení vah (§13) lze debiasovat inverse-propensity vážením; bez toho feedback loop popularity jen utahuje sám sebe.

### 9.2 Finální popularita

Min-max normalizovaná kombinace nad aktivním poolem:

```
pop(c) = norm( z₁·popRate(c) + z₂·log(1+bidCount) + z₃·log(1+favCount)
               + z₄·log(1+distinctViewers) + z₅·trend(c) )
```

### 9.3 Segmentace průměru (i bez profilu)

I anonymní návštěvník nese **zero-party kontext**: vstupní kategorie (`/category/moto`), země (geo/`Accept-Language`), jazyk, device. Servírujeme **nejužší dostupný segment**:

```
pop_seg(c) =  pop( segment )   kde segment = nejspecifičtější z:
              cat:{landingCategory} → country:{geo} → lang:{locale} → global
```

Návštěvník, co přistál na motorkách, vidí populární motorky — ne globální průměr. Stále "průměr ze všech uživatelů", jen podmíněný kontextem, který máme zdarma.

---

## 10. Robustnost a pojistky

Explicitní požadavek. Vrstvený obranný val:

### 10.1 Deterministický fallback řetězec

Servírovací endpoint **nikdy nevyhodí výjimku k uživateli** — každá vrstva chytá selhání/prázdno té předchozí:

```
personalized (α>0, profil existuje)
   └─► segment-popular (cat / country / lang)
          └─► global-popular
                 └─► newest-active (endDate ASC nad aktivním poolem)
                        └─► defaultSort(items)        # poslední záchrana, vždy něco vrátí
```

Implementačně: `try { personalized } catch/empty { … }` → vždy doplní do `N` položek.

### 10.2 Confidence blend

`α` (§6.3) a `γ` (§7.2) — řídký profil nikdy neprodukuje nesmysl, protože se automaticky míchá s populací/contentem.

### 10.3 Omezené (saturující) signály + clamp outlierů

`sat()` + tvrdé capy + aktivní-čas dwell + práh hoveru. Žádný jednotlivý event nemůže profil "přestřelit". Background tab / usnulý telefon nepřičítá.

### 10.4 Diverzita (anti-filter-bubble) — MMR

Aby doporučení nebylo 10× tentýž vůz. **Maximal Marginal Relevance** při výběru top-N:

```
MMR: vyber c, který maximalizuje
     λ · final(v, c)  −  (1 − λ) · max_{j ∈ vybrané} contentSim(c, j)
```

Plus tvrdé **capy per klíč** (max 2 položky/značku, max 3/kategorii). Chrání i proti degenerovanému profilu (uživatel co viděl jen jeden vůz).

### 10.5 Explorace (ε-greedy)

Rezervuj **ε ≈ 15 %** slotů pro **populární-ale-neviděné** / čerstvě přidané položky. Řeší:

- **cold-start položek** (nový inzerát dostane zobrazení, jinak by ho popularita nikdy nevynesla),
- **feedback loop** popularity (bohatí nebohatnou donekonečna),
- **svěžest profilu** (objevování mimo dosavadní bublinu).

ε se servíruje deterministicky podle hashe `vid` (stabilní per návštěvník, ne náhoda za běh → reprodukovatelné).

### 10.6 Anti-bot / abuse

`enforceRateLimit` na `/api/track`, idempotence přes `eventId`, heuristiky nemožného chování (prokliky rychlejší než člověk, absurdní objem eventů/min) → drop. Boti neotráví profily ani popularitu.

### 10.7 Kill-switch a staleness

- **Feature flag `RECO_ENABLED`** (pattern `STRIPE_CARD_ENABLED`): vypnuto → plochy spadnou na popularitu/`defaultSort`, web jede dál.
- **Staleness guard:** batch crash-safe **oknem** (ne `last` pointerem — parita s `fio-payments`); když job dlouho neproběhl, serving jede z posledního dobrého snapshotu + alert. Žádné prázdné doporučení kvůli zaseknutému cronu.

### 10.8 Škálové pojistky

Cap velikosti profil-vektoru (top-K značek/modelů), cap eventů/visitor/okno, TTL prune. Profil ani matice nerostou neomezeně.

### 10.9 Privacy gate

Bez souhlasu → žádný sběr, žádné `vid`, **jen neosobní popularita**. Selhání směřuje k populaci, ne k chybě.

---

## 11. Collaborative vrstva (attribute-level co-engagement)

Doplňuje content tam, kde objevuje **netriviální souvislosti** — vazby, které atributová podobnost nevidí (lidé řešící BMW často řeší i Audi), ale **na úrovni atributů, ne jednotlivých položek**. Raw item↔item kosinus tu nefunguje: inventář je krátkověký a malý, takže než se na dvojici položek nasbírá stabilní překryv návštěvníků, položky skončí — a nové mají co-engagement nula z definice. Afinita nad atributy tenhle cold-start obchází a **přežívá obměnu inventáře**.

- Pracujeme nad **hodnotami atributů** dimenzí `d ∈ { make, bodyType, priceBand, category }` (volitelně klastry `make×bodyType×priceBand`). Pro dvojici hodnot `(k, l)` téže dimenze:

```
affinity_d(k, l) = cos( M[:,k], M[:,l] )    # M[v][k] = Σ_{i: i.d=k} E(v,i) — engagement v na hodnotě k
```

- Z položek `a`, `c` se afinita poskládá přes jejich atributy: `attrAffinity(a, c) = Σ_d ψ_d · affinity_d(a.d, c.d)`.
- Počítá batch, ukládá **top-K sousedních hodnot** na dimenzi do `attribute_affinity` (řádově desítky značek × top-K — malá hustá matice, ne řídká item×item).
- **Řídké na začátku** → `γ` (§7.2) drží váhu nízko, dokud nejsou data; s objemem roste. Hodnoty atributů (značky/segmenty) jsou stálé, takže se signál nezahazuje s každou skončenou aukcí.

---

## 12. Newsletter

Batch výběr pro odběratele (`users.newsletter = true`, validní e-mail):

1. **Kandidáti:** aktivní pool po tvrdé bráně §8 **+ newsletter horizont** (vyřaď aukce končící < 48 h po odeslání).
2. **Skóre:** `final(v, c)` bez kotvy (`rel = base`); nízko-datový/cold odběratel → `pop_seg` dle jeho `language`/země.
3. **Výběr:** top-N přes **MMR + capy per značka/kategorie** (§10.4).
4. **Novost:** preferuj neviděné/neoblíbené; zařaď "nové od posledního newsletteru".
5. **Explorační slot:** 1–2 čerstvé položky pro objevování (§10.5).
6. i18n: bloky doporučení lokalizované do `users.language` (skupina `newsletter:` ve všech 12 locales).

Výstup batch jobu = per-user seznam položek → předán e-mail senderu (mimo scope tohoto dokumentu).

---

## 13. Konfigurace a ladění

**Jeden zdroj pravdy** — `models/Recommendation.ts` (auto-import přes `imports.dirs: ['models']`, pattern `DEPOSIT_AMOUNTS`). Žádné magické konstanty ve výpočtu.

```ts
export const RECO_CONFIG = {
  signalWeights: { bidPlaced: 10, offerMade: 7, favoriteAdd: 6, share: 5, /* … */ },
  saturation:    { photoView: 8, dwellActive: 90, hoverMs: 5000, /* … */ },
  dwellClampSec: 180,
  hoverThresholdMs: 800,
  viewportDwellThresholdSec: 2,
  halfLifeDays: 21,          // H — decay profilu
  confidenceK: 5,            // K — α smoothing
  popPriorM: 20,             // m — Bayes shrink
  anchorBeta: 0.65,          // β — váha kotvy na detailu
  dimensionWeights: { categoryId: 1.0, make: 0.9, bodyType: 0.7, price: 0.7, /* …, color: 0.2 */ },
  explorationEpsilon: 0.15,  // ε
  mmrLambda: 0.7,            // λ — relevance vs diverzita
  withinSessionBoost: 0.25,  // δ — klientský within-session re-rank (§14)
  attrAffinityTopK: 20,      // top-K sousedních hodnot atributu pro cross-affinity (§11)
  perBrandCap: 2, perCategoryCap: 3,
  newsletterHorizonHours: 48,
  eventTtlDays: 365,
} as const
```

Runtime flagy v `nuxt.config`/`apphosting.yaml`: `RECO_ENABLED`, `CRON_SECRET` (sdílený), TTL/okno batch jobu.

**Evoluce vah:** priory výše jsou ruční odhad. Po nasbírání dat se `signalWeights` a `dimensionWeights` **učí** (logistická regrese / learning-to-rank nad "vedl rec k prokliku/konverzi?"). **Učící cíl je konverze (`bid`/`offer`), ne proklik** — proklik je jen diagnostika; optimalizace na CTR by vynesla "koukatelné" vozy místo "kupitelných". Trénink je **propensity-vážený** (IPS přes logované `position`/`propensity`, §4.1), aby se nezapekla pozice ve výpisu. Formule zůstává, mění se jen čísla.

---

## 14. Servírování a výkon

- **Kandidátní pool je malý** (aktivní položky, řádově stovky) → scoring `O(pool × dimenze)` je triviální in-memory.
- **Vše těžké je předpočítané** (profily, item features, popularita, attribute-afinita). Hot path serving = pár indexovaných čtení + lehký scoring.
- **Cache** servírovaného výsledku krátké TTL, klíč `(vid|userId, surface, anchorId)`.
- **SSR personalizace:** `vid` cookie chodí i se SSR requestem → detail "Podobné inzeráty" může být personalizované už server-side; přihlášený user se dohydratuje klientsky (token je client-only).
- **Within-session re-rank (klientsky):** batch profil je o krok pozadu za *aktuálním* sezením. Klient proto nad serverovým pořadím udělá **lehký re-rank z in-memory bufferu** (`useTracking`) — kandidáty shodné v atributech viděných právě teď (make/bodyType/priceBand z eventů sezení) mírně nadhodnotí (`withinSessionBoost` δ). Zachytí nejsilnější signál (co uživatel dělá *teď*) bez nové infry a bez čekání na další batch — jen reorder už načteného poolu, a navíc drží serverový výsledek **cacheovatelný** (personalizace „teď" je až na klientu).

**Endpointy:**

| Endpoint | Plocha | Auth |
| --- | --- | --- |
| `POST /api/track` | ingest | veřejné (vid), rate-limited |
| `GET /api/recommendations/item/:id` | detail "Podobné inzeráty" | veřejné, vid/userId volitelné |
| `GET /api/recommendations/home` (volitelně) | homepage rail | veřejné |
| `POST /api/cron/build-recommendations` | batch | `requireCronSecret` + `enforceRateLimit` |

`build-recommendations` zrcadlí `close-auctions`/`fio-payments`: Cloud Scheduler (europe-west4), Bearer `CRON_SECRET`, **idempotentní**, crash-safe okno. Cadence ~10–15 min (popularita/trend) — profily a attribute-afinita mohou jet řidčeji (hodinově).

---

## 15. Implementační fáze

| Fáze | Obsah | Hodnota |
| --- | --- | --- |
| **0 — Sběr** | `vid` + consent gate · `useTracking` · `POST /api/track` · `recommendation_events` (vč. `position`/`propensity` u impresí) | Tečou data; ověř neblokující transport |
| **1 — Popularita** | `item_features` + `popularity_segments` + `build-recommendations` cron · detail "Podobné inzeráty" z popularity + `contentSim` ke kotvě | Užitečné hned, bez profilu |
| **2 — Content personalizace** | `visitor_profiles` z eventů **+ existujících** favorites/bids/offers · `base()` + confidence blend | Personalizace |
| **3 — Collaborative + robustnost** | `attribute_affinity` (cross-attribute co-engagement) · MMR diverzita · ε-explorace | Kvalita + objevování |
| **4 — Newsletter** | per-user batch výběr + horizont + i18n bloky | Druhá plocha |
| **5 — Learning-to-rank** | váhy z **konverzí** (bid/offer), propensity-vážené · A/B vs popularita | Sebeučení |

Každá fáze stojí samostatně a degraduje na předchozí (fallback řetězec).

---

## 16. Evaluace a metriky

**Online (produkce):**

- **Severní hvězda = konverze** (rec → favorite/offer/bid); CTR doporučených karet a dwell po prokliku jsou **diagnostika**, ne optimalizační cíl.
- Newsletter open-rate / CTR.
- % doporučení personalizovaných vs fallback (zdraví pokrytí).

**Guardraily:**

- Diverzita (intra-list podobnost), katalogové pokrytí (% položek někdy doporučených), fallback rate, staleness batch jobu.

**Offline (před nasazením vah):**

- Replay eventů: hit-rate@K / recall@K / NDCG proti zadrženému budoucímu engagementu — **propensity-vážený (IPS přes logované `position`)**, jinak naivní replay nadhodnocuje položky, které stará politika náhodou ukazovala nahoře.

**A/B:** recommender vs čistá popularita; ladění `ε`, `β`, `λ`, `H`, vah.

---

## 17. Klíčový pseudokód

```text
# ---- HOT PATH (klient): neblokující sběr ----
on user_signal(type, itemId, value):
    buffer.push({ id: uuid(), vid, userId, sessionId, type, itemId,
                  categoryId, value, occurredAt: now() })       # O(1), žádné čekání
on (interval | visibility=hidden | pagehide | buffer.full):
    navigator.sendBeacon('/api/track', drain(buffer))           # fire & forget

# ---- INGEST (server) ----
POST /api/track:
    requireConsentVid(); enforceRateLimit()
    insertIgnoreOnConflict(recommendation_events, batch)         # idempotent (PK id)
    return 204                                                   # žádný výpočet

# ---- BATCH (cron, idempotentní, crash-safe okno) ----
POST /api/cron/build-recommendations:
    requireCronSecret(); enforceRateLimit()
    events = recommendation_events ∪ derive(favoriteIds, bids, contactMessages)
    for v in visitors:
        E = {}                                                   # engagement per item
        for e in events[v]:
            E[e.itemId] += weight(e.type) · transform(e) · decay(age(e))
        E[i] *= returnMult(v, i);  E = clampNonNeg(E)
        profile[v] = { features: weightedCentroid(items, E),     # §6 distribuce + μ/σ (váženo E)
                       nEff: decayedCount(i: E[i] > 0),           # evidence = počet distinct položek, NE ΣE
                       alpha: nEff/(nEff+K) }
        upsert(visitor_profiles, profile[v])
    upsert(item_features, popularity + trend + quality + vector)  # §9, §6.x
    upsert(attribute_affinity, topK(cosineCols(M_attr)))          # §11 — kosinus nad atributy, ne item×item
    upsert(popularity_segments, rankActive(per segment))          # §9.3
    prune(recommendation_events older than TTL)

# ---- SERVING (detail) ----
GET /api/recommendations/item/:id:
    if !RECO_ENABLED: return popularityFallback()
    try:
        a = item(:id); A = activeValidPool() \ exclusions(v, a)   # §8 tvrdá brána
        prof = visitor_profiles[vid ?? userId]                    # může chybět
        scored = for c in A:
            rel  = anchor ? β·sim(a,c) + (1−β)·base(v,c) : base(v,c)
            final = w_rel·rel + w_trend·trend(c) + w_qual·quality(c) + w_fresh·fresh(c)
        ranked = mmrSelect(scored, λ, perBrandCap, perCategoryCap) # §10.4
        ranked = injectExploration(ranked, ε, hash(vid))          # §10.5
        return topN(ranked) ?? fallbackChain()                    # §10.1
    catch:
        return fallbackChain()                                    # nikdy nespadne k uživateli

# ---- CLIENT RE-RANK (within-session, nad serverovým pořadím) ----
on recommendations_received(ranked):                              # §14
    seen = attrs(sessionBuffer)            # make/bodyType/priceBand viděné TEĎ (in-memory)
    reorder ranked by: serverScore(c) · (1 + δ · attrMatch(c, seen))   # lehký boost, jen reorder
    # žádný server roundtrip; zachytí aktuální záměr a drží server-výsledek cacheovatelný

base(v, c):                                                       # §7.1
    return α(v)·personal(v, c) + (1 − α(v))·pop_seg(c)
```

---

## 18. Shrnutí (rozhodnutí v kostce)

| Otázka | Rozhodnutí |
| --- | --- |
| Typ algoritmu | Hybridní: content-based ⊕ collaborative (attribute-level co-engagement) ⊕ popularity, spojené confidence blendem |
| Signály → skóre | Vážený součet saturovaných signálů × time decay (`E(v,i)`); priory v configu, později učené z **konverzí** (bid/offer, propensity-vážené) |
| Pohyb kurzoru bez kliknutí | `card_hover_dwell` (desktop, práh 800 ms) + `card_viewport_dwell` (mobil, IntersectionObserver) |
| Studený start ("průměr") | `α=0` → Bayesovsky shrunk popularita, podmíněná segmentem (kategorie/země/jazyk), který známe i bez profilu |
| Neblokující sběr | `sendBeacon`/keepalive, batch buffer, throttle, append-only ingest (204), agregace mimo request |
| Aukční specifika | Tvrdá brána validity (jen aktivní/neprodané) + kontext-závislá svěžest (urgence on-site, horizont v newsletteru) |
| Robustnost | Fallback řetězec · confidence blend · saturace · MMR diverzita · ε-explorace · anti-bot · kill-switch · staleness guard |
| Soukromí (GDPR) | Sběr až po `cookies-consent`, pseudonymní `vid`, TTL, merge-on-login, právo na výmaz |
| Integrace | Mirror cron patternu, nové tabulky v Kysely stylu, config v `models/`, plochy = detail + newsletter |
```

Nový soubor: `docs/recommendation-algorithm.md`.

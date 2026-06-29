# 🌌 Antigravity Vector-Tree (Absolutní Deep Inventory + Frontend/UI Mapování)

Tento dokument je kompletním výsledkem hloubkového výzkumu (Deep Research & Inventory). Mapuje sloučení masivních ekosystémů **garaaage-auction** a **hozan-taher** pod jednu sémantickou střechu stroje Antigravity (`spine/`). 

Jedná se o **nejdetailnější mapu**, která zachycuje transformaci starého monolitického Express serveru, obrovského Go backendu (Privacy Gateway) **A PŘEDEVŠÍM klientských front-endů (React/Vue UI)** do sémantických os struktury Vector-Tree. Samotný `auction24` již částečně tuto strukturu používal ve své složce `features/` (obsahující `demand`, `platform`, `sale`, `supply`).

## 🌳 Sémantický strom (Exhaustivní UI+Backend+DB mapa)

```text
antigravity/
├── package.json                         (Sloučené Node závislosti a linter pravidla)
├── pnpm-workspace.yaml                  (Mapující platformy, API a frontendy do jednoho buildu)
├── tsconfig.json                        (Společný TypeScript kompilátor pro absolutní typovou bezpečnost)
│
└── spine/                               [SÉMANTICKÉ JÁDRO ANTIGRAVITY ENGINE]
    ├── vektor.json                      (Kořenový manifest)
    │
    ├── supply/                          [OSA: HODNOTA A RING] (Původ: auction24)
    │   ├── vektor.json                  ("promise": "Co prodáváme, stojí za přihození.")
    │   ├── market/
    │   │   ├── auction-items/           (Správa aukčních listingů)
    │   │   │   ├── models/Item.ts       (Schéma vozu, historie, výbava)
    │   │   │   ├── repos/itemRepo.ts    (Kysely dotazy: getActiveAuctions, softDelete)
    │   │   │   ├── api/items/           (Nitro API - live.get.ts, sold.get.ts)
    │   │   │   └── ui/                  (UI z hozan-taher a auction24)
    │   │   │       ├── auctions.vue     (Z auction24/pages)
    │   │   │       ├── sold.vue         (Z auction24/pages)
    │   │   │       ├── ItemCard.vue
    │   │   │       └── Vozidla.jsx      (Z hozan-taher operátorského panelu)
    │   │   └── bidding/                 (Příhozy a real-time aukce)
    │   │       ├── models/Bid.ts        (Záznam příhozu, čas, částka)
    │   │       └── ui/
    │   │           └── buy-now.vue      (Z auction24/pages)
    │   └── asset/
    │       ├── vehicle-vin/             (Dekodéry VIN)
    │       │   ├── models/VehicleSpecs.ts
    │       │   └── ui/VehicleCapturePanel.jsx (Z hozan-taher panelu)
    │       └── media-upload/            (Repozitáře fotek)
    │           ├── repos/uploadRepo.ts  (Integrace s Cloud Storage / CDN)
    │           └── api/uploads.post.ts  (Upload fotek z administrace)
    │
    ├── sale/                            [OSA: PENÍZE A TRANSAKCE] (Původ: auction24)
    │   ├── vektor.json                  ("promise": "Co se vydraží, to se i zaplatí.")
    │   ├── checkout/
    │   │   ├── invoicing/               (Daňové doklady a faktury po výhře)
    │   │   │   ├── models/Invoice.ts
    │   │   │   └── repos/invoiceRepo.ts
    │   │   └── deposit-billing/         (Správa vratných kaucí pro přístup k aukci)
    │   │       ├── models/Deposit.ts    (Stav blokace peněz na kartě)
    │   │       ├── repos/depositRepo.ts
    │   │       └── api/deposit/         (Integrace Stripe platební brány - checkout.post.ts)
    │   ├── settlement/
    │   │   └── sale-settlement/         (Dokončení prodeje a vypořádání)
    │   │       └── api/admin/reconciliation/ 
    │   └── support/
    │       └── disputes-complaints/     (Reklamační řízení)
    │           ├── models/Dispute.ts    (Žurnál neshod)
    │           └── api/admin/disputes/
    │
    ├── demand/                          [OSA: NÁBOR A ZDROJE LEADŮ] (Původ: hozan-taher + auction24)
    │   ├── vektor.json                  ("promise": "Seznam klientů a firem je čistý a ověřený.")
    │   ├── acquisition/
    │   │   ├── scrapers/                (Playwright Node.js workery pod src/queue a src/util)
    │   │   ├── ares-source/             (Stažení IČO a obratů)
    │   │   ├── firmy-cz/                (Parsování katalogů)
    │   │   └── contacts/                (Evidence a segmentace firem - B2B/B2C klienti)
    │   │       ├── models/Contact.ts
    │   │       ├── server-routes/       (Přesunuté express routy: contacts.js, companies.js)
    │   │       └── ui/                  (UI z hozan-taher)
    │   │           ├── Kontakty.jsx     
    │   │           ├── Firmy.jsx        
    │   │           ├── Crm.jsx
    │   │           └── TopTargets.jsx
    │   ├── user-acquisition/
    │   │   ├── saved-search/            (Hlídací psi vozidel z auction24)
    │   │   │   ├── repos/savedSearchRepo.ts
    │   │   │   └── ui/favorites.vue     (Z auction24/pages)
    │   │   └── registration/
    │   │       └── ui/sign/             (Nuxt Auth flow z auction24)
    │   └── inbound/
    │       └── inbox-orchestrator/      (Čte IMAP schránky a páruje e-maily)
    │           ├── server-routes/       (replies.js, threads.js)
    │           └── ui/
    │               ├── Odpovedi.jsx     (Z hozan-taher operátorského panelu)
    │               └── ChatThread.jsx
    │
    ├── engine/                          [OSA: VÝSTUP A AUTOMATIZACE]
    │   ├── outreach/                    (Doručování komunikace do světa)
    │   │   ├── campaigns/               (Kampaně, sekvence)
    │   │   │   ├── server-routes/       (campaigns.js, runPreflight.js)
    │   │   │   └── ui/
    │   │   │       ├── Kampane.jsx      (Z hozan-taher React app)
    │   │   │       ├── KampanCreate.jsx
    │   │   │       └── KampanDetail.jsx
    │   │   ├── mailboxes/               (SMTP účty, rotace)
    │   │   │   ├── server-routes/       (mailboxes.js)
    │   │   │   └── ui/Schranky.jsx      (Z hozan-taher React app)
    │   │   └── content-render/          (Spintax, Liquid tagy)
    │   │       └── ui/Sablony.jsx       (Z hozan-taher React app)
    │   ├── intelligence/
    │   │   ├── anti-trace-relay/        (Go služba pro maskování HTTP egress metadat - wgsocks)
    │   │   │   └── ui/Anonymita.jsx     (Z hozan-taher React app)
    │   │   └── reco-builder/            (Cron/AI Engine z auction24 pro sekci 'Podobné')
    │   │       └── ui/compare.vue
    │   └── automation/
    │       ├── worker/                  (Sdílený Node.js Worker pro BullMQ)
    │       ├── worker-pdf/              (Tvorba PDF pro faktury a smlouvy)
    │       └── llm-runner/              (Brána pro OpenAI/Ollama inference)
    │
    └── platform/                        [OSA: PALUBA, APLIKACE A PRÁVO]
        ├── vektor.json                  ("promise": "Vše jde spustit a ovládat z paluby.")
        │
        ├── compliance/                  (Společná právní a bezpečnostní obrana)
        │   ├── privacy-gateway/         (Masivní Go Backend pro consent a logy z hozan-taher)
        │   │   ├── cmd/privacy-gateway/ (Spustitelná Go Binárka)
        │   │   └── internal/            (Jádro mikroslužby: audit, auth, filestore, httpapi...)
        │   ├── suppression/             (Blacklisty a odhlášené domény)
        │   │   └── ui/DedupGuard.jsx
        │   ├── dsr/                     (Výmazy dat - Data Subject Requests)
        │   └── unsub-token/             (Kryptografické generování /odhlásit odkazů)
        │
        ├── security/
        │   ├── auth/                    (Společné modely a loginy Firebase)
        │   │   ├── repos/apiTokenRepo.ts
        │   │   └── ui/LoginPage.jsx     (Z hozan-taher React app)
        │   └── protection/              (Rate-limitery, WAF, proxy hlídači)
        │       └── ui/Kvalita.jsx       (Z hozan-taher React app)
        │
        ├── ui/
        │   ├── dashboard-core/          (Sada komponent, barvy, fonty)
        │   │   ├── AppShell.jsx
        │   │   ├── ActionRail.jsx
        │   │   └── app-*.css            (Velké množství CSS: app-home.css, app-schranky.css)
        │   └── analytics/
        │       └── ui/Analytika.jsx     (Z hozan-taher React app)
        │
        ├── integration/
        │   ├── mcp/                     (Model Context Protocol pro AI agenty jako Jules)
        │   └── mail-lab-api/            (Mock SMTP / Docker Mail Lab pro vývojáře)
        │
        └── applications/                [KLIENTSKÉ VSTUPNÍ BODY / APP BUNDLERY]
            │
            ├── garaaage-auction/        (Nuxt Frontend B2B/B2C Portál)
            │   ├── vektor.json          ("type": "application-entrypoint")
            │   ├── app.vue              (Root layout aukčního systému)
            │   └── nuxt.config.ts       (Kompiluje UI a API přímo z domén výše)
            │
            ├── outreach-dashboard/      (React+Vite Operátorská paluba pro administraci)
            │   ├── vektor.json          ("type": "application-entrypoint")
            │   ├── index.html           (Vstupní bod Vite)
            │   └── vite.config.ts       (Kompiluje React komponenty typu `Kampane.jsx` ze sdílených os)
            │
            └── outreach-extension/      (Browser Plugin pro LinkedIn Scraping)
                └── src/background.js    (Servisní worker)

---

## 🤖 Vrstva autonomního řízení a údržby (Jules AI & Cybernetic Governor)
Architektura není jen pasivní strom souborů, ale živý ekosystém spravovaný umělou inteligencí. Z předchozích session (včetně 100x Proof-of-Concept experimentu) byla definována tato plně automatizovaná údržbová a řídící vrstva:

### 1. The Night Watch (Noční Hlídka) - Inkrementální TDD
**Jules** (Autonomní agent, `src/jules.ts`) má za úkol automaticky dosáhnout 100% Test Coverage napříč celým stromem `spine/`:
- Běží jako asynchronní **Cron Job** každou noc (např. přes GitHub Actions `npm run ag:jules`).
- Skript najde uzly s logikou bez testů (`facets.logic > 0 && facets.tests === 0`).
- Provede dávkové zpracování (batched TDD), přes Vercel AI SDK nebo OpenAI/Anthropic nageneruje chybějící `vitest` unit/E2E testy.
- **Auto-healing:** Pokud testy selžou (např. kvůli importům), Jules aktivuje Heuristic Healer a mockuje závislosti tak dlouho, dokud test neprojde. Následně uzamkne manifest `vektor.json` a vytvoří PR.

### 2. Cybernetic Governor (Strážce CI/CD)
Tento systém brání degradaci struktury Vector-Tree stroje:
- **Pull Request Hooks:** Místo běžného lintování spouští CI pipeline příkaz `npm run ag:audit`. Pokud vývojář manuálně vytvořil složku bez manifestu nebo rozbil linky, merge je zablokován.
- **Auto-Healing v PR:** Governor aktivuje Julese, který chybu analyzuje a drift v manifestech sám automaticky opraví a commitne zpět.

### 3. Paměť a Autonomní Release Management
Vývojář se nemusí starat o changelogy:
- Jules denně skenuje automatický log změn (`.vektor/diary/`).
- Příkaz `npm run release` s využitím AI vyhodnotí deník a autonomně rozhodne o sémantickém verzování (Major/Minor/Patch).
- Automaticky se aktualizuje topologická mapa projektu v `docs/reference/topology-map.md`.

### 4. AI "Lift & Shift" Karantény (Produkční refaktoring)
Aplikace `auction24` a `hozan-taher` jsou migrovány postupně a autonomně pomocí příkazu `ag:migrate`:
- Jules použije "Fuzzy Metadata Router" pro analýzu zdrojových souborů.
- Zavolá MCP nástroj `antigravity_create_node` a vygeneruje čistý cíl ve `spine/`.
- Přepíše starý kód do nové typově bezpečné formy, přidá testy a do `vektor.json` zapíše původ (`"origin": "legacy"`).
- Odevzdá výsledek jako hotový Pull Request.

Tímto spojením (fyzický kód v osách + Jules jako udržovatel) vzniká skutečný **Antigravity Engine**, kde se kód sám léčí, testuje a rozšiřuje.

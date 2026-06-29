# Antigravity Business Spine Monorepo

Toto je primární monorepo, postavené na architektuře **Antigravity Vector-Tree Engine**. Namísto tradičního technického dělení složek převádí Antigravity kódovou základnu do **fyzické vektorové databáze**, která sémanticky mapuje byznysové procesy (Velkou Pětku).

## 🏢 Struktura Repozitáře

Repozitář je striktně rozdělen pro udržení 100% architektonické čistoty:

- **`/src/` (Kognitivní Mozek & Engine):** Autonomní orchestrace obou hemisfér (Arbitrage Miner, Shadow Broker) a zdrojové kódy Antigravity CLI.
- **`/spine/` (Byznysová Páteř):** Srdce repozitáře. Zde sídlí 100 % sdílené byznysové logiky (`demand`, `supply`, `acquisition`, `outreach`, `sale`, `compliance`, `platform`). Žádná izolace.
- **`/frontiers/` (Hranice / Aplikace):** Tenké klientské a backendové brány (marketplace-web, operator-console, daemoni), které do sebe natahují logiku ze Spine, ale samy žádnou neobsahují.

---

## 🚀 Hlavní myšlenka (The Concept)
Základním stavebním kamenem je uzel (Node), který mapuje konkrétní byznysový děj (tzv. Story Axis / PC1 - např. `sale` nebo `supply`).
Každý uzel je tvořen složkou obsahující soubor `vektor.json`. Tento manifest propojuje **Dense files** (lokálně co-lokovaný kód, např. UI komponenty) s **Links** (frameworkově vázaný kód jinde v repozitáři, na který ukazují "magické komentáře").

Vzniká tak hybridní graf, který obchází striktní omezení stromových struktur (boundary misses) a umožňuje bezpečně mapovat "many-to-many" závislosti.

## 🧠 Sémantický Strom (The Ultimate View)
Celá architektura funguje jako jeden živý organismus rozdělený do sémantických vrstev. Každá vrstva vyžaduje vlastní přístup a specifickou testovací metodiku:

```text
Antigravity Vector-Tree [The Ultimate View]
├── 📚 LORE (Dokumentace a Znalostní Báze)
│   └── docs/                          [ Reference, AI instrukce, ADR a plány migrace ]
├── 🏛️ CORE (Zákon a Ochrana)
│   └── spine/domain/core-types [ Zod Runtime Validátory ]
├── 🌍 BODY (I/O a Tržiště)
│   ├── [ Network Mocks ] ── frontiers (Sběrače z cizích webů)
│   ├── [ Vitest Mocks  ] ── spine/supply & spine/demand (Katalog a Poptávka)
│   └── [ Playwright    ] ── apps/marketplace-web (Fronta pro kupce)
├── 🧠 BRAIN (Abstrakce, Učení a Rozhodování)
│   ├── [ VCR Kazety ] ───── spine/engine/learn (LLM kompilátory HTML)
│   ├── [ Redis Mocks ] ──── spine/engine/automation (Symphony fronta a Workeři)
│   └── [ Data Heuristika ]  spine/engine/intelligence (Arbitrage Miner)
└── 🦾 HANDS (Exekuce, Zápis a Peníze)
    ├── [ Webhook Mocks ] ── spine/sale (Stripe billing a settlement)
    ├── [ SMTP Sandboxy ] ── spine/outreach (Automatizovaný cold-mailing)
    └── [ Unit Testy ] ───── spine/engine/drive (Shadow Broker — automatické dealy)
```

---

## ⚙️ Architektura (6 Pilířů)

Antigravity Engine se skládá z 6 autonomních subsystémů:

1. **Unified Vector Engine (Read & Context)**
   Algoritmicky prohledává strukturu do šířky (Graph BFS). Pokud AI agent potřebuje upravit uzel A, engine mu kromě uzlu A do kontextového okna automaticky přibalí i propojený uzel B (díky definovaným hranám). Také řeší "Rollup state" (šíření technologického dluhu ze spodních uzlů nahoru).
2. **Cybernetic Governor (Drift Detection, Healing & Hard Compress)**
   Váš hlídač a léčitel. Skenuje AST a vyhledává architektonický drift. Našel v kódu import uzlu, který chybí v `vektor.json`? Detekoval smazaný soubor nebo "osiřelý" reverzní link? Automaticky opraví importy (Contract Drift), provede Auto-Faceting a v režimu `--compress` navíc fyzicky a bezpečně maže starý osiřelý kód. Žádný technologický dluh.
3. **Transactional Refactoring (Write & Mutation)**
   Přejmenování domén a přesun složek způsobují motýlí efekt. Tento engine využívá `git mv` a kaskádově patchuje jak reverzní linky (magic komentáře v kódu), tak cizí `vektor.json` manifesty. Refaktoring je proveden bezpečně v jedné transakci.
4. **Genesis Scaffolder (Creation)**
   Zapomeňte na manuální tvorbu složek. Generátor z cesty odvodí byznys doménu (PC1), založí složky, vloží `vektor.json` s patřičným "pending" stavem a automaticky vygeneruje backendové šablony (tzv. Framework-pinned stubs) s připravenými reverzními linky.
5. **Fuzzy Metadata Router (Search)**
   Nevíte přesné ID uzlu? Engine disponuje ultra-rychlým sémantickým vyhledávačem. Zadáním intentu (např. "faktury") prohledá tagy, PC1 a ID uzlů a vrátí pravděpodobnostní seznam shod bez nutnosti stahovat pomalé ML embedding modely.
6. **Autonomous Diary Manager (Memory & Logging)**
   Nativní vývojářský deník začleněný přímo do vektorového stromu (`.vektor/diary`). MCP Server a CLI automaticky zaznamenávají akce (scaffolding, refactoring, healing) s kontextem ovlivněných uzlů. Poskytuje tak trvalou operační paměť repozitáře.

---

## 🧠 Model Context Protocol (AI Integrace)

To nejdůležitější: Antigravity nebyl postaven jen pro lidi. Obsahuje nativní **MCP Server (Model Context Protocol)**. 
Jakýkoliv AI agent si může s Antigravity otevřít `stdio` rouru a získat nativní Tools (nástroje) zabudované přímo do svého mozku:
- `antigravity_resolve_node`
- `antigravity_audit_drift`
- `antigravity_rename_node`
- `antigravity_create_node`
- `antigravity_search_nodes`
- `antigravity_project_overview`

Repozitář už není mrtvý kód, ale živý organický systém, se kterým AI přímo hovoří.

---

## 🛠 Instalace a Použití

### 🤖 Autonomní Agenti (Jules) a CI/CD Automatizace
Projekt je plně připraven na spolupráci s asynchronními agenty (např. Google Jules) a disponuje moderní automatizační pipeline:

1. **Lokální Git Hooks (Husky + lint-staged)**: 
   - Kód je při každém commitu automaticky zformátován (Prettier) a zkontrolován linterem (ESLint).
   - Zároveň běží extrémně přísný Cybernetic Governor (`audit --heal`). Ten odhalí nejen driftované linky, ale díky **Orphan Scanneru** okamžitě zablokuje commit, pokud objeví fyzické soubory ve `spine/`, které nejsou zmapované ve `vektor.json`, nebo zkopírované legacy složky. Architektonický drift je tímto natvrdo znemožněn a nutí vývojáře i AI agenty k použití CLI.
2. **Railway CI/CD a Notifikace**: 
   - Repozitář je nasazován přímo přes Railway platformu (GitHub Actions byly odstraněny pro úsporu minut).
   - Railway běží v cyklu: `Testy (Vitest)` ➔ `Kompilace (TSC)` ➔ `Audit (Drift)` ➔ `Notifikace na Telegram`.
3. **Automatické generování Verzování a Changelogu**:
   - Spuštěním příkazu `npm run release` systém sám přečte `diary.md`, vygeneruje `CHANGELOG.md`, zvedne verzi projektu (Semantic Versioning) a commitne Git Tag.

```bash
# Instalace závislostí
npm install

# Zkompilování a ověření (Build & Audit)
npm run build

# Spuštění unit testů celého enginu
npm run test
```

### CLI Příkazy

**Založení nového uzlu (Scaffold)**
```bash
node dist/index.js create <nodeId> <cesta>
# Příklad: node dist/index.js create invoice-gen sale/money/invoice-gen
```

**Sémantické vyhledávání intentu**
```bash
node dist/index.js search "faktury"
```

**Získání kontextové bubliny (LLM Bubble)**
```bash
node dist/index.js resolve sale-settlement
```

**Generování mapy architektury (ARCHITECTURE.md pro AI agenty)**
```bash
node dist/index.js map
```

**Audit driftu a Self-Healing**
```bash
node dist/index.js audit --heal
```

**Bezpečný refaktoring / Přejmenování**
```bash
node dist/index.js rename sale-settlement new-settlement sale/new-settlement
```

**Spuštění MCP Serveru pro AI Agenta**
```bash
node dist/index.js mcp
```

**Zápis záznamu do autonomního deníčku**
```bash
node dist/index.js diary log "Byl proveden zásadní refaktor platební brány pro lepší oddělení PC1."
```

---

## 📄 Struktura `vektor.json`

Příklad manifestu, který leží v každém uzlu:
```json
{
  "id": "sale-settlement",
  "story_axis": "sale",
  "state": "pending",
  "origin": "auction24",
  "tags": ["penize", "vyuctovani", "backend"],
  "facets": {
    "ui": ["./SettlementWizard.vue"]
  },
  "edges": ["deposit-billing"]
}
```

*V backendových souborech (mimo tento adresář) musí být uvozen magický komentář `// @vektor-link: sale-settlement`, aby Governor propojil obousměrný graf.*

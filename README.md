# Antigravity Vector-Tree Engine

Antigravity je revoluční architektura a CLI nástroj pro správu rozsáhlých repozitářů. Namísto tradičního technického dělení složek (MVC, FSD) převádí Antigravity vaši kódovou základnu do **fyzické vektorové databáze**. Samotná struktura adresářů funguje jako sémantický HNSW index optimalizovaný jak pro vývojáře, tak pro AI agenty (Octavius, Claude, Cursor).

## 🚀 Hlavní myšlenka (The Concept)
Základním stavebním kamenem je uzel (Node), který mapuje konkrétní byznysový děj (tzv. Story Axis / PC1 - např. `sale` nebo `supply`).
Každý uzel je tvořen složkou obsahující soubor `vektor.json`. Tento manifest propojuje **Dense files** (lokálně co-lokovaný kód, např. UI komponenty) s **Links** (frameworkově vázaný kód jinde v repozitáři, na který ukazují "magické komentáře").

Vzniká tak hybridní graf, který obchází striktní omezení stromových struktur (boundary misses) a umožňuje bezpečně mapovat "many-to-many" závislosti.

---

## ⚙️ Architektura (5 Pilířů)

Antigravity Engine se skládá z 5 autonomních subsystémů:

1. **Unified Vector Engine (Read & Context)**
   Algoritmicky prohledává strukturu do šířky (Graph BFS). Pokud AI agent potřebuje upravit uzel A, engine mu kromě uzlu A do kontextového okna automaticky přibalí i propojený uzel B (díky definovaným hranám). Také řeší "Rollup state" (šíření technologického dluhu ze spodních uzlů nahoru).
2. **Cybernetic Governor (Drift Detection & Healing)**
   Váš hlídač a léčitel. Skenuje AST a vyhledává architektonický drift. Našel v kódu import uzlu, který chybí v `vektor.json`? Detekoval smazaný soubor nebo "osiřelý" reverzní link? Nejenže na to upozorní, ale v režimu `--heal` strom **automaticky opraví**.
3. **Transactional Refactoring (Write & Mutation)**
   Přejmenování domén a přesun složek způsobují motýlí efekt. Tento engine využívá `git mv` a kaskádově patchuje jak reverzní linky (magic komentáře v kódu), tak cizí `vektor.json` manifesty. Refaktoring je proveden bezpečně v jedné transakci.
4. **Genesis Scaffolder (Creation)**
   Zapomeňte na manuální tvorbu složek. Generátor z cesty odvodí byznys doménu (PC1), založí složky, vloží `vektor.json` s patřičným "pending" stavem a automaticky vygeneruje backendové šablony (tzv. Framework-pinned stubs) s připravenými reverzními linky.
5. **Fuzzy Metadata Router (Search)**
   Nevíte přesné ID uzlu? Engine disponuje ultra-rychlým sémantickým vyhledávačem. Zadáním intentu (např. "faktury") prohledá tagy, PC1 a ID uzlů a vrátí pravděpodobnostní seznam shod bez nutnosti stahovat pomalé ML embedding modely.

---

## 🧠 Model Context Protocol (AI Integrace)

To nejdůležitější: Antigravity nebyl postaven jen pro lidi. Obsahuje nativní **MCP Server (Model Context Protocol)**. 
Jakýkoliv AI agent si může s Antigravity otevřít `stdio` rouru a získat nativní Tools (nástroje) zabudované přímo do svého mozku:
- `antigravity_resolve_node`
- `antigravity_audit_drift`
- `antigravity_rename_node`
- `antigravity_create_node`
- `antigravity_search_nodes`

Repozitář už není mrtvý kód, ale živý organický systém, se kterým AI přímo hovoří.

---

## 🛠 Instalace a Použití

```bash
# Zkompilování
npm install
npm run build
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

---

## 📄 Struktura `vektor.json`

Příklad manifestu, který leží v každém uzlu:
```json
{
  "id": "sale-settlement",
  "story_axis": "sale",
  "state": "pending",
  "tags": ["penize", "vyuctovani", "backend"],
  "facets": {
    "ui": ["./SettlementWizard.vue"]
  },
  "edges": ["deposit-billing"]
}
```

*V backendových souborech (mimo tento adresář) musí být uvozen magický komentář `// @vektor-link: sale-settlement`, aby Governor propojil obousměrný graf.*

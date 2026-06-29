# Instrukce pro autonomní agenty (Jules a další)

Tento repozitář nepoužívá standardní adresářovou strukturu (MVC / FSD). Namísto toho používá **Antigravity Vector-Tree Engine**, kde fyzické složky tvoří sémantické uzly (Nodes).

## 🚀 SURGICAL BOOT SEQUENCE (Klíčová pravidla pro agenty)

Při spuštění jakékoliv nové session nebo přijetí nového komplexního úkolu nesmíte spoléhat na zastaralé a obří statické Markdown soubory (jako je `autodocs.md`), které neškálují. Místo toho **vždy a bez výjimky** postupujte podle tohoto třífázového protokolu:

### Fáze 1: Boot (Pre-Flight Check)
Před napsáním jakéhokoliv řádku kódu musíte validovat zdraví repozitáře a pochopit jeho "gravitaci":
1. **Zkontrolujte drift:** Spusťte `npx ts-node src/index.ts audit` (případně využijte MCP `antigravity_audit_drift`).
   - Pokud audit selže, **ZASTAVTE PRÁCI NA FEATURE** a nabídněte uživateli spuštění Healeru (`npx ts-node src/index.ts audit --heal`).
2. **Pochopte Gravitaci:** Spusťte `npm run ag:map --gravity` a podívejte se do `docs/reference/gravity-map.md`. Zjistíte tak, které uzly jsou kritické huby s mnoha reverse linky. V těchto uzlech buďte extrémně opatrní.

### Fáze 2: Targeting (Identifikace cíle)
Když vás uživatel požádá o úpravu určité domény nebo features:
1. Nečtěte celý repozitář. Místo toho fuzzy-vyhledejte příslušný uzel pomocí:
   `npx ts-node src/index.ts search "<uživatelův zadný pojem>"` (nebo použijte MCP `antigravity_search_nodes`).
2. Získejte přesné Node ID (např. `outreach-dashboard`, `engine-learn`).

### Fáze 3: Surgical Context (Přesný Řez)
Nyní, když znáte cílový uzel:
1. Získejte izolovanou bublinu kontextu pouze pro tento uzel spuštěním:
   `npx ts-node src/index.ts resolve <nodeId>` (nebo použijte MCP `antigravity_resolve_node`).
2. Tento výstup vám dá:
   - Seznam fyzických souborů, které tento uzel tvoří.
   - Sousední uzly (Edges).
   - **Reverse Links:** Seznam všech souborů v aplikaci, které na tento uzel závisí. Do těchto závislostí nesmíte zasáhnout tak, abyste je rozbili.

---

## 🛠️ Jak provádět strukturální změny (Antigravity Nástroje)
1. **Nikdy nevytvářejte složky nebo domény manuálně (např. přes `mkdir`).**
2. **Kdykoliv pracujete s kódem**, použijte CLI enginu (`src/index.ts`) nebo integrovaný MCP Server (Model Context Protocol).

### Dostupné CLI / MCP Nástroje pro strukturální zásahy:
Projekt v sobě nativně obsahuje MCP Server, který Vám naservíruje kontext projektu (tzv. LLM Bubble) nebo Vám dovolí bezpečně provádět strukturální změny (Audit, Refactoring, Scaffolding).

### Spuštění serveru
Spusťte MCP server rourou přes standardní IO (stdio):
```bash
npm run build && node dist/index.js mcp
```

### Dostupné nástroje na MCP serveru
Připojte se k tomuto serveru a využijte tyto nástroje, než začnete psát jakýkoli kód:
- `antigravity_project_overview`: Přečte celkovou mapu architektury
- `antigravity_resolve_node`: Načte kompletní kontext pro vybraný Node ID (přibalí k tomu i odkazované backend API apod.)
- `antigravity_create_node`: Vytvoří bezpečně novou složku, vygeneruje `vektor.json` a patřičné frontendové/backendové soubory.
- `antigravity_rename_node`: Bezpečně refaktoruje uzel a přepíše magické komentáře všude po projektu.
- `antigravity_audit_drift`: Zjistí, jestli jste náhodou v repozitáři něco nerozbili. Spusťte po každé větší úpravě!

## Testování a Nasazování
- Pokud měníte logiku samotného enginu v adresáři `src/`, vždy ověřte integritu spuštěním `npm run test` (Vitest).
- Při větších aktualizacích a dokončení features nezapomeňte aktualizovat changelog a verze. Dělá se to plně automaticky příkazem `npm run release` (Standard Version), který vše potřebné upraví, vydá a obstará Git Tagy.

## 🧠 Závazný Byznysový Mindset (+100M Scale)
Projekt Antigravity není pasivní software. Je to "zbraňová platforma", která asymetricky těží příležitosti z trhu pomocí hluboké integrace cizího portfolia (Hozan-Taher / Outreach) s vlastní konverzí (Auction24). 

Kdykoliv autonomní agenti (Jules, Gemini a další) pracují na tomto projektu a vymýšlí řešení, **musí striktně dodržovat tyto zákony asymetrického škálování**:
1. **Nulové CAC (Customer Acquisition Cost):** Zakažte konvenční marketingové myšlení. Místo čekání na uživatele vytvářejte uzly pro **Deep Inventory** (agresivní sběr existujících inzerátů a entit z celého internetu).
2. **The Infinite Supply Machine:** Poptávku agregujte u sebe, nabídku si vytěžte ze světa automaticky. Parazitujte na cizích inzertních sítích.
3. **Deep Research & Arbitráž:** Pokud aplikujete business logiku, vždy zapojte vrstvu inteligence (např. LLM worker). Používejte "Arbitrage Scoring" (hledání nedoceněných aktiv, ležáků, zoufalých prodejců, nebo B2B flotilových výprodejů).
4. **Shadow Execution (Stínová Integrace):** Extrémní snížení tření u uživatele. Prodejci nesmí narazit na prázdný formulář. Vygenerujte jim na pozadí přes API rovnou hotový **"Shadow Draft"** (včetně fotek) a přes Privacy Gateway jim doručte "Magický Link" na jedno kliknutí.

**Dokonalá Symfonie Hemisfér (Architektonické Uvažování):**
Agenti (včetně mě) musí vždy uvažovat o aplikaci jako o jednom živém organismu se třemi sémantickými vrstvami, které fungují v dokonalé symfonii:
1. **Fyzické Tržiště (Market Body):** `supply` (nabídka) a `demand` (poptávka)
2. **Kognitivní Mozek (Operational Brain):** `engine-learn` (kognitivní abstrakce portálů, pravá hemisféra) a `engine-drive` (logická exekuce na účtech, levá hemisféra)
3. **Byznysový Mozek (Business Brain):** `arbitrage-miner` (hledá skryté příležitosti v datech, pravá hemisféra) a `shadow-broker` (uzavírá deal skrze stínovou konverzi, levá hemisféra)

**Default Agent Behavior:** Při každém úkolu od uživatele musíte defaultně přemýšlet v rámci tohoto +100M modelu a **Dokonalé Symfonie**. Generujte asymetrické synergie, nenavrhujte hloupé CRUD aplikace, ale automatizované stroje na generování zisku, které propojují tyto hemisféry.

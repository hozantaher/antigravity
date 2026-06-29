# Instrukce pro autonomní agenty (Jules a další)

Tento repozitář nepoužívá standardní adresářovou strukturu (MVC / FSD). Namísto toho používá **Antigravity Vector-Tree Engine**, kde fyzické složky tvoří sémantické uzly (Nodes).

## Klíčová pravidla pro agenty
1. **Nikdy nevytvářejte složky nebo domény manuálně (např. přes `mkdir`).**
2. **Kdykoliv potřebujete pochopit systém**, podívejte se do `docs/reference/topology-map.md` a `docs/reference/autodocs.md`, kde se nachází aktuální mapa všech domén a funkcí.
3. **Kdykoliv pracujete s kódem**, použijte integrovaný MCP Server (Model Context Protocol).
4. **Při načtení konverzace / session (Maximum Context):** Vždy si nejdříve přečtěte `docs/reference/topology-map.md` a `docs/reference/autodocs.md`, abyste měli 100% přehled o struktuře před započetím jakékoliv práce.

## Jak používat nástroje Antigravity (MCP Server)
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

**Default Agent Behavior:** Při každém úkolu od uživatele musíte defaultně přemýšlet v rámci tohoto +100M modelu. Generujte asymetrické synergie, nenavrhujte hloupé CRUD aplikace, ale automatizované stroje na generování zisku.

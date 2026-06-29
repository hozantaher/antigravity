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

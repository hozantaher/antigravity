# Příručka k Antigravity CLI

Zde je seznam příkazů dostupných v našem CLI.

## `create` (Scaffolding)
Vytvoří nový sémantický uzel.
```bash
node dist/index.js create <nodeId> <path>
# Příklad: node dist/index.js create new-invoice sale/checkout/new-invoice
```

## `audit`
Zkontroluje kódovou základnu na existenci architektonického driftu (nepovolené importy, rozbité linky, osiřelé složky bez manifestu).
```bash
node dist/index.js audit
```

**Auto-healing:**
Přidejte flag `--heal` a governor se pokusí známé problémy automaticky opravit (např. doplnit chybějící vazby do manifestu).
```bash
node dist/index.js audit --heal
```

## `rename`
Bezpečný transakční refaktoring. Přejmenuje uzel a kaskádově opraví všechny manifesty a magické komentáře, které na něj odkazují.
```bash
node dist/index.js rename <oldId> <newId> <newPath>
```

## `search`
Sémantické vyhledávání pomocí fuzzy metadat.
```bash
node dist/index.js search "požadavek"
```

## `resolve`
Vyhledá a vrátí "LLM Bubble" – kompletní kontext jednoho uzlu a všech jeho sousedů. Ideální pro předání agentovi.
```bash
node dist/index.js resolve <nodeId>
```

## `mcp`
Spustí Model Context Protocol server na `stdio` rouru.
```bash
node dist/index.js mcp
```

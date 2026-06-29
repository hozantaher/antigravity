# `scripts/generate-terms.ts` — Generátor obchodních podmínek

## Co to dělá

Skript automaticky vytvoří **Obchodní podmínky pro Garaaage** jako `.docx` a `.md`. Využívá dvě AI fáze: Sonnet provede právní výzkum přes MCP server (zákony + judikatura), Opus z výzkumu napíše finální dokument.

## Spuštění

```bash
pnpm run generate:terms                        # obě fáze
pnpm run generate:terms -- --phase=research    # jen výzkum (~$1.60)
pnpm run generate:terms -- --phase=draft       # jen drafting z existujícího výzkumu (~$2)
```

## Konfigurace (`.env`)

```
ANTHROPIC_API_KEY=sk-ant-...
MCP_URL=http://localhost:3000          # garaaage-scrapers MCP server (HTTP mode)
MCP_SECRET=...                         # OAuth secret (volitelný)
OBSIDIAN_VAULT_PATH=/cesta/k/vaultu    # Obsidian vault s popisem Garaaage
```

## Architektura

```
                    ┌─────────────────────────────┐
                    │     Obsidian vault           │
                    │  L5-Business, L6-Regulation, │
                    │  L7-Identity + root MD files │
                    └─────────────┬───────────────┘
                                  │ readVaultFiles()
                                  ▼
┌──────────────────────────────────────────────────────────┐
│  FÁZE 1: Výzkum (Sonnet)                                │
│                                                          │
│  1a: Legislativa (max 7 iterací)                         │
│      query(source="esbirka", sql="...§2445...")          │
│      → sumarizace nálezů                                 │
│                                                          │
│  1b: Judikatura (max 6 iterací)                          │
│      query(source="judikaty", sql="...nsoud...")          │
│      → sumarizace nálezů                                 │
│                                                          │
│  Výstup: output/vyzkum.md (uloží se PŘED fází 2)        │
├──────────────────────────────────────────────────────────┤
│  FÁZE 2: Generování OP (Opus, streaming)                 │
│                                                          │
│  System prompt: vault kontext + pravidla terminologie     │
│  User message: výzkum z fáze 1 + instrukce               │
│  → 1 streaming call, max 32K output tokenů               │
│                                                          │
│  Výstup: output/obchodni-podminky.md + .docx             │
└──────────────────────────────────────────────────────────┘
```

## Klíčové moduly

| Soubor | Účel |
|---|---|
| `scripts/generate-terms.ts` | Orchestrace — vault reader, prompty, research loop, drafting, ukládání |
| `scripts/lib/mcp-client.ts` | HTTP MCP klient s OAuth (PKCE), JSON-RPC, SSE parsing |
| `scripts/lib/docx-writer.ts` | Markdown → .docx (Times New Roman, headings, seznamy, header/footer) |

## Jak funguje research loop

Každá sub-fáze (legislativa / judikatura) běží nezávisle s čistým kontextem:

1. Sonnet dostane tools + system prompt s DB schématy a příklady dotazů
2. Volá `query` tool v iteracích, výsledky se ukládají do `collectedData[]`
3. Pokud Sonnet sám skončí (`end_turn`) s dostatečně dlouhým textem (≥500 znaků) → hotovo
4. Jinak se spustí **separátní sumarizační call** — čistý kontext, jen sebraná raw data → strukturovaný souhrn

Separátní sumarizace řeší problém, kdy Sonnet po mnoha tool calls měl příliš velký kontext a produkoval 50–80 znakové "souhrny".

## Proč dva modely

| | Sonnet | Opus |
|---|---|---|
| Fáze | Research (tool calls) | Drafting (1 call) |
| Proč | Levný ($3/M in), dobrý v tool use | Kvalitní právní čeština, konzistentní 13-sekční výstup |
| Iterací | Až 13 (7+6) | 1 (streaming) |

## Výstupy

```
output/
├── vyzkum.md              # meziprodukt — souhrn legislativy + judikatury
├── obchodni-podminky.md   # finální OP v markdownu
└── obchodni-podminky.docx # formátovaný Word dokument
```

## MCP server

Skript se připojuje k jednomu MCP serveru (`pnpm run mcp:remote`), který obsluhuje obě databáze:
- `source="esbirka"` → tabulka `acts` (zákony, plné texty)
- `source="judikaty"` → tabulka `decisions` (soudní rozhodnutí, **použitelná data jen z `nsoud`**)

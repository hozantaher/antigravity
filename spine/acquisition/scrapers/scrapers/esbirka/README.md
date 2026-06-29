# e-Sbírka Scraper

Scraper for Czech legislation from [e-Sbírka](https://www.e-sbirka.cz) — the sole official electronic publication of Czech law since 1.1.2024. Downloads full texts, metadata, and amendment relationships for all currently valid legal acts.

## Data Sources

| Source | What | URL |
|--------|------|-----|
| SPARQL endpoint | Act enumeration (~33k acts) | `opendata.eselpoint.cz/sparql` |
| sbr-cache REST API | Metadata, full text (XHTML fragments), relationships | `www.e-sbirka.cz/sbr-cache/` |

All APIs are unauthenticated and free to use. No API key needed.

### Collections

| Code | Name | Acts |
|------|------|------|
| `sb` | Sbírka zákonů (Collection of Laws) | ~31,000 |
| `sm` | Sbírka mezinárodních smluv (International Treaties) | ~2,300 |

Acts include laws (zákony), decrees (vyhlášky), government regulations (nařízení vlády), and other legal instruments. Some acts use letter-prefixed numbers (`n1/1960 Sb.` for regulations, `o1/2000 Sb.` for measures).

## Usage

```bash
# Full pipeline — discover all acts, then download texts
pnpm run scrape:esbirka -- --phase=all

# Discovery only — enumerate acts via SPARQL + fetch metadata
pnpm run scrape:esbirka -- --phase=discovery

# Detail only — download full texts for already-discovered acts
pnpm run scrape:esbirka -- --phase=detail

# Limit to specific collection
pnpm run scrape:esbirka -- --collection=sb     # Only Sbírka zákonů
pnpm run scrape:esbirka -- --collection=sm     # Only international treaties

# Test with a few acts
pnpm run scrape:esbirka -- --phase=discovery --limit=100
pnpm run scrape:esbirka -- --phase=detail --limit=10

# Tune performance
pnpm run scrape:esbirka -- --delay=100 --concurrency=10
```

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--phase` | `all` | `all`, `discovery`, or `detail` |
| `--collection` | `all` | `sb`, `sm`, or `all` |
| `--concurrency` | `5` | Parallel workers |
| `--delay` | `200` | Base delay between requests (ms) |
| `--max-retries` | `3` | Retry attempts for failed requests |
| `--limit` | `0` | Max acts to process (0 = unlimited) |
| `--db` | `data/esbirka.db` | SQLite database path |

## Two-Phase Pipeline

### Phase 1: Discovery

1. **SPARQL query** enumerates all acts in each collection (one query per collection, returns ~31k/~2k results)
2. **Metadata fetch** for each act via `GET /sbr-cache/dokumenty-sbirky/{eli}` — retrieves title, act type, validity dates, and `typZneni`
3. **Filter**: only acts with `typZneni=AKTUALNI` (currently valid) are inserted into the database

The SPARQL vocabulary uses Czech diacritics (`slovník.gov.cz/datový/sbírka/pojem/`) and requires `xsd:string` typed literals for filtering (Virtuoso SPARQL engine quirk).

### Phase 2: Detail

For each pending act:

1. **Fragments** — `GET /sbr-cache/dokumenty-sbirky/{eli}/fragmenty?cisloStranky={n}` — paginated XHTML fragments (the API returns HTTP 400 for out-of-range pages). Fragments are assembled into the full text.
2. **Relationships** — `GET /sbr-cache/dokumenty-sbirky/{eli}/souvislosti` — amendment chains (MENI, JE_MENEN, RUSI, ODKAZUJE...)
3. **Metadata** — refetched for the `raw_metadata_json` field

## Database Schema

Output: `data/esbirka.db` (SQLite, WAL mode)

### `urls` — scraping state per act

| Column | Type | Description |
|--------|------|-------------|
| `eli` | TEXT UNIQUE | ELI identifier, e.g. `/eli/cz/sb/2012/89` |
| `citace` | TEXT | Citation, e.g. `89/2012 Sb.` |
| `cislo` | TEXT | Act number (may have letter prefix: `n1`, `o5`) |
| `rok` | INTEGER | Year |
| `sbirka` | TEXT | Collection code: `sb` or `sm` |
| `nazev` | TEXT | Full title |
| `typ_aktu` | TEXT | Act type code (e.g. `PRAVPRED`) |
| `typ_zneni` | TEXT | `AKTUALNI` (only current acts are stored) |
| `datum_platnosti` | TEXT | Effective date (ISO) |
| `dokument_base_id` | INTEGER | Internal ID for PDF download |
| `status` | TEXT | `pending` / `scraped` / `failed` / `gone` |
| `attempts` | INTEGER | Fetch attempt count |

### `acts` — full extracted data

| Column | Type | Description |
|--------|------|-------------|
| `eli` | TEXT UNIQUE | ELI identifier |
| `citace` | TEXT | Citation |
| `nazev` | TEXT | Full title |
| `typ_aktu` | TEXT | Act type code |
| `typ_zneni` | TEXT | Version type |
| `datum_platnosti` | TEXT | Effective date |
| `full_text` | TEXT | Assembled XHTML from all fragments |
| `fragment_count` | INTEGER | Number of XHTML fragments |
| `relationships_json` | TEXT | JSON: `[{typ, pocet, dokumenty: [{citace, nazev, stav, url}]}]` |
| `raw_metadata_json` | TEXT | Full sbr-cache metadata response |
| `scraped_at` | TEXT | Timestamp |

### `scrape_runs` — execution history

Tracks each scraper run with phase, timestamps, counts, and status (`running`/`completed`/`interrupted`).

## ELI Identifiers

Acts use [European Legislation Identifiers](https://eur-lex.europa.eu/eli-register/about.html):

- Sbírka zákonů: `/eli/cz/sb/{year}/{number}` (e.g. `/eli/cz/sb/2012/89` for the Civil Code)
- Mezinárodní smlouvy: `/eli/cz/sm/{year}/{number}`
- Letter-prefixed: `/eli/cz/sb/{year}/n{number}` or `/eli/cz/sb/{year}/o{number}`

## Relationship Types

The `relationships_json` field contains an array with these relationship types:

| Type | Meaning |
|------|---------|
| `MENI` | This act modifies... |
| `JE_MENEN` | This act is modified by... |
| `RUSI` | This act repeals... |
| `JE_RUSEN` | This act is repealed by... |
| `ODKAZUJE` | This act references... |
| `JE_ODKAZOVAN` | This act is referenced by... |

Note: the `dokumentySbirky` array in relationships may be truncated — `pocet` gives the true total count.

## Architecture

```
scrapers/esbirka/
├── types.ts        # TypeScript interfaces (config, DB rows, API responses)
├── api.ts          # SPARQL client + sbr-cache REST client
├── db.ts           # SQLite schema + closure-based data access API
├── discovery.ts    # Phase 1: SPARQL enumeration → metadata fetch → DB insert
├── scraper.ts      # Phase 2: fragment assembly + relationship extraction
└── index.ts        # CLI entry point + phase orchestration
```

### Rate Limiting

Uses the shared adaptive rate limiter from `lib/utils.ts`:
- Backs off automatically on HTTP 429 responses (exponential increase up to 10x base delay)
- Recovers after 20 consecutive successes (reduces delay by 25%)
- Adds ±30% jitter for human-like request timing

### Querying the Database

```bash
# Count acts by collection
sqlite3 data/esbirka.db "SELECT sbirka, COUNT(*) FROM urls GROUP BY sbirka"

# List all currently valid laws
sqlite3 data/esbirka.db "SELECT citace, nazev FROM urls WHERE sbirka='sb' ORDER BY rok DESC, cislo"

# Find a specific law
sqlite3 data/esbirka.db "SELECT citace, nazev, datum_platnosti FROM urls WHERE citace LIKE '89/2012%'"

# Check scraping progress
sqlite3 data/esbirka.db "SELECT status, COUNT(*) FROM urls GROUP BY status"

# Get full text length of largest acts
sqlite3 data/esbirka.db "SELECT citace, nazev, fragment_count, length(full_text) as bytes FROM acts ORDER BY bytes DESC LIMIT 10"

# List what a specific law modifies
sqlite3 data/esbirka.db "SELECT relationships_json FROM acts WHERE citace='89/2012 Sb.'" | python3 -m json.tool
```

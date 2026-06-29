# garaaage-scrapers — Audit produkčních problémů

Analýza MCP serveru, desktop extension a podpůrných skriptů. Zaměření na bugy, bezpečnostní problémy a produkční rizika.

---

## 1. ~~In-memory OAuth state — ztráta při restartu serveru~~ ✅ OPRAVENO

**Soubor:** `mcp-server/auth.ts`
**Závažnost:** ~~Střední~~ Vyřešeno

**Oprava (e55c6e3 + 8ff9ba4):**
- OAuth state přesunut do Redis přes `AuthStore` interface (`createRedisStore` / `createMemoryStore`)
- Redis klíče s nativním TTL: auth codes 5 min, klienti 7 dní, tokeny 30 dní
- Automatický fallback na in-memory pokud `REDIS_URL` není nastavena nebo Redis nedostupný
- Extension retry logika nyní resetuje `cachedClient` při selhání → kompletní re-init flow

---

## 2. ~~Session memory leak v HTTP transportu~~ ✅ OPRAVENO

**Soubor:** `mcp-server/http.ts`
**Závažnost:** ~~Nízká–Střední~~ Vyřešeno

**Oprava (e55c6e3):**
- `transports` + `sessionLastSeen` nahrazeny jednou `sessions` Map s `{ transport, server, lastSeen }`
- Idle cleanup volá `server.close()` → řetězí přes `Protocol.close()` → `transport.close()` → zavře SSE streamy
- `transport.onclose` chainuje s Protocol handlerem místo jeho přepsání

---

## 3. ~~Race condition v desktop extension `remoteRpc`~~ ✅ OPRAVENO

**Soubor:** `desktop-extension/server/index.js`
**Závažnost:** ~~Střední~~ Vyřešeno

**Oprava:** Retry bloky nahrazeny single-flight `resetAndReconnect()` — první caller vytvoří reconnect promise, concurrent calleři se připojí ke stejnému promise místo spuštění paralelního `initRemote()`.

---

## 4. ~~Auth codes se nikdy nečistí (memory leak)~~ ✅ OPRAVENO

**Soubor:** `mcp-server/auth.ts`
**Závažnost:** ~~Nízká–Střední~~ Vyřešeno

**Oprava (e55c6e3):** Redis store používá nativní TTL (`EX 300`) — expired auth codes se automaticky smažou. In-memory fallback kontroluje `createdAt` při čtení.

---

## 5. Extension proxy cache bez TTL

**Soubor:** `desktop-extension/server/index.js`
**Závažnost:** Nízká

`responseCache` pro `get_schema` a `get_stats` nemá žádný TTL ani size limit. Po přidání nových dat do DB (nový scrape run) bude extension vracet zastaralá schémata a statistiky do restartu.

```javascript
const responseCache = new Map();
const CACHEABLE_TOOLS = new Set(['get_schema', 'get_stats']);
// Žádný TTL, žádný maxSize, žádné invalidace
```

**Doporučení:** Přidat TTL (např. 1 hodina) nebo timestamp-based invalidaci.

---

## 6. SQL injection vektor v `ftsSearch` filter

**Soubor:** `mcp-server/db.ts`
**Závažnost:** Nízká (ale code smell)

Funkce `ftsSearch` parsuje `filter` parametr regexem a vkládá název sloupce přímo do SQL:

```typescript
conditions.push(`t."${match[1]}" ${match[2]} ?`);
```

Regex `^(\w+)` zabrání většině útoků (povoluje jen `[a-zA-Z0-9_]`), a `tableColumns.includes(match[1])` slouží jako whitelist validace. Reálné riziko je minimální díky readonly DB + whitelist, ale je to defence-in-depth concern.

---

## 7. LIKE fallback filter handling nekonzistence

**Soubor:** `mcp-server/db.ts`
**Závažnost:** Nízká

V LIKE fallback větvi:

```typescript
const likeFilter = filterClause.replace(/t\./g, '');
```

Nahrazení `t.` odstraní table alias, ale pokud `filterClause` je prázdný (všechny conditions dropped), `filterParams` je také prázdný — konzistentní. Ale pokud filter obsahuje text `t.` v hodnotě (nepravděpodobné), nahrazení by poškodilo SQL.

---

## 8. `getStats` — `max(rowid)` != skutečný počet řádků

**Soubor:** `mcp-server/db.ts`
**Závažnost:** Nízká

```typescript
const row = source.db.prepare(`SELECT max(rowid) as count FROM "${name}"`).get();
```

Po DELETE operacích `max(rowid)` ≠ skutečný počet řádků. Pro scraper databáze kde se primárně insertuje to většinou funguje, ale po `markGone` + případném čištění by statistiky byly nepřesné. `sqlite_stat1` fallback je správný, ale vyžaduje předchozí `ANALYZE`.

**Doporučení:** Použít `COUNT(*)` s LIMIT timeout, nebo dokumentovat že jde o aproximaci.

---

## 10. Extension — malformovaná URL při relativním redirectu

**Soubor:** `desktop-extension/server/index.js`
**Závažnost:** Nízká

```javascript
const redirectUrl = location.startsWith('http') ? location : `http://localhost:9999${location}`;
```

Pokud server vrátí relativní redirect bez leading `/` (např. `callback?code=...`), URL bude malformovaná: `http://localhost:9999callback?code=...`.

**Doporučení:** Přidat `/` prefix: `http://localhost:9999/${location.replace(/^\//, '')}`.

---

## 11. FTS korupce při crash `compress-raw.ts` (KRITICKÉ)

**Soubor:** `scripts/compress-raw.ts`
**Závažnost:** Vysoká

Skript dropne FTS triggery, komprimuje data a pak je znovu vytvoří:

```typescript
// Drop
for (const t of triggers) {
  db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
}

// ... komprese (může trvat minuty) ...

// Re-create
for (const t of triggers) {
  db.exec(t.sql);
}
```

Pokud skript crashne, bude killnut, nebo dojde k výpadku proudu mezi drop a re-create, triggery zůstanou smazané. FTS index se při dalších insertech nebude aktualizovat — tichá korupce dat.

**Doporučení:** Použít `SAVEPOINT` / rollback, nebo uložit trigger SQL do souboru před dropem pro manuální recovery.

---

## 12. LIMIT bypass přes subquery

**Soubor:** `mcp-server/db.ts`
**Závažnost:** Nízká–Střední

```typescript
const hasLimit = /\bLIMIT\s+\d+/i.test(sqlNoComments);
```

Uživatel může obejít LIMIT detekci:

- `SELECT * FROM (SELECT * FROM decisions LIMIT 999999)` — regex detekuje LIMIT v subquery a nepřidá vnější
- `SELECT * FROM decisions WHERE id NOT IN (SELECT id FROM x LIMIT 5)` — regex detekuje LIMIT v subquery

To umožňuje extrakci více dat než je zamýšleno přes 100KB response cap, který pak musí fungovat jako poslední obrana.

**Doporučení:** Parsovat SQL AST, nebo vždy wrappovat dotaz jako `SELECT * FROM ({user_sql}) LIMIT {limit}`.

---

## 13. NSSoud scraper — chybějící retry-after na redirect response

**Soubor:** `scrapers/judikaty/sources/nssoud/scraper.ts`
**Závažnost:** Velmi nízká

Custom `fetchUtf16Page` vrací `retryAfter` z originální response, ale při `redirect: 'follow'` se `retry-after` header čte z finální response, ne z původní 429. V praxi NSSoud server nepoužívá redirecty na 429, takže to je pouze teoretický problém.

---

## 14. Chybějící ECLI index v produkční DB

**Soubory:** `mcp-server/db.ts`, `scripts/optimize-db.ts`
**Závažnost:** Střední

`getDecision` hledá přes `ecli = ?`, ale `optimize-db.ts` nepřidává ECLI index do `indexable` setu:

```typescript
const indexable = new Set([
  'source', 'citace', 'ico', 'firmy_id', 'category', 'brand',
  'location_country', 'address_locality', 'mobile_id', 'url_type',
  'eli', 'spisova_znacka', 'jednaci_cislo',
  // CHYBÍ: 'ecli'
]);
```

Scraper `judikaty/db.ts` sice vytváří `idx_decisions_ecli`, ale jen pro nové databáze. Pokud produkční DB byla vytvořena dřív a pak se jen spustil `optimize-db.ts`, ECLI index může chybět → full scan na 685K řádků.

**Doporučení:** Přidat `'ecli'` do `indexable` setu v `optimize-db.ts`.

---

## 15. `datum_zruseni` je vždy NULL — `get_law_context` hlásí všechno jako platné

**Soubory:** `mcp-server/db.ts`, `scrapers/esbirka/scraper.ts`
**Závažnost:** Nízká

Tool `get_law_context` zobrazuje `datum_zruseni`:

```typescript
text += row.datum_zruseni ? `**ZRUŠEN:** ${row.datum_zruseni}\n` : `**Stav:** platný\n`;
```

Ale `esbirka/scraper.ts` vždy nastavuje:

```typescript
datum_zruseni: undefined,  // nikdy se nenaplní
```

Discovery fáze filtruje `typZneni !== 'AKTUALNI'`, takže zrušené zákony se vůbec neukládají. Ale `datum_zruseni` by měl být buď odstraněn z výstupu, nebo správně naplněn z metadat API.

**Doporučení:** Buď plnit z `meta.datumZruseni` (pokud API poskytuje), nebo odstranit misleading "platný" status.

---

## Dříve reportované — opraveno v jiných commitech

### Chybějící indexy spisova_znacka, jednaci_cislo, citace ✅

**Oprava (e55c6e3):** Přidány do `scrapers/judikaty/db.ts` a `scrapers/esbirka/db.ts` v `createDb()`. Nové DB mají indexy automaticky, nezávisle na `optimize-db.ts`.

### snippet() na contentless FTS tabulce ✅

**Oprava (e55c6e3):** `ftsSearch()` detekuje contentless FTS (`content=''`) přes `sqlite_master` a staví query bez `snippet()`. Místo snippetu vrací placeholder. Zabraňuje LIKE fallbacku na 685k řádků.

### Extension notifications/initialized chybějící Accept header ✅

**Oprava (e55c6e3):** Přidán `Accept: application/json, text/event-stream` + response check.

### Extension stale cachedClient po server restartu ✅

**Oprava (8ff9ba4):** Všechny retry větve v `remoteRpc()` resetují `cachedClient = null`. Server `/oauth/approve` validuje existenci klienta.

---

## Shrnutí podle závažnosti

| Závažnost | # | Problémy |
|-----------|---|----------|
| **Vysoká** | 1 | #11 (FTS korupce při crash compress-raw) |
| **Střední** | 2 | #12 (LIMIT bypass), #14 (chybějící ECLI index) |
| **Nízká** | 6 | #5, #6, #7, #8, #10, #13, #15 |
| **Vyřešeno** | 7 | #1, #2, #3, #4, + indexy, contentless FTS, extension auth |

### Prioritní opravy pro produkci

1. **#11** — Wrap trigger drop/recreate do transaction nebo přidat recovery mechanismus
2. **#14** — Přidat `'ecli'` do optimize-db indexable setu

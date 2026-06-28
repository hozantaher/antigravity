# Runbook — Async Job Pattern (`runJob`)

> Vývojářský runbook pro `runJob` abstrakci v
> `features/platform/outreach-dashboard/src/lib/jobs.js`.
> Komplement k [`runbook-jobs-write-errors.md`](./runbook-jobs-write-errors.md),
> který pokrývá operátorský pohled; tento dokument popisuje, kdy a jak
> `runJob` použít při přidání nového endpointu.
>
> Souvisí s [ADR-001 — Outreach Dashboard Quality Primitives](../decisions/ADR-001-outreach-dashboard-quality-primitives.md).

## Co `runJob` dělá

`runJob` je thin async wrapper nad in-memory hashmapou, který zajišťuje:

1. Vytvoření job recordu (`createJob`) s unikátním ID.
2. Spuštění user-supplied async funkce na pozadí (fire-and-forget z pohledu HTTP requestu).
3. Mutaci job stavu (`pending` → `running` → `done` \| `error`) podle výsledku.
4. Expozici přes `GET /api/jobs/:id` polling endpoint.
5. TTL cleanup — 10 min po `finishedAt` job zmizí z mapy.

Kanonický tvar call-site v `server.js`:

```js
app.post('/api/mailboxes/bulk-check', async (req, res) => {
  const { ids } = req.body
  const job = createJob({ kind: 'bulk-check', input: { count: ids.length } })
  res.status(202).json({ jobId: job.id })

  runJob(job, async (ctx) => {
    const results = []
    for (let i = 0; i < ids.length; i++) {
      results.push(await checkOne(ids[i]))
      ctx.progress({ done: i + 1, total: ids.length })
    }
    return { results, summary: summarize(results) }
  })
})
```

Klient dostane `202 Accepted` s `jobId` okamžitě, pollluje `GET /api/jobs/:id` v 1–2 s intervalech, dokud `status ∈ {done, error}`.

## Kdy `runJob` **použít**

- Operace trvá **>5 sekund** v typickém případě.
- Operace má **měřitelný progress** (iterace přes N položek) — i když samotný progress není povinný, `done/total` velmi pomáhá debuggingu.
- HTTP request timeout (30 s v našem reverse-proxy) je nevyhovující — klient by viděl `504` i když job běží dál.
- Operace je **replay-safe** — duplicitní spuštění nevytvoří problém nad rámec plýtvání prací.
- Klient si umí poradit s 202 + polling (React hook `useJobStatus` nebo ekvivalentní).

Příklady, kde se `runJob` aktuálně používá:
- `POST /api/mailboxes/bulk-check` — SMTP/IMAP probe N mailboxů.
- `POST /api/mailboxes/import-csv` — parse + insert 100+ řádků.
- `POST /api/mailboxes/bulk-assign-proxy` — per-mailbox probe + DB write (migrace z 30 s timeoutu, W4 wave).

## Kdy `runJob` **NEpoužít**

- Operace **<2 s** v typickém případě — cena polling infrastruktury (2 extra RTT) je větší než benefit. Vrať data inline.
- Operace **vyžaduje transakci** kolem více kroků a partial failure je nepřijatelný. `runJob` nemá rollback. Pokud potřebuješ atomicitu, drž operaci v request-response a použij DB transakci.
- Operace **musí být persistentní přes restart BFF**. `runJob` je in-memory; restart = ztráta všech `pending`/`running` jobů bez auditu. Pro persistní queue použij `enrichment_jobs` tabulku + cron (viz `planRefreshJobs` v `server.js`).
- Operace **potřebuje více BFF instancí** (horizontal scale). Ring + hashmap jsou per-proces, žádná cross-instance routing. Dnes běžíme single-instance, ale při škálování bude `runJob` první věc k výměně (redis / DB queue).
- Operace **je spuštěná z cronu**, ne z uživatelského klienta. Cron nemá koho pollovat; loguj přímo nebo persistuj status do DB.
- **Destruktivní akce s vysokou cenou selhání** (mass delete, campaign send-trigger) — drž synchronně, aby klient viděl výsledek před dalším krokem. Async + polling zvyšuje risk "klikl dvakrát, spustilo dvakrát".

## Jak přidat nový async endpoint

### Krok 1 — definuj `kind` a `result` shape

Pojmenuj `kind` krátce a popisně (`bulk-check`, `import-csv`). Napiš (v commit body nebo TypeScript-style komentáři nad handlerem) očekávaný tvar `result`:

```js
/**
 * @typedef {Object} BulkCheckResult
 * @property {Array<{id: number, ok: boolean, reason?: string}>} results
 * @property {{total: number, healthy: number, broken: number}} summary
 */
```

Operátoři v [`runbook-jobs-write-errors.md`](./runbook-jobs-write-errors.md) tento shape čtou, takže musí být stabilní napříč verzemi. Breaking change = `kind` rename (`bulk-check` → `bulk-check-v2`), ne mutace stávajícího shapu.

### Krok 2 — zvol progress granularitu

- **Per-item progress** pro batch operace (`done = i + 1` v každé iteraci).
- **Milestone progress** pro multi-stage operace (`{stage: 'validating', done: 1, total: 3}`).
- **Žádný progress** pro monolitickou operaci, kterou nemá smysl rozdělit — klient vidí jen `running` → `done`.

Neuváděj `total`, pokud ho nemůžeš dopředu spočítat. `undefined` total je validní; klient zobrazí spinner místo progress baru.

### Krok 3 — handler

```js
app.post('/api/your-operation', authMiddleware, async (req, res) => {
  // 1. Validate input synchronně — fail fast
  const parsed = yourInputSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.flatten() })
  }

  // 2. Create job + return 202 + jobId
  const job = createJob({
    kind: 'your-operation',
    input: { /* minimal snapshot, nikdy secrets */ },
  })
  res.status(202).json({ ok: true, jobId: job.id })

  // 3. Run background — NIKDY neawait-uj před res.json
  runJob(job, async (ctx) => {
    // ... tvoje logika
    ctx.progress({ done, total })
    return { /* result shape */ }
  })
})
```

### Krok 4 — error handling uvnitř runneru

`runJob` chytí throw a markne `status=error` s `error.message`. **Ale:** částečná práce před throw zůstane v DB (žádný auto-rollback). Varianty:

- **Fail-fast:** throw hned, nechej `runJob` to zachytit. OK když nic nebylo zapsáno.
- **Partial results:** chytni per-item, akumuluj do `result.errors[]`, vrať normálně. Job skončí `done`, klient čte `result.errors`.
- **Smíšené:** throw na infrastruktural error (DB down, relay down), per-item akumuluj na business errors (invalid email, duplicate).

Preferuj druhou variantu pro batch — operátor vidí přesně, co failnulo.

### Krok 5 — DB writes jdou přes `dbMutate*`

Uvnitř runneru všechny `pool.query()` pro UPDATE/INSERT/DELETE **musí** jít přes `dbMutate` nebo `dbMutateDetached`, jinak silent failure zmizí v `.catch()` a operátor nemá jak zkorelovat. Viz ADR-001 primitiva tabulku.

```js
await dbMutate({
  label: 'your-operation.persist',
  target: 'outreach_X',
  op: 'UPDATE',
  fn: () => pool.query('UPDATE outreach_X SET ... WHERE id = $1', [id]),
})
```

### Krok 6 — frontend hook

Použij `useJobStatus(jobId)` (pokud existuje; jinak viz `useResource` 4-stavový pattern). Polluj 1–2 s dokud `status ∈ {done, error}`, pak stopni. Nezapomeň cleanup na unmount (jinak polling pokračuje po odchodu ze stránky).

## Checklist před commitem

- [ ] `kind` je stabilní string, zdokumentovaný v commitu nebo komentáři.
- [ ] `result` shape má typedef nebo JSDoc.
- [ ] Operace trvá >5 s nebo je jinak neslučitelná s request-response (viz "Kdy NEpoužít").
- [ ] Runner neobsahuje `pool.query()` mimo `dbMutate*` wrapper.
- [ ] Endpoint vrací `202` + `{jobId}`, ne `200` + data.
- [ ] Frontend si poradí s `status=error` (zobrazí `error.message`, ne silent fail).
- [ ] Pokud jde o destruktivní operaci, idempotence je zajištěná nebo dokumentovaná.
- [ ] Partial-failure cesta vrátí operátorovi `result.errors[]` + `result.ids[]` pro rollback.
- [ ] Unit test pro runner (mockni `pool`, ověř `progress` volání a shape `result`).
- [ ] Kontraktní test lifecycle `pending → running → done/error` (viz iniciativa T-Q03).

## Anti-patterns

- **`async handler` s `await longOperation()` a `res.json(result)` na konci** — to je přesně to, co `runJob` řeší. HTTP 30s timeout zkillne klienta, ale operace běží dál, klient nemá jak zjistit výsledek.
- **`setTimeout(() => { ... }, 0)` + `res.json({ok:true})`** — fire-and-forget bez trackování. Operátor nemá job ID, nemá status, nemá error. Nikdy.
- **Persistentní queue přes `runJob`** — `runJob` nepřežije restart. Pro trvalé joby použij DB tabulku (`enrichment_jobs`) + cron pick-up.
- **Velký `result.payload`** (>1 MB) — `result` je v heap paměti 10 min po finish. Pro velká data persistuj do DB / S3 a vrať `result: { downloadUrl: ... }`.
- **`runJob` v request handleru po `res.json`, ale před `await` completion** — neawaituj `runJob` samo; handler vrátí 202 okamžitě, runner běží na pozadí. Pokud handler awaituje, HTTP držíš do dokončení — mrtvý pattern.

## Rozšíření (follow-up, ne dnes)

- **Persistence:** přepsat `jobs.js` Map na Redis hash nebo PostgreSQL tabulku `bff_jobs`. Uživatel může pollovat po restartu BFF. Otevře to audit trail.
- **Cross-instance:** při horizontal scale BFF bude polling potřebovat sticky session nebo centralizovaný backend (redis). Dnes nemáme, `runJob` je explicitně single-instance.
- **Webhook místo polling:** klient se zaregistruje s callback URL, BFF pushne `POST` při finishu. Snižuje polling load, ale vyžaduje veřejnou klientskou URL — dnes nepraktické.
- **Cancellation:** `POST /api/jobs/:id/cancel` + `ctx.isCancelled()` kontrola v runner loopu. Zatím nepotřebujeme; přidat až bude reálný use-case.

## Související dokumenty

- [ADR-001 — Outreach Dashboard Quality Primitives](../decisions/ADR-001-outreach-dashboard-quality-primitives.md)
- [2026-04-21 Quality Refactor](../initiatives/2026-04-21-outreach-dashboard-quality-refactor.md)
- [`runbook-jobs-write-errors.md`](./runbook-jobs-write-errors.md) — operátorský pohled na stejné endpointy

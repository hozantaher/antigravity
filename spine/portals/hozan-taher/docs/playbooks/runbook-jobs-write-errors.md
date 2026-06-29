# Runbook — Jobs & Write-Errors Diagnostics

> Operátorský runbook pro tři diagnostické endpointy v BFF
> (`features/platform/outreach-dashboard/server.js`):
> `GET /api/jobs/:id`, `GET /api/jobs`, `GET /api/health/write-errors`.
>
> Souvisí s [ADR-001 — Outreach Dashboard Quality Primitives](../decisions/ADR-001-outreach-dashboard-quality-primitives.md)
> a iniciativou [2026-04-21 Quality Refactor](../initiatives/2026-04-21-outreach-dashboard-quality-refactor.md).

## Kdy tento runbook použít

- UI ukazuje spinner déle než 30 s (bulk-check, import-csv, assign-proxy).
- Operátor spustil bulk akci a chce vědět, co se stalo s každou položkou.
- Banner `/schrany` hlásí `N write failures za posledních 15 min`.
- Podezření, že DB write tiše padl (UI success, ale stav se nezměnil).
- Před eskalací na dev chat chceme přiložit konkrétní job ID + ring buffer snapshot.

## Endpoint overview

### `GET /api/jobs/:id`

Status jedné async operace. Vrací JSON envelope z `jobs.js`:

```json
{
  "id": "job_8f3a...",
  "kind": "bulk-check",
  "status": "running",
  "startedAt": "2026-04-21T09:12:03.441Z",
  "finishedAt": null,
  "progress": { "done": 42, "total": 120 },
  "result": null,
  "error": null
}
```

| Field | Význam |
|---|---|
| `kind` | Typ jobu (`bulk-check`, `import-csv`, `assign-proxy-bulk`, …) |
| `status` | `pending` → `running` → `done` \| `error` |
| `progress` | Volitelný `{done, total}` — jen u jobů, které reportují průběh |
| `result` | Populovat **až** po `status=done`. Shape per `kind` — viz scénáře níže |
| `error` | `{ message, stack?, code? }` — populovat **až** po `status=error` |

```sh
curl -s "http://localhost:3001/api/jobs/job_8f3a7b2c" | jq
```

### `GET /api/jobs`

Seznam posledních jobů (newest-first). Primárně pro debugging — UI obvykle ví job ID z POST response.

```json
{
  "jobs": [
    { "id": "job_8f3a...", "kind": "bulk-check", "status": "done",   "startedAt": "…", "finishedAt": "…" },
    { "id": "job_5c11...", "kind": "import-csv", "status": "running", "startedAt": "…", "finishedAt": null  }
  ]
}
```

Retention: in-memory hashmap, TTL **10 min** od `finishedAt`. Joby ve stavu `pending`/`running` se nikdy nemazají, dokud neskončí. Při restartu BFF se celá mapa ztratí — to je záměrné, viz Retention sekce.

```sh
curl -s "http://localhost:3001/api/jobs" | jq '.jobs[] | {id, kind, status}'
```

### `GET /api/health/write-errors`

Ring buffer z `dbMutate` / `dbMutateDetached`. Posledních **100** DB write failures napříč celým BFF procesem:

```json
{
  "count": 7,
  "entries": [
    {
      "at": "2026-04-21T09:14:22.118Z",
      "label": "mailbox.update-password",
      "target": "outreach_mailboxes",
      "op": "UPDATE",
      "code": "23514",
      "message": "new row for relation \"outreach_mailboxes\" violates check constraint \"password_non_empty\"",
      "detached": false
    }
  ]
}
```

| Field | Význam |
|---|---|
| `label` | Volné pole z call-site (`mailbox.update-password`, `watchdog.insert-event`, …) |
| `target` | Typicky tabulka / logická entita |
| `op` | `INSERT` \| `UPDATE` \| `DELETE` (volitelné) |
| `code` | SQLSTATE kód z PostgreSQL (`23514` check, `23505` unique, `23503` FK, …) |
| `detached` | `true` = `dbMutateDetached` (background, neshodilo request); `false` = `dbMutate` (HTTP path, klient viděl 500) |

```sh
curl -s "http://localhost:3001/api/health/write-errors" | jq '.entries[] | {label, code, message}'
```

## Typické scénáře

### 1. Bulk-check job visí ("running" dlouho)

**Symptom:** UI spinner >30 s, `GET /api/jobs/:id` vrací `status=running` bez posunu `progress`.

1. Zkontroluj `progress.done` / `progress.total` dvěma polly po 10 s:
   ```sh
   curl -s "http://localhost:3001/api/jobs/$JOB" | jq '.progress'
   sleep 10
   curl -s "http://localhost:3001/api/jobs/$JOB" | jq '.progress'
   ```
   - `done` roste → job žije, jen je pomalý (proxy latency, velký batch).
   - `done` stagnuje → pravděpodobně čeká na zablokovaný SMTP probe nebo DB lock.
2. `status=running` **neznamená "zdravý"**. Znamená jen "nebyl marked done/error". Pokud BFF proces spadl v průběhu, job tu zůstane `running` dokud někdo proces nezrestartuje (a pak zmizí). Watchdog jobu **neexistuje** — není timeout-killer.
3. Zkoreluj s BFF logy — hledej log řádky obsahující job ID nebo `kind` hodnotu.
4. Pokud job visí >10 min bez progress + neexistuje log hit → restart BFF. Job se ztratí (to je očekávané), klient musí spustit znovu.

**Kdy je `status=failed`:** job skončil s exception. `error.message` obsahuje důvod. `result` bude `null`. Částečná práce, která proběhla před selháním, **není rollbacknutá** — `runJob` nemá transakci. Pokud operace měnila data (např. bulk assign-proxy), podívej se do `/api/health/write-errors` za stejný čas — tam jsou konkrétní DB writes, co proběhly.

### 2. Import CSV — partial failure

**Symptom:** `import-csv` job skončil `status=done`, ale UI hlásí "47 z 120 se nepodařilo".

Shape `result` pro `import-csv`:

```json
{
  "inserted": 73,
  "ids": [1021, 1022, ...],
  "errors": [
    { "row": 4,  "reason": "invalid email format", "input": "foo@" },
    { "row": 17, "reason": "duplicate ičo", "input": "12345678" }
  ]
}
```

1. `result.ids` = **úspěšně vložené** primary keys. Použij pro cílený rollback (např. `DELETE FROM outreach_companies WHERE id = ANY($1)` když uživatel chce "zrušit celý import").
2. `result.errors[].row` je index v **původním CSV** (1-based včetně headeru) — operátor otevře soubor a vidí přesnou řádku.
3. Pokud `result.errors` obsahuje `reason` typu `"DB write failed"`, zkoreluj s `/api/health/write-errors` za stejný čas — najdeš SQLSTATE code (FK violation vs. check constraint vs. unique).
4. Po partial rollbacku **nespouštěj reimport téhož souboru celý** — duplikáty `ičo` budou failovat. Filtruj CSV podle `result.errors[].row` a reimportuj jen chybové řádky po opravě.

### 3. Write failures akumulují

**Symptom:** banner na `/schrany`: "12 write failures za posledních 15 min", nebo ring buffer `count > 0`.

1. Fetch buffer:
   ```sh
   curl -s "http://localhost:3001/api/health/write-errors" | jq '.entries | group_by(.label) | map({label: .[0].label, count: length, codes: map(.code) | unique})'
   ```
2. Typická klasifikace:
   - **`23505` (unique violation) + `label=watchdog.insert-heartbeat`** — dvě instance BFF běží současně, jedna je stará (zombie). Zkontroluj `ps | grep node`, kill starou PID.
   - **`23514` (check constraint)** — validation bug. Frontend nepushl validátor a pustil na backend špatná data. Zapiš do initiative log + oprav validátor v `src/lib/validators.js`.
   - **`23503` (FK violation)** — race condition: parent row smazán mezi read a write. Obvykle self-healing, pokud trvá → DB migrace nebo kaskáda chybí.
   - **`57014` (query canceled)** — DB statement timeout. Backend je pod load, PostgreSQL killnul dotaz. Zkontroluj Railway DB metrics.
3. `detached: true` failures **nezpůsobily HTTP 500** — UI klient nic neviděl. Typicky `watchdog_events`, `healing_log` inserts. Pokud `detached: false`, klient dostal 500 a viděl error toast (pokud frontend správně handluje `ok: false`).
4. Ring buffer **se neresetuje** dokud BFF neběží znovu. 100-entry cap znamená, že při burstu >100 ztrácíš nejstarší. Pokud potřebuješ delší historii, spusť snapshot cron (nebo `watch -n 60 curl ...`).

### 4. "Toast lhal" — UI success, DB prázdná

**Symptom:** operátor říká "klikl jsem save, viděl jsem Uloženo, ale hodnota se nezměnila".

1. Identifikuj čas akce (±30 s).
2. `curl /api/health/write-errors` a filtruj podle time window + `label` odpovídajícího akci (např. `mailbox.update-password`).
3. Pokud entry existuje → backend write padl, klient dostal 500, ale frontend zobrazil success toast (pre-W1 bug). Zapiš do `project_schrany_quality_debt.md` sekce "toast lies" a oprav v `wm/development`.
4. Pokud entry neexistuje → buď write proběhl (zkontroluj DB přímo), nebo call ani neproběhl (network error před BFF — Chrome devtools → Network tab).

## Escalation criteria

| Signál | Akce | Eskalace |
|---|---|---|
| Jeden visící `running` job | Restart BFF, klient retry | Ne |
| >3 visící `running` jobs paralelně | BFF heap check (`process.memoryUsage`) | **Ano** — může to znamenat leak |
| Ring buffer `count > 50` za 15 min | Zkontroluj DB connection pool + SQLSTATE distribuci | **Ano** pokud pokračuje druhé okno |
| `23503` FK violations opakovaně na stejný target | DB schema drift, chybějící migrace | **Ano** — dev chat + freeze writes do té doby |
| `57014` statement timeout | Railway metrics (CPU, connection count) | **Ano** pokud >5 entries |
| `import-csv` s `result.errors > result.inserted` | Pravděpodobně špatný CSV formát / bad mapping | Ne — operátor rollbackne podle `ids` |
| Bulk job `status=error` s `error.message` obsahujícím `ECONNREFUSED` | Proxy / anti-trace-relay down | **Ano** — relay výpadek, blokuje sending |

**Nepageuj**, pokud: jeden isolated failure, known pattern (check constraint po validator změně), job visí <5 min u bulk operace na >500 položek.

**Pageuj**, pokud: write failures akumulují napříč nesouvisejícími labels (DB připojení / pool issue), nebo jeden typ failure opakuje konzistentně (schema drift).

## Retention a limity

- **Jobs:** in-memory `Map` v `jobs.js`. TTL **10 min** od `finishedAt` (cleanup ticker v W4 inicitivě; aktuální implementace hotová, e2e test pending — viz iniciativa T-Q04). `pending`/`running` joby se nemazají TTL-em. Restart BFF = všechny joby ztraceny.
- **Write-errors ring buffer:** posledních **100 entries**, FIFO, per process. Cap je pevný (`100` v `dbMutate.js`). Restart = reset. Nepersisuje se do DB (rekurze: write failure do write_errors tabulky může failnout).
- **Paměťový odhad:** 100 entries × ~500 B = ~50 kB. Jobs mapa je unbounded na počet `pending+running`, ale v praxi <20 paralelně. Pokud heap stoupá bez odpovídajícího count — leak, viz escalation.

## Běžné omyly

- "Job je `done`, tak všechno proběhlo" — **ne**. `result.errors` u batch operací obsahuje partial failures. `status` reflektuje jen, že runner skončil bez exception.
- "Ring buffer je prázdný, tak DB je zdravá" — **ne**. Buffer drží jen failures, které prošly přes `dbMutate*`. Silent catches, které nebyly migrované (viz iniciativa W2 wave, hotovo 2026-04-21 pro prod path, ale legacy cesty v cronu mohou zbývat), nic neloggují.
- "Job ID mohu po hodinách odkazovat v ticket" — **ne**. Po 10 min od finish je pryč. Pro persistní audit použij BFF logy (Railway retention) nebo DB (`healing_log`).

## Související dokumenty

- [ADR-001 — Outreach Dashboard Quality Primitives](../decisions/ADR-001-outreach-dashboard-quality-primitives.md) — rationale pro primitiva
- [2026-04-21 Quality Refactor](../initiatives/2026-04-21-outreach-dashboard-quality-refactor.md) — wave plán migrace
- [`runbook-async-job-pattern.md`](./runbook-async-job-pattern.md) — jak přidat nový async endpoint
- [`BFF-SELF-HEALING-SPRINTS.md`](./BFF-SELF-HEALING-SPRINTS.md) — širší kontext BFF auto-recovery vrstev

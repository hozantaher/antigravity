# Sprint KT-A10 — Stáhneme 5 000 kontaktů z ARES + firmy.cz, aniž by nás to ban-listlo

> **Status:** Design draft 2026-04-30. Kód v tomto sprintu nevzniká, jen plán. Předchůdci: KT-A7 (proxy rotation), KT-A8 (block detection), KT-A9 (multi-source enrichment).

---

## 1. Aktuální stav

Dnes máme dvě možné cesty, jak naplnit `contacts` tabulku reálnými firmami z veřejných českých registrů, a obě jsou neúplné. **První cesta** je manuální import seedu — operátor připraví CSV se seznamem ICO + emailů, BFF endpoint `POST /api/contacts/import` to vloží do `outreach_contacts` a enrichment pipeline (KT-A9) doplní zbytek. Tato cesta funguje pro malé batche (50–200 kontaktů na výkupní kampaň 001), ale není scale-able. Pro kampaně s 5 000+ kontakty by operátor musel ručně sehnat seed CSV, což je v praxi blokující úkol.

**Druhá cesta** je TS scraper firmy.cz (`features/acquisition/scrapers/scrapers/firmy-cz/`), který běží na vlastním cronu a kontinuálně plní tabulku `firmy_cz_businesses`. Tahle tabulka má dnes ~1.08M řádků (per `features/acquisition/scrapers/CLAUDE.md`). Scraper je ale **read-only datový dump** — nepropisuje data do `outreach_contacts` (kampaňová tabulka), nemá filtraci podle NACE/segmentu, neumí říct „dej mi 5 000 stavebních firem v Praze, které ještě nemáme v outreach“. Operátor musí buď napsat ad-hoc SQL JOIN, nebo vyexportovat firmy.cz tabulku do CSV a re-importovat. Obojí je manuální a fragile.

ARES (`features/acquisition/contacts/ares/sync.go`) má **`SyncSubjects`** workflow pro batch sync (FetchSubject po jednotlivých ICO s rate-limit 1 req/s). To znamená 5 000 ICO = 83 minut wall-clock + 0 paralelizace (dnes je `WithRate(1)` v jediné goroutine). Po cestě může ARES dát 429 (KT-A8 ho detekuje a přepne na alt source dle KT-A7), ale celý batch nemá **resumability** — pokud worker spadne v půlce, ztratíme stav a začneme znova. Žádný checkpoint, žádná queue persistence.

Pro **kampaně typu „výkup techniky“ (Garaaage core use case)** potřebujeme rychle a opakovaně získat:

- Stavební a zemědělské firmy (NACE 41–43, 01, 02) → ICO + adresa z ARES.
- Filtrovat ty, které mají email (z firmy.cz JOIN přes ICO).
- Vyloučit ty, které jsou už v `outreach_contacts` (dedup na email + ICO).
- Vyloučit ty, které jsou v suppression UNION (`outreach_suppressions` + `suppression_list`).
- Output: kandidátní list v `outreach_contacts` se status=`new`, ready pro kampaň.

Tento workflow dnes neexistuje jako jeden krok. Musí se ručně poskládat ze tří částí.

## 2. Proč tento sprint

Kampaň výkupu techniky (master plán 2026-04-30) plánuje rolling acquisition: každý týden 500–1 000 nových kontaktů (po 0→1→5→20 staircase, který je v KT-A5/KT-A6, přijde přechod na **stable rollout 200/den** a pak **growth phase 1 000/den**). Bez backfill workflow musí operátor každý týden:

1. Otevřít firmy.cz v prohlížeči → vyfiltrovat NACE → exportovat → CSV.
2. Importovat CSV do BFF.
3. Spustit enrichment manuálně.
4. Verifikovat email validity (přes existing `company/email_verify.go`).
5. Vyloučit suppress UNION.

To je 2–3 hodiny manuální práce týdně. Cíl KT-A10 je tohle plně **automatizovat**: jeden BFF endpoint `POST /api/contacts/backfill` se segmentem (NACE, region, velikost) → background job → po 30 minutách operátor vidí v UI „doplněno 1 247 nových kontaktů, 53 duplicit, 12 v suppression“.

Tři reálné scénáře, které sprint řeší:

**Scénář první — bulk seed pro novou výkupní kampaň.** Operátor spouští kampaň „Výkup techniky 002 — zemědělství JM kraj“. Potřebuje 800 kontaktů NACE 01.x v Jihomoravském kraji. Dnes: ručně. Po KT-A10: `POST /api/contacts/backfill {nace_prefix:'01', region:'CZ064', limit:800}` → job ID → progress endpoint vrací 0/800 → 156/800 → 800/800. Žádná interakce.

**Scénář druhý — resume po crashi.** Backfill job běží, server restartuje (deploy nebo crash). Bez resumability začíná job znova z 0. S checkpoint persistencí (KT-A10) job pokračuje od bodu, kde skončil. Ztratí maximálně rozpracované items v batch (max 50).

**Scénář třetí — rate-limit-aware paralelismus.** ARES má 1 req/s limit. Pokud spustíme 5 paralelních fetch goroutines, budeme dostávat 429 hned. Single-thread = 5 000 fetches × 1s = 83 minut. Můžeme zrychlit přes **per-source rate limiting** + **source rotation**: KT-A7 nám dává tři zdroje (direct, mullvad, free-pool), každý má vlastní effective rate-limit. Pokud paralelizujeme přes zdroje (ne přes ICO), můžeme dosáhnout 3 req/s aggregate bez rate-limit hits. 5 000 / 3 = 28 minut. To je 3x speedup bez rizika ban.

**Reálný příklad scénáře, který KT-A10 řeší:**

> Pondělí 09:00, operátor otevře BFF UI „Backfill nových kontaktů“. Vybere segment: NACE 41-43 (stavebnictví), region: Praha + Středočeský kraj, velikost: 5–50 zaměstnanců, limit: 5 000. Klikne „Start“. BFF vytvoří `backfill_jobs` row s `status=running`, vrátí `job_id`.
>
> Background worker postupně:
> 1. Z `firmy_cz_businesses` SELECT 5 000 unique ICO matching segment → seed list.
> 2. Pro každý ICO paralelně (max 3 goroutines, jedna per egress source z KT-A7) volá ARES.
> 3. KT-A9 enrichment merguje ARES + firmy.cz data.
> 4. Validuje email přes `company/email_verify.go` (DNS-only mode pro rychlost).
> 5. Filtruje suppression UNION.
> 6. INSERT do `outreach_contacts` s status='new'.
> 7. Každých 50 kontaktů checkpoint do `backfill_jobs.checkpoint_offset`.
>
> 09:35 worker dokončí, BFF UI zobrazí: „doplněno 4 123 kontaktů, vyřazeno 587 (duplikát/suppress), 290 selhalo (ARES 404 nebo email-invalid).“ Operátor klikne „Spustit kampaň pro tento batch“ → kampaň 456 startuje.

Cíl sprintu je tedy **postavit resumable backfill worker** s rate-limit-aware paralelismem, dedup proti existující contacts table, a integraci na KT-A7/A8/A9.

## 3. Návrh

### 3.1 Datový model — `backfill_jobs` tabulka

Migrace 010, nová tabulka:

| Sloupec | Typ | Význam |
|---|---|---|
| `id` | bigserial | PK |
| `created_at` | timestamptz | čas vytvoření |
| `status` | text | `pending | running | paused | completed | failed` |
| `segment_filter_json` | jsonb | `{nace_prefix:'41', region:'CZ010', size_min:5, size_max:50}` |
| `total_target` | int | kolik kontaktů žádáme |
| `processed_count` | int | kolik jsme zpracovali (success + skip + fail) |
| `inserted_count` | int | kolik skutečně doplnilo do `outreach_contacts` |
| `skipped_dup_count` | int | duplicity |
| `skipped_suppress_count` | int | v suppression UNION |
| `failed_count` | int | ARES 404 / email invalid / enrichment fail |
| `checkpoint_offset` | int | poslední úspěšný offset v seed listu |
| `seed_query_hash` | text | hash query co generoval seed (pro resumability — pokud query změna, restart) |
| `last_heartbeat_at` | timestamptz | worker periodically updatuje, pro stale-detection |
| `error_message` | text | pokud failed, popis |

Důvod `seed_query_hash`: Pokud operátor změní filter mezi dvěma resume pokusy, seed list by byl jiný a checkpoint by lhal. Hash drží query stable.

### 3.2 Worker — fan-out přes source

Backfill worker je nový Go binary v `features/acquisition/contacts/cmd/backfill/main.go`. Spouští se buď jako **standalone container** (Railway service) nebo **embedded** v existujícím `outreach` orchestrátoru. Doporučuji standalone — jeden worker per worker container, scale-out triviální, izolace od hot-path sender.

Worker logika:

1. Vezmi pending job z queue (`SELECT * FROM backfill_jobs WHERE status='pending' FOR UPDATE SKIP LOCKED LIMIT 1`).
2. Status → `running`, poznamenat heartbeat.
3. Vygeneruj seed list ze `firmy_cz_businesses` podle `segment_filter_json`. Spočítej `seed_query_hash`.
4. Pokud `checkpoint_offset > 0` (resume), seek na offset.
5. Spusť **fan-out worker pool** s 3 goroutinemi (ne víc — viz rate-limit racionále). Každá goroutine běží přes svůj **fixní zdroj** z KT-A7:
   - Goroutine 1: vždy `direct`.
   - Goroutine 2: vždy `mullvad-wireproxy`.
   - Goroutine 3: vždy `free-pool` (rotuje uvnitř).
   Tím obejdeme problém „goroutiny si konkurují o stejný rate-limit“. Každý zdroj má svůj per-second limiter (ARES tolerantní k 1 req/s per IP, takže 3 různé IP = 3 req/s aggregate).
6. Worker pop-uje ICO z shared queue (channel), volá `enrichmentPipeline.Enrich(ico)` (KT-A9), filtruje suppression, INSERT contact.
7. Každých 50 zpracovaných ICO commit checkpoint: `UPDATE backfill_jobs SET checkpoint_offset=$1, processed_count=$2, ... WHERE id=$3`.
8. Heartbeat update každých 10 sekund.
9. Po dokončení status → `completed`, finální counters.

### 3.3 Rate-limit-aware design

Klíč k „nedostat ban“: **respektovat per-source rate-limit současně s fan-out paralelismem**. Konvence:

- `direct` source: 1 req/s pro ARES (existing default v `WithRate(1)`).
- `mullvad-wireproxy` source: 1 req/s pro ARES (Mullvad IP je stabilní, taky 1 IP).
- `free-pool` source: 2 req/s pro ARES (každý request jde přes jiný proxy IP, takže ARES vidí distribuovaný traffic).

Aggregate: ~4 req/s pro ARES = 5 000 / 4 = 21 minut. Pro firmy.cz (KT-A9 čte z DB cache, ne aktivně scrapuje), backfill worker neposílá traffic — jen SQL SELECT. Takže firmy.cz není bottleneck.

Pokud KT-A8 detekuje block na nějakém zdroji, KT-A7 ho dá do cooldownu, příslušná goroutine v worker poolu bude prostá (10 sec sleep loop check „je můj source healthy?“). Po cooldown resume. Worker pool tedy nemá fixní 3 paralelismus permanentně — degraduje gracefully na 2 nebo 1 podle health.

### 3.4 Dedup logika

Dedup proti existujícím datům má dvě úrovně:

**Pre-fetch dedup** (rychlý SQL filter před ARES voláním):

```sql
SELECT ico FROM firmy_cz_businesses
WHERE <segment_filter>
  AND ico NOT IN (SELECT ico FROM outreach_contacts)
  AND email NOT IN (SELECT email FROM outreach_suppressions UNION SELECT email FROM suppression_list)
LIMIT $1;
```

Tímto eliminujeme 80–90 % duplicit a suppress kontaktů ještě před voláním ARES (úspora API quota).

**Post-enrichment dedup** (po ARES + email verify):

- Před INSERT zkontroluj UNIQUE constraint na `(email)`. Pokud konflikt → skip + `skipped_dup_count++`.
- Pokud email matches suppression UNION (race condition — seznam se mohl změnit během fetche) → skip + `skipped_suppress_count++`.

UNION dotaz je v memory `project_two_suppression_tables.md` — single canonical pattern.

### 3.5 Resumability + idempotence

Resumability stavy:

- **Worker crash mid-batch** → `last_heartbeat_at` zastará (>2 min stale). Cron `features/acquisition/contacts/cmd/backfill/cron-cleanup.go` (stejný binary, jiný entry-point, nebo ad-hoc cron v BFF) detekuje stale running job, status → `pending`, worker po pickup pokračuje od `checkpoint_offset`.
- **Server restart** → status zůstává `running`, ale worker není. Stejné jako crash, cleanup cron vyřeší.
- **Manuální pause** → `POST /api/backfill/:id/pause` → status `paused`. Worker při pickup zkontroluje status; pokud `paused`, neudělá nic. Resume: `POST /api/backfill/:id/resume` → status `pending`, worker pickup.

Idempotence: každý INSERT do `outreach_contacts` jde přes `ON CONFLICT (email) DO NOTHING`. Tím re-run po crashi nezpůsobí duplikáty.

### 3.6 BFF integrace

Tři endpointy:

- `POST /api/contacts/backfill` — body `{nace_prefix, region, size_min, size_max, limit}`, vytvoří `backfill_jobs` row, vrátí `{job_id}`.
- `GET /api/contacts/backfill/:id` — vrátí stav (status, counters, ETA estimate).
- `POST /api/contacts/backfill/:id/pause` + `/resume` + `/cancel`.

UI: nový tab v `Companies.jsx` nebo `Contacts.jsx` (TBD per UX), formulář s segment fields, progress bar pro running joby, list completed jobů s counters.

### 3.7 Observability

- **Sentry breadcrumbs** per 100 zpracovaných kontaktů + per error.
- **Slog op konvence**: `contacts.backfill.start`, `contacts.backfill.checkpoint`, `contacts.backfill.complete`, `contacts.backfill.fail`.
- **Cron metrics**: `[cron] backfill_cleanup duration_ms=...` (BFF wrapper konvence per CLAUDE.md).
- **`backfill_jobs` view v BFF UI** s sortable list (latest first), counters, status badges.

## 4. Acceptance kritéria

- [ ] **`backfill_jobs` tabulka + migrace 010** — všechny sloupce dle 3.1, indexy na `(status, created_at DESC)` a `(last_heartbeat_at)` pro cleanup.
- [ ] **Backfill worker binary v `features/acquisition/contacts/cmd/backfill/`** — kompiluje samostatně, má `main.go`, `worker.go`, `cleanup.go`. Embed-able do orchestrátoru přes `Run(ctx)` API.
- [ ] **Fan-out přes 3 paralelní zdroje (KT-A7)** — worker spouští 3 goroutines, každá fixed source. Pokud zdroj v cooldownu, goroutine spí, ostatní pokračují.
- [ ] **Pre-fetch dedup eliminuje duplikáty + suppress před ARES voláním** — seed query JOIN-uje `outreach_contacts` + suppression UNION, šetří API quota o ~80 %.
- [ ] **Checkpoint každých 50 kontaktů + heartbeat každých 10s** — `UPDATE backfill_jobs SET checkpoint_offset, last_heartbeat_at`.
- [ ] **Cleanup cron detekuje stale running joby** — `last_heartbeat_at > 2 min stale` → status `pending` (re-pick).
- [ ] **Idempotentní INSERT** — `ON CONFLICT (email) DO NOTHING`, re-run po crashi nepřidá duplikáty.
- [ ] **Pause / resume / cancel API** — POST endpointy fungují, status transitions auditované.
- [ ] **`seed_query_hash` mismatch při resume → status `failed`** — pokud filter změn mezi pause a resume, hash se liší → worker odmítne pokračovat, status `failed` s `error_message='seed query changed'`.
- [ ] **BFF endpointy + UI tab** — `POST /api/contacts/backfill` + GET status + progress UI v `Contacts.jsx`.
- [ ] **Slog op + Sentry breadcrumbs** — `contacts.backfill.*` ops, breadcrumbs per 100 kontaktů, full Sentry capture na `failed` status.
- [ ] **Integration test: 100-kontakt backfill end-to-end** — sqlmock + mocked KT-A7 sources + mocked ARES, verifikuje counters, dedup, checkpoint, completion.
- [ ] **Crash-resume test** — spusť worker, kill v půlce, restart, verifikuj že pokračuje od checkpoint a nepřidá duplikáty.

## 5. Změněné soubory

`features/acquisition/contacts/migrations/010_backfill_jobs.sql` — migrace, vytvoří tabulku `backfill_jobs` + 2 indexy.

`features/acquisition/contacts/backfill/job.go` — nový soubor, struktury `BackfillJob`, `SegmentFilter`, `Counters`. SQL CRUD: `Create`, `GetPending`, `UpdateCheckpoint`, `UpdateStatus`, `Heartbeat`. ~150 řádek.

`features/acquisition/contacts/backfill/seed.go` — query builder z `SegmentFilter` na SQL string + arg slice. Generuje `seed_query_hash` přes sha256 nad serializovaným filtrem. ~80 řádek.

`features/acquisition/contacts/backfill/worker.go` — hlavní worker logika, fan-out přes KT-A7 zdroje, volá `enrichment.Pipeline.Enrich`, INSERT contacts. ~250 řádek.

`features/acquisition/contacts/backfill/cleanup.go` — stale-job detection cron, status reset. ~60 řádek.

`features/acquisition/contacts/cmd/backfill/main.go` — entry point, env validation (DSN, KT-A7 endpoint URL), spustí worker loop + cleanup goroutine. ~80 řádek.

`features/acquisition/contacts/backfill/worker_test.go` — integration test, 100-kontakt happy path + crash-resume scenario. Mocked sources + sqlmock.

`features/platform/outreach-dashboard/server.js` — 3 nové BFF endpointy: `POST /api/contacts/backfill`, `GET /api/contacts/backfill/:id`, `POST /api/contacts/backfill/:id/{pause,resume,cancel}`.

`features/platform/outreach-dashboard/src/pages/Contacts.jsx` — nový tab/sekce „Backfill“, formulář, progress bar, list completed jobů. ~200 řádek.

`features/platform/outreach-dashboard/src/api/backfill.js` — frontend API client, `createBackfill`, `getBackfillStatus`, `pauseBackfill`, etc. ~50 řádek.

`features/acquisition/contacts/CLAUDE.md` — doplnit sekci `backfill/` do subpackages.

## 6. Otázky pro orchestrátora

1. **Standalone worker container vs embedded v orchestratoru?** Návrh je standalone (`features/acquisition/contacts/cmd/backfill`). Důvod: izolace, snadný scale-out, žádná interference s hot-path. Nevýhoda: další Railway service (+1 deploy unit). Embedded by ušetřilo deploy slot, ale složitější resource management. Co preferuješ?

2. **Limit per job — soft cap nebo bez limitu?** Návrh: operátor zadá `limit` v body (default 5 000). Maximum: žádný hard cap. Alternativa: hard cap 10 000 per job (anti-abuse — pokud někdo omylem zadá 1M, ARES nás ban-listne za hodinu). Stačí soft cap, nebo chceš hard cap 10 000?

3. **Backfill priority vs aktivní kampaň?** Když backfill běží 30 min, běžící kampaň posílá email. Oba sdílí ARES rate-limit (a KT-A7 zdroje). Mají si konkurovat, nebo má backfill nižší prioritu (paušuje se, když kampaň aktivně sender-uje)? Návrh: backfill má lower priority, KT-A7 source manager dává přednost běžící kampani. Implementace: kampaň označí použité zdroje jako `in_use`, backfill čeká. Jednoduchý semafor.

4. **Co se stalo, když firmy.cz cache je prázdná pro segment?** Pokud segment je „obscure“ (např. NACE 91.04 — botanické zahrady), v `firmy_cz_businesses` může být <50 záznamů. Backfill skončí brzy. Návrh: vrátit `failed` s `error_message='seed list too small'` pokud nalezené ICO < 0.5 × `total_target`. Operátor uvidí, že segment je úzký, přidá fallback (např. spustí firmy.cz scraper na ten segment dopředu). Souhlasíš, nebo má backfill brzy completed s reálnými counters?

5. **Source rotation pro firmy.cz lookup?** KT-A9 firmy.cz Source je dnes SQL-only (čte z `firmy_cz_businesses`). Pro backfill to znamená, že kontakty bez firmy.cz cache nedostanou email + telefon — jen ARES data. Alternativa: backfill aktivně volá firmy.cz scraper pro ICO bez cache. To by ale znamenalo přidat 5 000 firmy.cz fetches × ~2s = 167 minut wall-clock. Návrh: KT-A10 zůstává SQL-only, missing-cache je akceptovaný (kontakt jde do queue jako „awaiting firmy.cz refresh“, KT-A11 cron ho doplní později). Souhlasíš s deferred enrichment, nebo chceš aktivní scrape?

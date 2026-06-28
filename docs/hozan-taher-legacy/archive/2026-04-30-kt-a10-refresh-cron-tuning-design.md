# Sprint KT-A10 — Naladíme refresh cron tak, aby data byla čerstvá, ale zdroj nás neban-listl

> **Status:** Design draft 2026-04-30. Kód v tomto sprintu nevzniká, jen plán. Předchůdce: KT-A7 (proxy rotation health), KT-A8 (block detection), KT-A9 (multi-source enrichment). GH issue [#304](https://github.com/messingdev/hozan-taher/issues/304).

---

## 1. Aktuální stav

Refresh cron je background úloha, která periodicky obtahuje aktuální stav firmy z veřejného zdroje (ARES nebo firmy.cz) a aktualizuje záznam v naší databázi. Smysl je dvojí — jednak udržovat čerstvost údajů (změna sídla, zánik subjektu, doplnění emailu z firmy.cz), jednak chytat nové firmy v segmentu, které dříve neexistovaly. Dnes ale **žádný takový cron jako samostatný komponent neexistuje** v podobě, jakou plánuje výkupní kampaň. Máme `features/acquisition/contacts/ares/sync.go` s `SyncSubjects` workflow pro batch přítah ICO seznamů (jednorázový dávkový sync, ne periodický refresh) a TS scraper firmy.cz, který běží na vlastním cronu přes BullMQ a kontinuálně plní `firmy_cz_businesses`. Tahle dvě cesta nejsou koordinované, neumí společný backoff a neemitují unifikovaný breadcrumb pro Sentry monitoring.

Stávající `features/platform/common/telemetry/sentry.go` nabízí `MonitoredJob(slug, fn)` wrapper, který kolem cronu pošle Sentry check-in (`in_progress` → `ok`/`error`) a recoveruje paniky. Tenhle wrapper v dashboard server.js používáme přes `timed(name, fn)` pomocníka (CLAUDE.md observability section). Žádný refresh cron pro ARES ani firmy.cz tohoto wrapperu dnes ale není napojený, takže když cron tiše začne dávat 429-ky, neuvidíme to v Sentry monitoring jako failure rate v čase. Vidíme to jen v logu, který nikdo nečte 24/7.

KT-A7 nám dá health-aware proxy rotation per egress zdroj (direct / mullvad-wireproxy / free-pool). KT-A8 nám dá detekci sémantického bloku (Cloudflare challenge, ARES HTML místo JSON). Oba tyto mechanismy ale řeší **jednotlivý fetch**, nikoliv **jak často spouštět celý refresh běh**. Pokud ARES začne 429-kovat, KT-A7 stáhne `direct` zdroj do cooldownu na 5 minut, ale refresh cron, který se rozjede další minutu, znovu zaklepe na ARES (tentokrát přes free-pool nebo přes mullvad). Pokud jsme nastavili refresh interval na 15 minut a ARES nás drží na 429 plošně (ne jen z naší IP, ale z celé třídy), naše free-pool i mullvad rovněž 429-kují, KT-A7 vyřadí všechny zdroje, KT-A8 spustí block alert, a refresh cron při dalším pokusu opět trefí prázdnou výběrovou logiku. Bez **per-source backoff multiplieru na úrovni cronu** budeme jezdit do zdi pětkrát za hodinu místo jednou za hodinu.

V configu dnes není nic ve smyslu `ARES_REFRESH_INTERVAL` ani `FIRMYCZ_REFRESH_INTERVAL` env proměnných — interval je hard-coded buď v BullMQ schedule nebo v `time.Tick` smyčkách jednotlivých services. Pokud chceme zpomalit, musíme přepsat kód a deploy. To je v rozporu s ops toolingem BF-G, který říká „operátor má mít env-knob pro každý cadence parameter“.

## 2. Proč tento sprint

Reálný scénář, který KT-A10 řeší:

> Pondělí 09:00, refresh cron pro ARES je nastaven na default 1 hodinu. Pondělí 10:14 ARES začne vracet 429 na všechny dotazy z naší IP třídy (KT-A7 to chytne, dá `direct` do cooldownu, scraper přepne na mullvad). 11:00 spustí refresh znovu, mullvad také 429 (Seznam fingerprint banlist). 12:00 totéž. 13:00 totéž. Až do 17:00, kdy operátor vidí v Sentry „17 consecutive ARES refresh failures“ a manuálně cron vypne. Mezitím jsme vyčerpali 8 hodin proxy budgetu na pravděpodobně beznadějný fetch — a horší, ARES si nás zapsal jako zlobivého klienta i pro budoucí kampaně.
>
> Po sprintu KT-A10: cron při prvním 429 zaznamená failure pro source `ares`, příští interval je 1.0 × 1.5 = 1.5 hodiny. Při druhém v řadě 1.5 × 1.5 = 2.25 hodiny. Pak 3.4 hodiny. Pak strop 4 hodiny. Mezi pokusy je čas, aby ARES infrastruktura uklidnila reputaci naší IP. Po prvním úspěšném fetchu se multiplier resetuje na 1.0. Sentry breadcrumb na každém kroku ukáže operátorovi, kolikátý retry to je a kdy byl naposledy úspěch.

Druhý reálný scénář — opačný směr:

> Refresh cron pro firmy.cz běží na default 6 hodin. Operátor právě nasadil novou kampaň „Výkup techniky 003 — JM kraj“ a potřebuje, aby firmy.cz měl čerstvé emailové adresy do hodin, ne dnů. Dnes by musel přepsat kód a redeploy. Po KT-A10 nastaví `FIRMYCZ_REFRESH_INTERVAL=1h` v Railway env vars, restart, a cron jede agresivněji. Pokud začne firmy.cz 429-kovat, backoff multiplier ho vrátí na 1.5h, 2.25h atd. — sám se reguluje.

Cíl sprintu **není** přepsat existující ARES sync nebo firmy.cz BullMQ scheduler. Cíl je:

1. Sjednotit cadence config přes ENV proměnné per zdroj.
2. Přidat per-source backoff multiplier 1.5× při consecutive failure, cap 4 hodiny.
3. Každý cron běh emituje Sentry breadcrumb pro auditovatelnost (kdy běžel, success/failure, current multiplier).
4. Pomoci operátorovi určit optimální cadence trade-off mezi čerstvostí dat a ban risk.

## 3. Návrh

Návrh se opírá o tři vrstvy: konfigurace cadence, backoff multiplier, a observability.

### 3.1 Per-source cadence config

Zavedeme dvě ENV proměnné: `ARES_REFRESH_INTERVAL` a `FIRMYCZ_REFRESH_INTERVAL`, obě v Go duration formátu (`1h`, `30m`, `4h`). Default values jsou konzervativní: ARES `1h` (rate-limit 1 req/s, takže za hodinu stihneme cca 3600 ICO refresh; pro 5000-ICO segment to pokryje cca 1.4 hodiny rolling), firmy.cz `6h` (komerční katalog mění data pomaleji, není potřeba refresh každou hodinu). Scheduler obou cronů přečte env při bootstrapu přes existující `features/platform/common/envconfig` schéma; nastavena hodnota mimo rozumný rozsah (např. `<1m` nebo `>24h`) zhasne service s exit kódem 1, aby se nestalo, že někdo omylem nastaví refresh interval `1ms` a smaže si ARES IP třídu.

Kromě toho přidáme volitelný `<SOURCE>_REFRESH_BACKOFF_CAP` (default `4h`, max `24h`) a `<SOURCE>_REFRESH_BACKOFF_MULTIPLIER` (default `1.5`, range `1.0`–`3.0`). Multiplier nižší než 1.0 nedává smysl (cron by se měl po failure zrychlovat?), proto validation odmítne.

### 3.2 Per-source backoff multiplier

Cron udržuje pro každý zdroj **stav backoff** (`current_multiplier float64`, `last_run_at time.Time`, `consecutive_failures int`). Stav se persistuje v Postgres tabulce `refresh_cron_state` (sloupce `source TEXT PRIMARY KEY, current_interval INTERVAL, consecutive_failures INT, last_run_at TIMESTAMPTZ, last_status TEXT`). Persistence je nutná, protože při deploy/restart by jinak multiplier začínal od 1.0 a první nasazení po obnovení by hned spadlo do 429.

Algoritmus výpočtu příštího běhu:

1. Při startu cronu načte řádek z `refresh_cron_state`. Pokud neexistuje, použije default interval z ENV.
2. Spočítá `next_run = last_run_at + (base_interval × current_multiplier)`.
3. Pokud `next_run > time.Now()`, cron přeskočí tento tick a zkusí to při příštím heartbeatu. Tím respektujeme backoff i přes BullMQ/cron dispatcher, který sám o multiplier nic neví.
4. Po fetchi zaznamená výsledek. Při success: `consecutive_failures = 0`, `current_multiplier = 1.0`. Při failure: `consecutive_failures += 1`, `current_multiplier = min(current_multiplier × 1.5, cap_multiplier)` kde `cap_multiplier = backoff_cap / base_interval`.

Příklad pro ARES s base 1h a cap 4h: 1.0 → 1.5 → 2.25 → 3.375 → 4.0 (cap). Po pátem failure už neprodlužujeme nad 4h. Po prvním success skok zpět na 1.0 (rychlý uzdravení, ne pomalý ramp-down).

Co se počítá jako failure? Cron-level failure je situace, kdy **fetch fáze nedokončila aspoň jeden úspěšný fetch nad nenulovou množinou ICO**. Pokud má batch 100 ICO a 95 dostalo 429 a 5 dostalo 200, je to **success** (5 nových záznamů, něco pokročilo). Pokud 100/100 selhalo, je to **failure**. Tím se vyhneme ping-pong situaci, kdy jeden flaky timeout zničí backoff multiplier.

### 3.3 Observability — Sentry breadcrumb per běh

Každý cron běh se obalí stávajícím `telemetry.MonitoredJob(slug, fn)` wrapperem. Slug je `refresh-ares` resp. `refresh-firmycz`. Wrapper Sentry už dnes pošle check-in (`in_progress` → `ok`/`error`). KT-A10 doplní **strukturovaný breadcrumb** těsně před fetch fází:

```text
category: "refresh-cron"
level: "info"
message: "refresh-ares tick"
data: {
  current_multiplier: 1.5,
  consecutive_failures: 1,
  next_run_at: "2026-04-30T11:30:00Z",
  base_interval: "1h",
  cap: "4h",
  ico_batch_size: 47
}
```

Tím Sentry incident dostane kompletní kontext: kolikátý retry to je, kdy bude další pokus, kolik ICO šlo do batche. Operátor v Sentry issue uvidí časovou osu „cron jel poprvé v 09:00 success, v 10:00 failure mult=1.0, v 11:30 failure mult=1.5, ve 13:45 failure mult=2.25...“ a může se rozhodnout, zda backoff je dostatečný, nebo jestli je třeba operátorský zásah.

Vedle Sentry breadcrumb zachová wrapper slog log line dle `slog_op_audit_test.go` konvence: `op=refresh.ares.tick`, `event=success|failure`, `multiplier=1.5`, `consecutive_failures=1`, `next_run_at=...`. Tím ratchet test discipline nepadne.

### 3.4 Advisory lock proti overlap

Refresh cron může z různých replik (orchestrátor + worker) startovat víc paralelních ticků. Aby se nestalo, že dva běhy najednou klepou na ARES a vyčerpávají rate-limit současně, použijeme stávající `pg_try_advisory_lock` pattern z `features/outreach/campaigns/campaign/scheduler_postgres.go`. Lock klíč bude `hash('refresh-cron-' || source)`. Pokud druhá instance lock nedostane, log "refresh.<source>.skip_overlap" a tick odpadne tiše.

### 3.5 Jak určit optimální cadence — trade-off

GH issue ptá „how to determine optimal refresh frequency (data freshness vs. ban risk)“. Návrh decision frameworku, který si operátor zaznamená do `docs/playbooks/refresh-cron-tuning.md`:

**Krok 1 — měřit aktuální baseline.** Po nasazení KT-A10 nechat cron týden běžet na konzervativním default (ARES 1h, firmy.cz 6h) a sledovat Sentry breadcrumb dashboard. Pokud `consecutive_failures` zůstává 0 týden, zdroj toleruje aktuální cadence — můžeme zrychlit.

**Krok 2 — zrychlit napůl.** Halve interval (ARES 1h → 30m, firmy.cz 6h → 3h). Pozorovat další týden. Pokud `consecutive_failures > 0` ale `< 3`, jsme na hraně — zdroj občas 429 ale rychle se srovná. To je akceptovatelné.

**Krok 3 — pokud `consecutive_failures ≥ 3` opakovaně.** Vrátit interval o 50% zpět (ARES 30m → 45m). Pak držet.

**Krok 4 — pro kampaně s tlakovou potřebou čerstvosti.** Operátor může cadence dočasně zrychlit (přes Railway env override) na dobu kampaně a po ukončení vrátit na baseline. Backoff multiplier se postará o ban risk automaticky.

**Anti-pattern, který nedoporučujeme.** Nastavit ARES `INTERVAL=1m` „protože chceme čerstvá data“. Při 1 req/s rate-limitu na ARES klientu byste fetchli 60 ICO za minutu, refresh cyklus pro 5000-ICO segment by trval 83 minut a další tick by se s ním překrýval. Advisory lock to chytne, ale Sentry bude křičet `skip_overlap` celý den. Operátor uvidí v Sentry „60 % ticků skip“ a pochopí, že nastavení je špatně. Doporučení v playbooku: minimum interval = 2× expected fetch duration.

## 4. Acceptance kritéria

- [ ] **Cadence config je env-konfigurovatelná** — `ARES_REFRESH_INTERVAL` a `FIRMYCZ_REFRESH_INTERVAL` přečtené přes `features/platform/common/envconfig` schéma s validation; out-of-range hodnoty (< 1m nebo > 24h) způsobí exit 1 při bootstrapu.
- [ ] **Per-source backoff multiplier 1.5× při consecutive failure** — po každém failure se `current_multiplier *= 1.5` až po cap (default 4h dělené base interval).
- [ ] **Cap 4 hodiny respektován** — `current_multiplier` nikdy nezpůsobí, že další běh proběhne dále než `4h` od posledního.
- [ ] **Reset multiplier při success** — první úspěšný fetch po failure stringu shodí multiplier na 1.0 a `consecutive_failures` na 0.
- [ ] **Per-source state v Postgres `refresh_cron_state`** — restart service nesmí vynulovat backoff; po restartu cron pokračuje s multiplier z poslední tick.
- [ ] **Sentry breadcrumb na každém ticku** — kategorie `refresh-cron`, message `refresh-<source> tick`, data obsahuje `current_multiplier`, `consecutive_failures`, `next_run_at`, `base_interval`, `cap`, `ico_batch_size`.
- [ ] **`MonitoredJob` wrap** — slug `refresh-ares` resp. `refresh-firmycz`, Sentry check-in `in_progress`/`ok`/`error` se posílá.
- [ ] **slog op convention** — `op=refresh.<source>.tick`, `event=success|failure`, `multiplier`, `consecutive_failures` field-key — ratchet test v `slog_op_audit_test.go` nepadne.
- [ ] **Advisory lock proti overlap** — `pg_try_advisory_lock(hash('refresh-cron-'||source))`; když druhá instance neuspěje, log `refresh.<source>.skip_overlap` a tick odpadne.
- [ ] **Failure semantika** — fetch běh = success, pokud aspoň jedno ICO v batchi vrátilo 2xx; failure = 100/100 ICO selhalo.
- [ ] **Playbook dokumentace** — `docs/playbooks/refresh-cron-tuning.md` popisuje decision framework (baseline → halve → recover → tlaková kampaň).

## 5. Změněné soubory

`features/acquisition/contacts/ares/refresh.go` — nový soubor. Definuje `RefreshLoop(ctx, db, cfg)` cron, který bere konfiguraci ze `RefreshConfig{ Interval, BackoffCap, Multiplier }` struktury. Uvnitř smyčky: získat advisory lock, načíst state z `refresh_cron_state`, zkontrolovat `next_run_at`, pokud je čas — spustit fetch fázi, zaznamenat výsledek, posunout multiplier, uvolnit lock. Volá `features/acquisition/contacts/ares/sync.SyncSubjects` jako vlastní fetch fázi (existující kód bez změn).

`features/acquisition/scrapers/src/jobs/firmycz-refresh.ts` — nový TS modul, paralela ARES verze. Stejný algoritmus, ale orchestrace běží přes BullMQ scheduler s `repeat.every` nastavenou na nejmenší možný interval (`1m`); samotné rozhodnutí „zda fetchovat“ je v handler funkci, která čte `refresh_cron_state` a porovnává `next_run_at`. Pokud čas není, handler vrátí `null` a BullMQ tick je no-op.

`features/platform/common/envconfig/refresh.go` — nový schéma builder pro refresh cron env proměnné. `Required("ARES_REFRESH_INTERVAL", Duration, "1h")`, `Optional("ARES_REFRESH_BACKOFF_CAP", Duration, "4h")`, `Optional("ARES_REFRESH_BACKOFF_MULTIPLIER", Float, "1.5")`. Symetricky pro `FIRMYCZ_*`.

`scripts/migrations/008_refresh_cron_state.sql` — migrace `CREATE TABLE refresh_cron_state (source TEXT PRIMARY KEY, current_multiplier NUMERIC NOT NULL DEFAULT 1.0, consecutive_failures INT NOT NULL DEFAULT 0, last_run_at TIMESTAMPTZ, last_status TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. Seed insert pro `ares` a `firmycz` se zachovaným multiplier 1.0.

`features/acquisition/contacts/ares/refresh_test.go` — nový test soubor, table-driven: prázdný state → multiplier 1.0; success → reset multiplier; failure → multiplier × 1.5; multiplier × 1.5 = cap → držet cap; restart loaduje state z DB; advisory lock blocked → skip; partial success (5/100 OK) → success.

`features/acquisition/scrapers/src/jobs/firmycz-refresh.test.ts` — paralelní TS test pokrývající stejnou matici.

`docs/playbooks/refresh-cron-tuning.md` — nový playbook. Sekce: „Jak měřit baseline“, „Kdy zrychlit“, „Kdy zpomalit“, „Anti-patterns“, „Čtení Sentry breadcrumb timeline“. Čte se z runbook overview.

## 6. Otázky pro orchestrátora

1. **Default cadence — ARES 1h, firmy.cz 6h?** Master plán mluví o „rolling acquisition 200/den“, což znamená 200 ICO denně. ARES 1h by stihl ~3600 ICO denně (tj. 18× víc, než potřebujeme), což působí over-provisioned. Alternativa: ARES default 4h, firmy.cz 12h. Pomalejší, méně ban risk, ale operátor má větší prostor zrychlit. Co preferuješ?

2. **Cap 4h vs cap 24h.** Issue říká cap 4 hodiny. Pokud nás ARES blacklistne na celý den, multiplier se zasekne na 4h × 1.5 = 6h... ale cap nás drží na 4h, takže ve skutečnosti budeme každé 4 hodiny narážet do zdi. Alternativa: cap 24h (jednou denně retry blacklisted source). Druhá varianta dává zdroji víc času na uklidnění, ale operátor může týden nemít čerstvá data. Doporučuji ponechat cap 4h dle issue, ale mít otázku.

3. **Backoff multiplier ratio — 1.5× vs 2×?** Issue specifikuje 1.5×. Klasický exponential backoff je 2×. 1.5 dává jemnější křivku (1, 1.5, 2.25, 3.4, 4.0 = cap), 2× by byla rychlejší (1, 2, 4 = cap). Druhá varianta by udržovala source dál od provozu při opakovaném failure. Držet 1.5× per issue?

4. **Advisory lock klíč — hash co konkrétně?** Postgres `pg_try_advisory_lock` bere bigint. Buď `hashtext('refresh-cron-ares')::bigint` (deterministický, ale možný kolize s jinými použitími hashtext), nebo statický číselný namespace `(8888 << 32) | hashtext('ares')::int`. Druhá varianta je explicitnější, první méně psaní. Co preferuješ?

5. **Co dělat při „all sources blocked“ situaci?** Pokud KT-A7 vrátí „všechny zdroje v cooldownu“ a KT-A8 hlásí block, refresh cron tick by měl pravděpodobně eskalovat na **alert level** (ne jen breadcrumb). Existuje `features/platform/common/alert/` package — chceš ho v tomto sprintu napojit (poslat alert, když `consecutive_failures ≥ 5`), nebo to nechat na samostatný sprint pro alert routing?

6. **Persistence backoff state — stačí Postgres, nebo i Redis cache?** `refresh_cron_state` v Postgres je single source of truth. BullMQ workers v Node.js dnes běží proti samostatné Redis instanci. Je akceptovatelné, aby TS strana četla state přímo z Postgres (overhead 1 SELECT per tick, řekněme jednou za 6 hodin = zanedbatelné), nebo chceš Redis cache vrstvu? Doporučuji **bez Redis cache** — jednodušší a stejně rychlé pro tuto periodicitu.

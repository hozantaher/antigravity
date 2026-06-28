# Refresh cron tuning — operator playbook

> Sprint KT-A10 (2026-04-30). Doplňuje [design dokument](../initiatives/2026-04-30-kt-a10-refresh-cron-tuning-design.md).

Refresh cron periodicky obtahuje aktuální stav firem z veřejných zdrojů (ARES, firmy.cz). Tenhle dokument popisuje, jak operátor naladí cadence parametrů tak, aby data byla čerstvá, ale zdroj nás neban-listl.

## Stav po nasazení KT-A10

Po deploy v Railway jsou v platnosti tyto defaulty:

| Zdroj | `<SOURCE>_REFRESH_INTERVAL` | `<SOURCE>_REFRESH_BACKOFF_CAP` | `<SOURCE>_REFRESH_BACKOFF_MULTIPLIER` |
|---|---|---|---|
| `ARES` | `1h` | `4h` | `1.5` |
| `FIRMYCZ` | `4h` | `4h` | `1.5` |

Per-source state je v Postgres tabulce `refresh_cron_state`. Sloupce: `current_multiplier`, `consecutive_failures`, `last_run_at`, `last_status`, `next_run_at`, `base_interval_seconds`, `backoff_cap_seconds`. Sentry breadcrumb na každý tick obsahuje stejnou množinu polí + `ico_batch_size`.

## Decision framework — jak najít optimum

### Krok 1 — měřit baseline

Po deploy nech cron týden běžet na konzervativním defaultu (ARES 1h, firmy.cz 4h) a sleduj Sentry breadcrumb dashboard. Pokud `consecutive_failures` zůstane 0 týden, zdroj toleruje aktuální cadence — můžeme zrychlit.

### Krok 2 — zrychlit napůl

Halve interval (ARES `1h → 30m`, firmy.cz `4h → 2h`). Pozoruj další týden. Pokud `consecutive_failures > 0` ale `< 3`, jsme na hraně — zdroj občas 429 ale rychle se srovná. To je akceptovatelné; multiplier 1.5 ramp si poradí sám.

### Krok 3 — pokud `consecutive_failures ≥ 3` opakovaně

Vrať interval o 50 % zpět (ARES `30m → 45m`). Pak drž a další úprava až po týdnu klidu.

### Krok 4 — pro kampaně s tlakovou potřebou čerstvosti

Operátor může cadence dočasně zrychlit přes Railway env override na dobu kampaně a po ukončení vrátit na baseline. Backoff multiplier se postará o ban risk automaticky.

## Anti-patterny

### Nenastavuj `INTERVAL=1m` „protože chceme čerstvá data“

Při 1 req/s rate-limitu na ARES klientu fetchneš 60 ICO za minutu. Refresh cyklus pro 5000-ICO segment trvá 83 minut a další tick se s ním překrývá. Advisory lock to chytne, ale Sentry uvidíš `skip_overlap` celý den. Doporučení: **minimum interval = 2× expected fetch duration**.

### Nenastavuj interval `< 1m` ani `> 24h`

Cron při bootu refuzuje nesmyslné hodnoty (exit 1). Bezpečnostní práh — kdyby se to obešlo, ARES nás zapíše do permanentního banu.

### Nenastavuj `BACKOFF_MULTIPLIER < 1.0`

Cron se po failure musí zpomalovat, ne zrychlovat. Bootstrapper to refuzuje.

## Čtení Sentry breadcrumb timeline

Sentry incident pro `refresh-ares` nebo `refresh-firmycz` ukazuje časovou osu breadcrumb událostí:

```
09:00  refresh-ares tick  multiplier=1.0   failures=0   batch=47
10:00  refresh-ares tick  multiplier=1.5   failures=1   batch=47
11:30  refresh-ares tick  multiplier=2.25  failures=2   batch=47
13:45  refresh-ares tick  multiplier=3.375 failures=3   batch=47
17:08  refresh-ares tick  multiplier=4.0   failures=4   batch=47   ← cap dosažen
```

Co znamenají hodnoty:

- `multiplier` — aktuální backoff, posunul se po každém failure × 1.5
- `failures` — počet consecutive failure od posledního success
- `batch` — kolik ICO šlo v tomhle ticku do fetch fáze

Když operátor uvidí 3+ failures v řadě, je čas zkontrolovat:

1. **KT-A7 proxy source health** — `pnpm report` v outreach-dashboard nebo `/admin/relay-health` dashboardu. Jsou všechny zdroje v cooldownu?
2. **KT-A8 block detection** — vrátil ARES Cloudflare challenge HTML místo JSON?
3. **Ban list signál** — zaslat ručně 1 dotaz na ARES z lokálního curl. Když projde bez 429, jsme v IP banu, ne plošném výpadku.

## Failure semantika

Tick se počítá jako:

- `success` — aspoň jedno ICO v batchi vrátilo 2xx (pět z 100 OK = success)
- `failure` — všechna ICO v batchi selhala (100/100 timeout, 429, nebo HTML místo JSON)
- `skipped` — tick ani neproběhl (advisory lock contention nebo ještě před `next_run_at`)

`success` resetuje `consecutive_failures` na 0 a `current_multiplier` na 1.0. `failure` ramp-uje obojí. `skipped` nemění state ani multiplier.

## Manuální zásahy

### Resetování backoff state

Pokud operátor ví, že source je v pořádku (např. ARES infra incident skončil), může ručně:

```sql
UPDATE refresh_cron_state
   SET current_multiplier = 1.0,
       consecutive_failures = 0,
       last_status = 'success',
       updated_at = now()
 WHERE source = 'ares';
```

Další tick proběhne bez čekání na backoff window.

### Pozastavení cronu

Pokud chceš dočasně cron vypnout (např. během audit/legal review), nastav v Railway env:

```
ARES_REFRESH_INTERVAL=24h
```

Cron tickne nejvýš jednou denně. Když incident skončí, vrať na baseline.

## Související dokumenty

- [Design KT-A10](../initiatives/2026-04-30-kt-a10-refresh-cron-tuning-design.md)
- [Slog conventions](slog-conventions.md) — `op` field + `error` key contract
- [Migration rollout plan](migration-rollout-plan.md) — jak nasadit `014_refresh_cron_state.sql`

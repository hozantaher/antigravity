# Mailboxes Self-Healing — Sprints

Plán na zpevnění robustnosti e-mailových schránek. Cíl: **Schránky fungují na 110 %.** Operátor by neměl muset zasahovat do recovery flow; samoléčení musí zvládnout běžné problémy autonomně (mrtvá proxy, dočasné SMTP chyby, bounce spike po prospecting kampani).

Zdroj proxy listu: [github.com/proxifly/free-proxy-list](https://github.com/proxifly/free-proxy-list) (aktualizace co ~10 min).

## Guiding principles

1. **Robustnost > feature.** Žádné nové UI bez zdůvodnění oprava reálného problému.
2. **Reverzibilita.** Každý sprint = jeden commit; možnost otočit bez ztráty dat.
3. **Audit trail.** Každá self-heal akce (auto-release, proxy swap, bounce decay) zapsaná do `watchdog_events` s auto_healed=true.
4. **Fail-open.** Pokud watchdog selže, schránky stále fungují — žádný hard dependency na healeru.
5. **Skutečný signál > kosmetický.** Dashboard ukáže jen to, co reálně mění stav.

## Současný stav (snapshot 2026-04-20)

**Proxy pool (dashboard BFF, `server.js`):**
- Proxifly CZ SOCKS5 + Geonode CZ SOCKS5 fallback, dedup.
- Cache 15 min, refresh **každých 6 hodin** (příliš pomalé pro free proxy).
- TCP probe 1.1.1.1:80 při refreshi, pak už ne.

**Intelligence daemon (Go, `modules/outreach/cmd/outreach/main.go`):**
- Běží každou hodinu (INTEL_INTERVAL default).
- Jediná self-heal akce: `autoReleaseBounceHold()` po 7 dnech v bounce_hold.

**Backpressure (Go, `internal/mailbox/backpressure.go`):**
- Hard bounce → `RecordBounce()` → pokud `consecutive_bounces >= 5` → auto `bounce_hold`.
- Reset pouze ručně přes `ReleaseHold()` nebo po 7 dnech.

**Identifikované mezery:**
1. Proxy refresh cadence 6h vs. Proxifly TTL ~10min → pool rychle zastará.
2. Žádný continuous proxy probing; zjistíme až při SMTP selhání.
3. `auth_fail_count` ve UI, ale populační zdroj nejasný — není jasné kdo updatuje.
4. Žádný bounce decay (counter se resetuje jen explicitně).
5. Po auth/proxy selhání se neudělá auto-swap proxy ze zásoby.
6. Warmup pause/reset errors jen logged, nepropagují se.
7. Password plaintext v DB (migration 038, plánovaná AES-GCM je mimo scope).
8. Žádný circuit breaker — retry spam při známém výpadku.

## Sprinty

### S1 — Proxy pool: rychlejší refresh + continuous probing

**Scope:** `features/platform/outreach-dashboard/server.js` (BFF, žádné Go změny).

**Změny:**
- `PROXY_TTL` 15min → 5min.
- Refresh cron 6h → **30 min** (jitter ±5 min aby se nebilo s intelligence).
- Proxifly source: rozšířit z CZ-SOCKS5-only na `cz.txt` + `sk.txt` + `pl.txt` (sousední země jako fallback pro CZ volání).
- Probe kruhově: každých 5 min vezmi top-20 z pool a zkontroluj TCP (1.1.1.1:80, 3s timeout); spadlé proxy označit `probe_failed_at`.
- Expozice `GET /api/proxy-pool?full=1` vrací i `probe_failed_at` + `last_latency_ms`.

**Acceptance:**
- Cache refresh je vidět v lozích každých 25–35 min.
- `/api/proxy-pool?refresh=1` stále funguje (manual override).
- Mrtvá proxy zmizí z `working[]` do 10 min od pádu, ne za 6h.
- Build green, AnonymizationBar UI nerozbitá.

**Estimated touch:** ~80 lines server.js.

**Revert:** `git checkout -- server.js`.

---

### S2 — Mailbox watchdog daemon (Go)

**Scope:** nový balíček `modules/outreach/internal/watchdog` + start v `cmd/outreach/main.go`.

**Cíl:** rychlý cyklus (**5 min**), doplňuje 1h intelligence loop, zaměřený čistě na mailbox recovery.

**Obsah cyklu:**
1. **Proxy health:** pro každou `active` schránku s `proxy_url` ověří last_latency_ms < 3000ms (z `proxy_live_check` cache); pokud pomalá nebo chybí, kandidát na swap.
2. **Auth failure tracking:** nová tabulka `mailbox_auth_fails (mailbox_id, failed_at, smtp_response)`; populovaná SMTP senderem (out of scope, ale contract připraven).
3. **Bounce decay:** pokud `consecutive_bounces > 0` a žádný bounce posledních 24h, decrement counter o 1 (neřeší kořen ale vyčistí noise).
4. **Auto proxy swap:** po 3 auth failures během hodiny → přiřadit nejrychlejší volnou proxy z BFF `/api/proxy-pool`; záznam do `watchdog_events` (auto_healed=true).

**Acceptance:**
- Daemon startuje ve `main.go` paralelně s intelligence.
- Integration test: simulate 3 auth fails → ověřit že watchdog zavolal proxy swap + zapsal event.
- Pokud BFF nedostupný, watchdog loguje warn a pokračuje (fail-open).
- `watchdog_events` roste nanejvýš o ~1 řádek/schránku/hodinu.

**Estimated touch:** ~300 lines Go (nový package), ~15 lines main.go, 1 migrace (tabulka mailbox_auth_fails).

**Revert:** odstranit goroutine ve main.go; package může zůstat dormantní.

---

### S3 — Dashboard telemetry + self-heal timeline

**Scope:** `features/platform/outreach-dashboard/src/pages/Mailboxes.jsx` drawer "Samoléčení" sekce + nové BFF endpointy.

**Změny:**
- Nový endpoint `/api/mailboxes/:id/watchdog-events` — posledních 10 self-heal záznamů.
- Drawer sekce "Samoléčení" se rozšíří o **timeline**: kdy proběhl poslední proxy swap, bounce decay, auto-release; co je naplánované (next check in Xmin).
- Header stat strip: nový chip `Posledně zkontrolováno: 2m` (global watchdog heartbeat přes `/api/health/watchdog`).
- Toast throttling: pokud schránka padne na score <50, max 1 toast za hodinu (currently spams).

**Acceptance:**
- Timeline ukazuje poslední 3–10 self-heal akcí s lidsky čitelnými timestamps.
- Heartbeat chip zčervená pokud watchdog nepřišel dlouho (>10 min).
- Žádný duplicate toast při opakovaném low-health tick.

**Estimated touch:** ~60 lines Mailboxes.jsx, ~40 lines server.js, ~20 lines CSS.

**Revert:** per-file checkout.

---

### S4 — Smart recovery: bounce_hold acceleration

**Scope:** Go `internal/mailbox/backpressure.go` + `internal/intelligence/loop.go`.

**Dnes:** bounce_hold → active striktně po 7 dnech.

**Problém:** u low-volume schránek (30 sendů/den) může 5 bounces z jedné špatné kampaně znamenat týden mimo rotaci — zbytečně dlouho.

**Změny:**
- **Adaptivní release:** pokud schránka stráví v bounce_hold >24h a `total_sent` v posledních 7d < 50, povolit release už po 72h.
- **Canary send:** po release posílat prvních 10 mailů v "probe" režimu (throttled 1/hodinu). Pokud znovu bounce → okamžitě zpět do bounce_hold + retired-candidate flag.
- **Cooldown záznam:** `mailbox_cooldown_log (mailbox_id, entered_at, left_at, bounces_at_entry, reason)` — pro audit a debug.

**Acceptance:**
- Schránka s nízkým volume se vrací rychleji, ale bez rizika opakovaného spamu.
- Canary flow testovaný unit testem (mock senders).
- Audit log přístupný přes BFF `/api/mailboxes/:id/cooldown-log`.

**Estimated touch:** ~150 lines Go, 1 migrace.

**Revert:** feature flag `WATCHDOG_ADAPTIVE_RELEASE=0` → starý 7-day path.

---

### S5 — Operational hardening + observability

**Scope:** cross-cutting — Go + BFF + dashboard.

**Tematicky:** nic velkého, ale spousta drobností které dohromady posunou spolehlivost.

**Změny:**
- **Circuit breaker per-mailbox:** po 5 SMTP chybách za sebou pauza 15 min (kratší cycle než bounce_hold). Soft-fail, nerezonuje eskalaci.
- **Warmup sync:** chyby z `Warmup.Pause/Reset` propagovat nahoru, pokud 3× selže → varování v `watchdog_events`.
- **Health metrics endpoint:** `/api/metrics/mailboxes` — Prometheus-kompatibilní counter: `mailbox_auto_healed_total`, `proxy_swaps_total`, `bounce_holds_active`.
- **Dashboard alert banner:** pokud proxy pool `working.length < 3` nebo watchdog tichý >15 min, sticky červený banner nad Mailboxes.
- **Ručný "Recover now" akce:** v drawer tlačítko které forced-spustí jeden watchdog cyklus pro tuto schránku (debug help pro operátora).

**Acceptance:**
- Metrics endpoint scrapeable.
- Banner zmizí do 30s po recovery stavu.
- Manuální "Recover now" zaznamenaný jako `auto_healed=false, reason=manual_trigger`.

**Estimated touch:** ~80 lines Go, ~60 lines server.js, ~50 lines Mailboxes.jsx.

**Revert:** per-commit.

---

## Cross-sprint checklist

Před každým commitem:
- [ ] `pnpm build` green (dashboard)
- [ ] `go test ./...` green (outreach module)
- [ ] Manuální test: otevřít Mailboxes, ověřit že toolbar + drawer + filters fungují
- [ ] Žádný nový TODO/FIXME v novém kódu
- [ ] `watchdog_events` tabulka neroste lineárně s requests (max ~N/schránku/hodinu)
- [ ] `git diff --stat` sanity check

## Out of scope

- **AES-GCM password encryption** — planned separately; security review nutná.
- **Multi-region proxy pools** — když free-proxy-list bude stačit, nepřidávat paid providery.
- **Slack/Discord alerting** — out-of-band, nepatří do Mailboxes page.
- **Rewriting intelligence loop** — nechat 1h cyklus, přidat vedle 5min watchdog.
- **Frontend virtualizace tabulky** — max rows ~50, zatím zbytečné.

## Session references

- **Proxy source:** [github.com/proxifly/free-proxy-list](https://github.com/proxifly/free-proxy-list)
- **Mailbox sprints history:** `docs/playbooks/MAILBOXES-UI-POLISH-SPRINTS.md`, `docs/playbooks/MAILBOXES-TABLE-SPRINTS.md`
- **Hlavní zdroje:**
  - `features/platform/outreach-dashboard/server.js:1798` (PROXY_TTL, refresh)
  - `modules/outreach/internal/mailbox/backpressure.go:82` (auto-hold)
  - `modules/outreach/internal/intelligence/loop.go:134` (auto-release)
  - `modules/outreach/cmd/outreach/main.go:326` (daemon start)
- **Revert base:** commit `daf2dde` on `wm/new-features`.

## Prioritní pořadí

Doporučené pořadí imlementace podle impact/risk:

| # | Sprint | Impact | Risk | Deps |
|---|---|---|---|---|
| 1 | **S1 Proxy refresh** | Vysoký | Nízký | žádné |
| 2 | **S2 Watchdog daemon** | Velmi vysoký | Střední | S1 (využívá pool) |
| 3 | **S4 Bounce recovery** | Střední | Střední | S2 (watchdog log) |
| 4 | **S3 Telemetry UI** | Střední | Nízký | S2 (data) |
| 5 | **S5 Hardening** | Nízký-Střední | Nízký | všechny |

**Quick wins** (S1, S3) lze dodat do 1 dne; **core** (S2, S4) jsou 2–3 dny každý včetně testů.

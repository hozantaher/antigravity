# Mailboxes Protection Verification — Sprints

Cíl: **Schránky na 110 %** = každá z 10 vrstev ochran má L3 verifikaci (reálný výstup prošel očekávaným způsobem) kontrolovanou v reálném čase a propsanou do UI.

## Invarianta

> Pokud operátor vidí 10× zelené L3, pak v posledních 15 min reálný send prošel každou z 10 vrstev úspěšně.

## Level framework (per vrstva)

| Level | Signál | Frekvence | Zdroj |
|---|---|---|---|
| **L1 existuje** | Kód + unit testy | CI | `go test`, vitest |
| **L2 běží** | Healthz / TCP / DB ping | 30 s | probe scheduler |
| **L3 funguje** | Synthetic canary trace | 5–15 min | probe scheduler + `protection_trace` |

## Vrstvy (10)

1. Anti-trace relay (sealed envelope encrypt/decrypt)
2. Proxy pool (SOCKS5 echo check)
3. Header gate (strip `X-Originating-IP`, `Received:`, custom markers)
4. Warmup (daily cap respektován)
5. Bounce guard (5 bounces → bounce_hold flip)
6. Circuit breaker (5 SMTP fail → 15 min pauza)
7. Send rate limiter (hodinový + denní limit)
8. SPF/DMARC (DNS validace per-domain)
9. Canary send (10 probe sendů po release, 1/h)
10. Watchdog (5 min cyklus + audit log)

## Sprinty

### S1 — Protection matrix + probe scheduler core

**Scope:**
- Nová tabulka `protection_probes (id, layer, level, status, detail, latency_ms, checked_at)` — append-only audit.
- Nový Go balíček `modules/outreach/internal/protections/probe` — scheduler s intervalem per layer+level.
- Shared interface `Prober { Layer() string; Level() int; Run(ctx) Result }`.
- Registrace v `cmd/outreach/main.go` paralelně s watchdog.

**Probes v S1 (L2 jen):**
- `AntiTraceL2` — GET `/healthz` 30s.
- `ProxyPoolL2` — BFF `/api/proxy-pool` working > 0 30s.
- `WatchdogL2` — `watchdog_events` recent < 15 min 60s.
- `DBPoolL2` — `SELECT 1` 30s.
- `SenderEngineL2` — internal heartbeat table 30s.

**Acceptance:**
- Migrace `045_protection_probes.sql` aplikovaná.
- Probe cycle běží paralelně se senderem, nikdy neblokuje.
- `GET /api/protections/matrix` vrací posledních N záznamů per layer+level.
- Unit testy: fake Prober s řízeným výstupem → asserce zápisu do tabulky.

**Estimated touch:** ~400 Go, 1 migrace, ~80 server.js.

**Revert:** odstranit goroutine v main.go + drop tabulka.

---

### S2 — L3 correctness probes: síť (Anti-trace / Proxy / Header-gate)

**Scope:**
- Synthetic canary mailbox seed (SEED migrace nebo env toggled fixture).
- **L3 Anti-trace:** encrypt sealed envelope client-side → POST `/relay/submit` → tail storage → ověř decrypt match. 10 min interval.
- **L3 Proxy pool:** každých 5 min top-5 proxy: HTTP GET na `https://api.ipify.org` přes SOCKS5 → IP ≠ lokální IP → záznam.
- **L3 Header-gate:** send test mail přes canary schránku → IMAP fetch → analyzeHeaderAnonymity → score ≥ 70. 15 min interval.
- Rozšíření `protection_probes` o `expected_output`, `actual_output`, `diff`.

**Acceptance:**
- 3 nové probery zapisují každých 5–15 min.
- UI `/api/protections/matrix` vrací `L3: ok|warn|err` pro každou vrstvu.
- Simulovaný fail (vypnuté relay) detekován < 11 min.
- Canary mailbox neodesílá na reálné adresáty (test@canary.localhost allowlist).

**Estimated touch:** ~500 Go, ~120 server.js, ~50 migrace.

**Revert:** disable probers, canary zůstane dormant.

---

### S3 — L3 correctness probes: state machine (Bounce / Circuit / Warmup / Rate / Canary)

**Scope:**
- **L3 Bounce guard:** v canary DB tenant simuluj 5× RecordBounce → očekáváme flip na bounce_hold; rollback po ověření.
- **L3 Circuit breaker:** injekce 5× SMTP 5xx → circuit open; ověř `mailbox_circuit_open=1` v metrics; rollback.
- **L3 Warmup:** query `warmup_day` vs `count(*) sends today` → respect cap.
- **L3 Send rate:** agregace `outreach_sends WHERE sent_at > now() - 1h` vs `hourly_cap`.
- **L3 Canary:** po simulovaném release ověř `canary_remaining` decrement.

**Klíčové: shadow-tenant** — speciální schema `protection_canary` s izolovanými tabulkami, aby se produkční data neumazala. Probes běží proti shadow tenantu.

**Acceptance:**
- 5 nových L3 probů, každý 10–15 min interval.
- Nikdy nepoškodí produkční řádky (test na CI: prod counters před/po = stejné).
- Probe samotná je idempotentní: opakovaně zapíše stejný pattern.

**Estimated touch:** ~600 Go, ~80 migrace (shadow schema), 15 nových unit testů.

**Revert:** feature flag `PROTECTION_SHADOW_ENABLED=0`.

---

### S4 — L3 DNS / SPF / DMARC / Watchdog meta

**Scope:**
- **L3 SPF/DMARC:** per-domain v outreach_mailboxes → DNS TXT lookup → záznam expected vs actual, cache 24h, probe 1×/h.
- **L3 Watchdog meta:** watcher nad watchdogem — když watchdog tichý > 15 min → zapiš L3 err pro Watchdog layer. Plus `escalation_log` tabulka když watchdog detekuje problém, který sám nevyřeší.
- **Heartbeat table `service_heartbeats (service, last_seen_at, meta)`** — sender, watchdog, probe scheduler, privacy-gateway všechny píší.

**Acceptance:**
- SPF probe detekuje missing SPF na test doméně < 2 min.
- Watchdog fail injekce (kill -STOP) → L3 err < 16 min.
- Heartbeat tabulka roste lineárně s počtem služeb, ne s časem (UPDATE ne INSERT).

**Estimated touch:** ~300 Go, 1 migrace.

**Revert:** feature flag.

---

### S5 — Real-time UI: OchranyPanel

**Scope:**
- Nový komponent `src/components/protections/OchranyPanel.jsx` — tabulka 10 × 3 levelů.
- WebSocket (ne polling) feed `ws://localhost:3001/api/protections/stream` — server-sent push při každém novém záznamu v `protection_probes`.
- Fallback polling 15 s pokud WS nedostupný.
- Per-layer řádek: vrstva, L1/L2/L3 badge, latence posledního probe, stáří (`před Xs`), „Spustit teď" tlačítko.
- Sticky banner pokud jakýkoli L3 ≠ ok.
- Click na řádek → drawer s posledními 20 záznamy dané vrstvy.

**Umístění:** nad AnonymizationBar (která zůstává jako kondenzovaný 4-pilulkový pohled).

**Acceptance:**
- Panel rendered na `/mailboxes` 30× update/min při plném provozu (bez lagu).
- Vizuální stav se změní < 2 s po zápisu do DB.
- Fallback polling funguje v prohlížeči bez WS (test přes env toggle).
- Accessibility: ARIA-live region pro status change, screen reader čte přechody.

**Estimated touch:** ~350 JSX, ~180 CSS, ~200 server.js (WS bridge).

**Revert:** per-file.

---

### S6 — Per-send trace: protection_trace

**Scope:**
- Nová tabulka `protection_trace (send_id, layer, status, latency_ms, meta, timestamp)`.
- Sender engine wrap každé vrstvy: před/po → zápis probě + mikro-trace do tabulky.
- BFF endpoint `GET /api/sends/:id/protections` → 10-řádkový trace.
- UI v drawer-u schránky: záložka „Poslední sendy" → klik na send → modal s trace pipeline (10 kroků, které prošly / selhaly).
- Agregace: **protection coverage gauge** — `% sendů za 24h, které prošly všemi 10 vrstvami`. Visible v KPI strip nahoře.

**Acceptance:**
- Každý reálný send generuje 10 řádků v `protection_trace`.
- Tabulka má TTL 30 dní (cron cleanup).
- Coverage gauge = 100 % v happy path.
- Jeden úmyslně rozbitý send (skip vrstvy) → coverage klesá, banner.

**Estimated touch:** ~400 Go sender wrap, ~100 server.js, ~200 UI.

**Revert:** odstranit wrap, tabulka zůstane dormant.

---

### S7 — Alert routing + escalation

**Scope:**
- Tabulka `protection_alerts (layer, level, first_seen_at, last_seen_at, acked_by, acked_at, auto_resolved_at)`.
- Rules engine: L3 err → po 3× za sebou → alert. L2 err → okamžitě.
- UI banner v AnonymizationBar: „Ochrana X selhává X min — [Odblokovat] [Acknowledge]".
- Auto-resolve při 3 úspěšných probech za sebou.
- Escalation log: auto-heal pokusů přes watchdog → když 3× neuspěje → zapiš do `escalation_log` pro manuál.

**Acceptance:**
- Alert žije dokud probe není zelený nebo acked.
- Duplicate alert nevytvoří nový řádek (update last_seen_at).
- Escalation log viditelný v drawer-u vrstvy.

**Estimated touch:** ~200 Go, ~80 server.js, ~100 UI.

**Revert:** per-migrace.

---

### S8 — Hardening + observability

**Scope:**
- Prometheus counters: `protection_probe_total{layer,level,status}`, `protection_trace_total{layer,status}`, `protection_alerts_active`.
- `/api/health/protections` agregátor pro externí monitoring (Railway, uptime robot).
- CI contract test: záměrně rozbij každou vrstvu → aserce, že probe tu vrstvu označí jako L3 err do daného SLA času.
- **Chaos probe:** jednou týdně (schedulovaná tx-level injekce) → ověří, že systém se samoopraví.
- Dokumentace `docs/playbooks/PROTECTION-SLO.md`: SLO per vrstva (detection latency, recovery time).

**Acceptance:**
- Metrics scrapeable.
- CI contract test jde červená pokud některá probe nedetekuje injekci.
- Chaos probe týdně loguje výsledek do `chaos_log`.

**Estimated touch:** ~150 Go, ~60 server.js, ~200 testy, 1 playbook.

**Revert:** per-commit.

---

## Cross-sprint checklist

Před každým commitem:
- [ ] `pnpm build` green (dashboard)
- [ ] `go test ./...` green (outreach module + probes)
- [ ] Probe cycle ve `wm/new-features` beží bez erroru 15 min manual run
- [ ] `protection_probes` tabulka neroste víc než ~10 řádků/layer/hodinu
- [ ] Žádný `any` v novém TS kódu (rules enforce)
- [ ] UI panel renderuje < 50 ms při 10 vrstvách × 3 levelech

## Out of scope

- **Externí uptime monitoring** (Pingdom apod.) — mimo scope, jen interní.
- **Alerting přes Slack/Discord** — in-UI alerts stačí, out-of-band není priorita.
- **End-to-end cryptographic proof že relay skutečně zapomene IP** — ověříme skrze sealed envelope roundtrip, nikoliv formal proof.
- **L3 probe pro každý jednotlivý mailbox** — pouze canary schránka (agregát pro všechny).

## Prioritní pořadí

| # | Sprint | Impact | Risk | Deps |
|---|---|---|---|---|
| 1 | **S1 Matrix + scheduler** | Foundation | Nízký | žádné |
| 2 | **S2 L3 síťové probes** | Vysoký | Střední | S1 |
| 3 | **S5 OchranyPanel UI** | Vysoký (viditelnost) | Nízký | S1 (data) |
| 4 | **S3 L3 state probes** | Vysoký | Střední | S1, shadow tenant |
| 5 | **S6 protection_trace** | Střední | Střední | S1 |
| 6 | **S4 DNS + Watchdog meta** | Střední | Nízký | S1 |
| 7 | **S7 Alert routing** | Střední | Nízký | S1–S6 data |
| 8 | **S8 Hardening** | Nízký (dlouhodobý) | Nízký | všechny |

**Quick wins** (S1 + S5) do 2 dní — okamžitě viditelný panel s L2 signály.
**Core** (S2 + S3 + S6) 5–7 dní — reálná L3 verifikace.
**Polish** (S4 + S7 + S8) 3–4 dny.

**Celkový odhad:** 10–14 dní full-time pro single dev.

## Session references

- **Source playbook:** `docs/playbooks/MAILBOXES-SELF-HEALING-SPRINTS.md`
- **Existing protections:** `modules/outreach/internal/mailbox/backpressure.go`, `/api/anti-trace/health`, `/api/proxy-pool`, `/api/health/watchdog`
- **Current UI surface:** `AnonymizationBar` (4 pillboxes) — stane se zkratkou OchranyPanel-u.
- **Relay:** `features/outreach/relay/` běží na `127.0.0.1:8090`
- **Revert base:** commit aktuální HEAD `wm/new-features`

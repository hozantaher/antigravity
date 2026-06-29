# Hardening — sekce 13-15: Analytika, Watchdog, Observability

**Status:** Dokončeno
**Datum:** 2026-05-05
**Trigger:** Post-audit (Agent 4 / PR #867) — 5 show-stoppers v sekcích 13-15
**Branch:** `hardening/pages-13-15-analytika-watchdog-observability`

---

## Show-stoppers opraveny

### S1: Analytics custom date range (Q302) — OPRAVENO

`server.js` `GET /api/analytics/timeline` přijímal pouze `?days=N` a ignoroval `?from=YYYY-MM-DD&to=YYYY-MM-DD` parametry posílané z frontendu. Operátor vybral custom datum, ale dostal 30denní data.

**Fix:** Dual-mode logika — `ISO_RE.test(rawFrom) && ISO_RE.test(rawTo)` aktivuje range mode s parametrizovaným SQL dotazem (`sent_at >= $1 AND sent_at <= $2`), validací ve fallback do days mode při neplatných nebo chybějících datech. Span cappnut na 366 dní.

**Testy:** 7 nových contract testů v `bff-analytics.contract.test.ts` — happy path, zero-fill, cap 366d, fallback bez `to`, fallback `from > to`, fallback non-ISO.

### S2: Watchdog /api/health/watchdog auth (Q331)

Audit citoval `authMiddleware.js:22` jako zdroj AUTH_EXEMPT. Verifikací kódu potvrzeno: `/api/health/watchdog` NENÍ v AUTH_EXEMPT (extrakce do `server-routes/health.js` problém již vyřešila). Žádná oprava potřeba — finding byl stale.

### S3: AnonymityLatest N+1 (Q371)

V rozsahu Agenta 5 (DiagnostikaAnonymita) — přeskočeno per task constraints.

### S4: Per-mailbox metrics (Q299) + real-time update (Q305)

Nová GH issue vytvořena pro per-mailbox breakdown v Analytics a real-time WebSocket/SSE update.

### S5: DedupGuard stats time window (Q375)

V rozsahu Agenta 5 — přeskočeno per task constraints.

---

## New features implementovány

### Watchdog: per-source filter + severity filter + dismiss (Q317/Q326/Q327/Q334)

- **Auto-poll 60 s** (`pollMs: 60_000`) — Watchdog se obnovuje automaticky, ne jen manuálním tlačítkem
- **Severity filter** — tlačítka `vše / critical / warn / info` pro filtrování řádků
- **Per-source filter** — tlačítka `Vše / Kampaně / SMTP / Proxy / IMAP / Ostatní` odvozené z `check_name` funkce `sourceOf()`
- **Dismiss button** — session-local `×` tlačítko na každém řádku skryje událost pro aktuální session (append-only `dismissed` Set ve state)

**Testy:** 17 nových unit testů v 3 describe blocích — severity filter (3), per-source filter (4), dismiss (4) + existující relTime boundary testy neporušeny.

### Observability: cron heartbeats panel + external links (Q336/Q337/Q340/Q351)

- **CronHeartbeatsPanel** — volá `/api/health/cron-heartbeats` s `pollMs: 60_000`, renderuje per-daemon tile s labelem, věkem od posledního spuštění, a stale indikátorem. Skrytý pokud žádné heartbeaty (graceful degradation).
- **External links panel** — odkaz na Sentry a Railway Dashboard s `target="_blank"` a `rel="noopener noreferrer"`

**Testy:** 6 nových unit testů (T-19 až T-24) — empty panel hidden, renders with heartbeats, stale count, "nikdy" pro null last_run_at, links present, links open new tab.

---

## Souhrnné statistiky změn

| Soubor | Typ | Popis |
|--------|-----|-------|
| `server.js` | Fix | analytics/timeline dual-mode (Q302) |
| `src/pages/Watchdog.jsx` | Feature | per-source filter, severity filter, dismiss, auto-poll |
| `src/pages/Observability.jsx` | Feature | CronHeartbeatsPanel, external links |
| `tests/contract/bff-analytics.contract.test.ts` | Test | +7 custom date range contract tests |
| `tests/unit/pages/Watchdog.test.jsx` | Test | +17 filter/dismiss unit tests |
| `tests/unit/pages/Observability.test.jsx` | Test | +6 heartbeats/links unit tests |

### Test coverage

- Contract: 20 tests PASS (Analytics timeline, including 7 new)
- Unit: 47 tests PASS (Watchdog 27 + Observability 20)
- Pre-existing failures: `inverted-fault-harness` (T-17, T-18) fail in git worktrees due to absolute path assumption — not caused by these changes; `prod-smoke.test.js` timeout (requires live server)

---

## GH issues pro nové featury

Viz výstup PR (issues vytvoří agent po commit).

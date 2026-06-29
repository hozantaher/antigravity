# Sentinel monitor — local 5-min health watchdog

CLI complement to the Y7 web notification center. Runs on the operator's
machine, polls Postgres + anti-trace relay every 5 min, and prints
color-coded Czech advisories. **Does not auto-pause campaigns** — only
suggests a manual SQL when 2+ red alerts pile up in a row.

## Spuštění

```bash
cd features/platform/outreach-dashboard

# defaultně kampaň 457, poll každých 300 s
pnpm sentinel

# jiná kampaň, custom interval, rolling log file
node --env-file-if-exists=.env scripts/sentinel-monitor.mjs 462 --interval=120 --log
```

DSN se bere z `features/platform/outreach-dashboard/.env` (`DATABASE_URL`), případně
z exportované env proměnné. Relay URL z `ANTI_TRACE_RELAY_URL` nebo
`RELAY_URL` (token `ANTI_TRACE_RELAY_TOKEN` / `RELAY_TOKEN`).

## Co kontroluje (každých 5 min)

1. **Send rate (60 min):** pokud je Pražská hodina v send window (06:00–23:00)
   a v posledních 60 min nebyl žádný `send_events` insert → RED alert.
2. **Per-mailbox bounce rate (24 h):** každý mailbox s ≥10 odeslanými
   sleduje (bounced / sent) × 100. Nad 1.5 % → YELLOW warn (pod 2 %
   auto-pause threshold relay engine).
3. **Mailbox status:** jakýkoli aktivní mailbox který flipnul na
   `auth_locked` / `bounce_hold` → RED alert.
4. **Send stall:** v send window, pokud uplynulo > 30 min od posledního
   odeslání → YELLOW warn.
5. **Nové odpovědi (60 min):** info-level update — operátor vidí, že
   `outreach_messages` s `direction='inbound'` rostou.
6. **Anti-trace relay drain queue:** pokud relay vrátí
   `queue_depth > 100` nebo není dosažitelný → YELLOW warn.

## Kill switch

Když přijdou 2 RED alerty v řadě (tj. dva polling cykly za sebou s
alespoň jedním red advisory), script vypíše:

```
⚠ 2 RED alerty v řadě — zvaž manuální pauzu:
  psql "$DATABASE_URL" -c "UPDATE campaigns SET status='paused' WHERE id=457;"
```

**Záměrně neautomatizujeme pauzu** — operator vyhodnotí kontext a spustí
psql sám. Decision-maker je vždycky člověk.

## Log file

S flagem `--log` script appenduje strip-ANSI verze advisories do
`features/platform/outreach-dashboard/logs/sentinel-YYYY-MM-DD.log` (vytvoří se
automaticky, ignored gitignore). Užitečné pro postmortem ze startu
kampaně.

## HARD RULES dodrženy

- `feedback_no_pii_in_commands` (T0) — DSN z env, mailbox addresses
  redagované v outputu (`hozan.taher.71@post.cz` → `hozan.taher.7X@post.cz`).
- `feedback_no_speculation` (T0) — všechny alerty jsou data-driven
  (DB row count / status / queue depth); žádné predikce ani extrapolace.
- `feedback_outreach_dashboard_local_only` (T0) — script běží lokálně
  na operátorovi; nedeployuje se na Railway.

## Doplněk k web Y7

Web notification center (Sprint Y7, PR #1351) je primární surface pro
operator alerty během dashboard práce. Sentinel je **standalone CLI** —
běží i když je dashboard zavřený, dispatch je terminal bell + stdout +
volitelný log file. Žádný UI surface, žádný Playwright smoke nepotřeba
(per HARD rule výjimka pro CLI tooling).

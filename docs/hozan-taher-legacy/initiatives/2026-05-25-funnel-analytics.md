---
Status: Active
Datum: 2026-05-25
Trigger: Operátor vidí jen denní počet odeslaných emailů, bez přehledu o tom, kde se v pipeline ztrácejí odpovědi, jak se daří šablonám ani kdy se konverze začíná hroutit. Bez funnel metrik nelze optimizovat.
---

# Funnel Analytics

Cíl iniciativy je dát operátorovi kompletní marketingový funnel na jednom místě — vidět
celý řetězec od odeslání přes otevření, odpověď, klasifikaci zapojení až po vznik a výhru
leadu. Součástí je srovnání kohort, srovnání šablon a systém upozornění na pokles reply
rate nebo nedostatek nových leadů.

## Proč to děláme

Dnes máme v dashboardu pouze denní čísla odeslaných emailů. Operátor nevidí:

- kde v pipelině se kontakty ztrácí (procento otevření, procento odpovědí, procento
  klasifikace jako engaged, procento konverze na lead)
- které šablony konvertují lépe než jiné
- jak vypadá historický trend posledních 14 dní pro key metriky
- kdy stojí za to zásah (reply rate klesla o 30 %, přišlo méně než 5 leadů tento týden)

## Sprinty

### Wave 1 — Funnel Foundation (FUN-1) — probíhá

Základní schéma a sběr dat. Pět deliverables:

- **FUN-1.1 Schema** — nová tabulka `funnel_events` (migration 141). Denormalizovaná pro
  rychlé kohortní aggregace. Indexy na (event_type, occurred_at), (campaign_id), (template_name),
  (contact_id).

- **FUN-1.2 Backfill** — jednorázový skript `scripts/funnel/backfill-from-existing.js` prochází
  send_events → replied → leads → suppressions a retroaktivně plní funnel_events. Idempotentní,
  dry-run mód.

- **FUN-1.3 Pipeline hooks** — po každém novém send_events INSERT v orchestrátoru → INSERT
  funnel_events. Po reply klasifikaci v LEAD-1 conveyor → INSERT funnel_events. Po vytvoření
  leadu v LEAD-2 → INSERT funnel_events. Čistě aditivní, nesahá do existující logiky.

- **FUN-1.4 BFF endpoint** — `GET /api/funnel/summary?campaign_id=&days=7` vrátí funnel
  (sent/opened/replied/classified_engagement/lead_created/lead_won) + drop-off procenta.
  Volitelné filtrování dle šablony a kampaně.

- **FUN-1.5 UI stránka** — `/analytics` rozšíříme o nový tab "Funnel". Tři sekce:
  horizontální funnel vizualizace s drop-off procenty; tabulka srovnání šablon podle
  reply rate za 30 dní; denní timeseries (odesláno / odpovědi / lead_created) za 14 dní.

### Wave 2 — Per-Cohort Metrics (FUN-2) — plánováno

Kohortní srovnání (nová vs. stará kampaň, různé audience segmenty). Dashboard porovná dvě
kohorty vedle sebe s grafem reply_rate vs. čas od prvního kontaktu. Funnel zobrazí drop-off
zvlášť pro každou kohortu.

### Wave 3 — Alerts (FUN-3) — plánováno

Automatická upozornění:

- Reply rate klesl o více než 30 % oproti 7d průměru → operátor dostane badge v notifikacích.
- Počet leadů za posledních 7 dní klesl pod 5 → stejná eskalace.

Oba thresholdy budou v `operator_settings` jako pojmenované konstanty
(`FUNNEL_REPLY_RATE_DROP_ALERT_PCT` = 30, `FUNNEL_LEAD_COUNT_WEEK_MIN` = 5), ne jako literály
uvnitř funkce (hard rule `feedback_no_magic_thresholds`).

### Wave 4 — Drill-down (FUN-4) — plánováno

Klik na libovolnou fázi funnelu otevře drawer s kontakty v dané fázi, filtrovatelný
dle kampaně nebo šablony. Drill-down umožní operátorovi přímo přejít na detail kontaktu nebo
spustit follow-up sekvenci.

### Wave 5 — Export CSV (FUN-5) — plánováno

Export funnel_events za zvolené období do CSV (cohort_id, event_type, template_name,
occurred_at). Tlačítko v `/analytics` Funnel tabu. Žádná nová stránka, konsoliduje se
do existující `/analytics` per `feedback_optimize_and_simplify`.

## Technická architektura

Funnel_events je denormalizovaná kopírka klíčových pipeline událostí. Záměrně nesahá
do existujících tabulek (send_events, reply_inbox, leads) — jsou to zdrojová data.
funnel_events je read-optimized projection pro analytické dotazy.

Každý INSERT do funnel_events je best-effort (non-blocking) v rámci té samé transakce nebo
hned po ní. Výpadek funnel INSERT nikdy nezablokuje produkční send.

## Hard rules pro tuto iniciativu

- `feedback_schema_verify_before_sql` T0 — před každým SQL dotazem ověřit `\d <table>`
- `feedback_verify_select_after_migration` T0 — po každé migraci SELECT ověření
- `feedback_audit_log_on_mutations` T0 — backfill zapisuje do operator_audit_log po dávce
- `feedback_no_pii_in_logs` T0 — nikdy nezapisovat emaily nebo jména do logů
- `feedback_no_magic_thresholds` T0 — všechny thresholdy (alertů, drop-off %) v named constants
- `feedback_playwright_smoke_required` T0 — smoke spec pro /analytics?tab=funnel ve stejném PR
- `feedback_optimize_and_simplify` T0 — žádné nové stránky; wave 3-5 konsolidují do /analytics

# Post-purge rebuild — plán pro skutečný launch

**Status:** Open
**Datum:** 2026-05-05
**Trigger:** Operátor přes noc smazal všechny 3 kampaně + 2 segmenty (test residue) a nechal vytvořit jeden čistý segment "Těžká technika a vozidla (CZ B2B)" se 45 855 firmami (NACE filter, email_status=valid). Launch v 07:00 byl odložen — potřebujeme dořešit dedup ochrany, vytvořit nové kampaně a teprve potom spouštět ostré odeslání.

---

## Co máme po dnešní noci

Tonight bylo do `main` mergnuto **41 PRs** (#723–#782 minus dva closed). Operátorská infrastruktura pro launch je hotová: launch-monitor widget na stránce schránek, ramp staircase pro Day 2+ progress, preflight panel s 13 sanity dlaždicemi na dashboard root, synthetic probe scaffold (default off), helper skripty `pnpm launch:merge / launch:go-live / launch:rollback / launch:snapshot:pre|post|diff`, slog op-field discipline napříč relay + cmd/outreach + intelligence + dalších 9 packages, hygiene sweep na 61 contract test souborech, GDPR compliance gate na ukládání šablon (closes issue #585), a verify-launch BFF prereq (closes #586).

Dále jsme udělali deep inventory firem v PROD databázi (1 087 178 řádků, 634 930 s emailem). Postavili jsme klasifikátor 4 070 distinct `category_path` hodnot do 5 tier košů, plus probabilistický scorer který každé kategorii přiřadí pravděpodobnost vlastnictví těžké techniky. Z toho vyšlo, že celkový adresovatelný trh je zhruba 22 000 firem v ČR pravděpodobně vlastnících aspoň jeden resellable kus těžké techniky / komerčního vozidla. NACE-based segment vyfiltroval ~46 000 firem (širší než probability scorer protože NACE 011-017 catchne i drobné farmáře).

Co skutečně **chybí** k tomu, aby se mohl spustit reálný launch.

---

## Sprint A — Dedup guard (cross-campaign + per-domain)

Operátor specificky upozornil, že systém nesmí (1) podruhé odeslat firmě, kterou už někdy jiná kampaň nebo segment oslovila, a (2) v rámci jedné domény oslovit současně jednatele, asistentku a obecnou info adresu. Jinak nás Seznam i Gmail označí jako spam.

První sprint pokrývá tyto dvě nejhorší díry. Migrace 049_dedup_guard.sql přidá na tabulku `contacts` tři nové sloupce — `email_domain` jako generovaný a indexovaný, `lifetime_touches` jako čítač a `dnt` jako GDPR right-to-object flag. Trigger `bump_lifetime_touches` na `send_events` zvyšuje lifetime po každém úspěšném odeslání. Backfill historie je v migraci.

V Go vrstvě vznikne nový balíček `features/outreach/campaigns/sender/dedup_guard.go` s funkcí `CheckEligibility(ctx, db, contact_id, campaign_id) (eligible bool, reason string, rules_fired []string)`. Volá se v Engine pre-enqueue a kontroluje čtyři osy: cross-campaign cooldown (90 dní default, override per-campaign), per-domain cooldown (180 dní), lifetime_touches limit (3), a dnt flag (hard skip).

Když guard zamítne, contact se přesune do `campaign_contacts.status='skipped'` s rationale do `details.skip_reason`. Sentry breadcrumb. Žádný side-effect na send_events. Všechny rozhodovací větve jdou přes `slog op="dedup.check/<branch>"` per discipline.

Sprint A končí když: migrace prošla v PROD, guard je v Engine, ≥10 testů pokrývá happy path, všech 4 axes s false-positive variantou, race-clean, audit ratchet test.

---

## Sprint B — Vytvoření nové kampaně 1 nad segmentem #7

Segment #7 existuje, kampaň ne. Sprint B vyrobí kampaň "Strojírenství — výkup techniky první vlna" napojenou na segment #7 přes Go runner endpoint `POST /api/campaigns` (BFF proxy do orchestratoru). Sequence_config: step=0 intro_machinery šablona, step=1 followup1 po 7 dnech, step=2 followup2 po dalších 7 dnech.

Operátor rozhoduje pilot velikost. Doporučení vychází ze scorer výsledků: prvních 5 contactů z p ≥ 0.85 (pool 6 591 firem) ručně vybraných podle ICP score + diverzity krajů. Wave 2 = 50 contactů z téhož pool, automaticky enqueued runnerem. Wave 3 = 200 z p ≥ 0.55. Wave 4 = 1 000 z p ≥ 0.25. Tail experiment p ≥ 0.10 podle výsledků reply-rate.

Sprint B končí když: kampaň existuje s `status='draft'`, segment #7 napojen, šablona `intro_machinery` validovaná novým compliance gate (PR #779 require-unsub-on-save), prvních 5 kontaktů manuálně schválených v UI, send-test do operátorovy schránky vrací 200.

---

## Sprint C — Anti-duplicate extras (osy 3a–3f)

Sprint A pokryl 4 axes. Zbývá 6 dalších, které během tonight RCA jsem identifikoval jako reálné. Bounce cluster per IČO — pokud bounce_rate na firmu překročí 30 %, suppress všechny její kontakty. Negative reply detection — když classifier označí "stop", "unsubscribe", "právník", "neoslovuj", všechny kontakty toho IČO jdou na trvalý DNT plus sector-flag pro sektorovou cooldown. Engagement decay — sent + no open + no click ≥ 3× → cooldown 365 dní. Holiday window — léto Vánoce státní svátky CZ — žádné odeslání. Region rate limit — max 2 firmy / kraj / hodinu, aby nás regionální MTA neflagly. Sender reputation per mailbox je už v engine breakeru, jen zkontrolovat threshold.

Každá osa = jeden Go test soubor + jeden migration helper (pokud potřebuje sloupec) + zápis do `dedup_guard.go` jako rozšíření `CheckEligibility`. Sprint C se může dělat paralelně s C-1 až C-6 sub-sprinty.

---

## Sprint D — Reply classifier napojený na DNT a suppression

Existující LLM reply classifier dělá tagy ale nezvyšuje DNT flag automaticky — operátor musí potvrzovat. Sprint D zavádí decision pipeline: classifier vrátí confidence skóre, pokud > 0.85 a tag je "negative" / "unsubscribe" / "legal_threat", DNT flag se nastaví automaticky a do `outreach_suppressions` se přidá řádek s reason. Operator dostane jen low-confidence případy do practice queue. Cíl: žádný operátorský review pro jasné případy, plné dohledatelnost přes audit log.

Sprint D končí když: 80 % negativních odpovědí jde do auto-DNT bez review, false-positive rate na 30-test set je < 5 %, všechno v `slog op="reply.classify/<tag>"`.

---

## Sprint E — Suppression backfill z minulých send_events

Před spuštěním nové kampaně je nutné zmapovat, kdo už dostal mail v předchozích testech (kampaně 455 + 456 byly v paused stavu před purge ale send_events historii jsme přepustili — wait, smazali jsme i send_events při purge). 

Aktualizace 2026-05-05: send_events table byla operátorem v noci vyprázdněna spolu s kampaněmi a segmenty. Backfill z této tabulky tedy není nutný. Zůstává obecný princip: pokud někdy v budoucnu budou existující send_events před zavedením guardu, budou potřebovat one-time INSERT do `contacts.lifetime_touches` (migrace 049 to už dělá ve své UPDATE části — když se znovu populují send_events, lifetime_touches se nabíhá triggerem od začátku).

Sprint E zúžen na: validační script `scripts/audits/dedup-guard-replay.mjs` který přejede posledních 30 dní send_events a verifikuje, že guard by byl odmítl všechny duplicity, které byly skutečně poslány. Pokud najde duplicitu, log do Sentry a dokumentace případu.

---

## Sprint F — Operator UI pro dedup-guard přehled

Bez UI operátor neví, kdo je suppressed, který kontakt je na DNT a proč, ani kolik ze segmentu #7 je už mimo (lifetime_touches >= 3). Sprint F přidá novou stránku `/dedup-guard` v dashboard:

Levý sloupec — distribuce dedup důvodů: kolik kontaktů zablokováno cross-campaign cooldown, kolik per-domain, kolik DNT, kolik lifetime exhausted, kolik bounce-cluster. Pravý sloupec — aktuální stav segmentu #7: 45 855 členů, z toho X eligible po všech filtrech, Y v DNT, Z v cooldown, W přes lifetime limit. Dole — operator override: pokud chce vyloučit konkrétní firmu nebo doménu nad rámec automatických pravidel.

Sprint F končí když: stránka renderuje per-segment statistiku do 200ms, override flow má audit log row, RAW SQL link pro každou metriku v expand-on-click.

---

## Sprint G — Skutečný launch nové kampaně

Až jsou A + B + C + D + F hotové a F-validation report ukazuje žádné high-severity nálezy, operátor spustí kampaň přes `pnpm launch:go-live`. T+0 → T+15m → T+1h → T+24h checkpointy podle `docs/audits/2026-05-05-launch-observation-log.md` (PR #753 template). Den 2 ramp 5→10/day, Den 3 → 20/day, Den 7 → 30/day steady state — viz RampStaircase widget na stránce schránek.

Den 1 success criterion: bounce < 2 %, žádný Sentry critical, ≥ 10 % open rate, ≥ 1 reply (jakékoli polarity), všechny 5 schránek active. Kdykoli nesplněno → `pnpm launch:rollback --reason "..."`.

Sprint G končí když: T+24h zelený checkpoint, ADR-012 flipnuté na Accepted, Day-2 ramp povolen.

---

## Sprint H — Post-launch optimalizace (volitelný, Day 7+)

Po prvním týdnu se vyhodnotí reply-rate per p-tier (z probability scorer). Pokud p ≥ 0.85 dělá 3× lepší reply-rate než p 0.55–0.85, zúžíme target. Pokud naopak nižší tier dělá překvapivě dobře, scorer rules se rekalibrují.

Synthetic probe (PR #759 default off) se aktivuje až po T+24h checkpointu — Railway env `SYNTHETIC_PROBE_ENABLED=true`. Probe každých 30 min ověří mb-to-mb relay path beze ztráty traffic.

---

## Závislosti mezi sprinty

A → B (kampaň nemá smysl bez guardu).
A + B → G (launch).
C, D, E, F běží paralelně po A.
H je čistě post-launch.

---

## Kdo dělá co

A je rozdělaný (migrace 049 v draft PR `feat/dedup/cross-campaign-domain-guard`, Go strana neudělaná).
B je operátorský úkol — UI gestura nebo SQL by Claude.
C, D, E, F jdou přes spawnnuté Haiku agenty s explicit isolation worktree.
G operátor spouští.

Sprinty C–F jsou opt-in podle priorit: bounce cluster (3a) je high-value, holiday window (3d) je quick-win.

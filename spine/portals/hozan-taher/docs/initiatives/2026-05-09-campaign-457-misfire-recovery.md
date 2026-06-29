# Iniciativa: Campaign 457 misfire — recovery + re-launch

**Status:** Aktivní — campaign paused, AV1 čeká na operátora
**Datum vytvoření:** 2026-05-09 22:30 CEST
**Trigger:** Aktivace campaign 457 ve 22:15 CEST okamžitě odhalila 4 distinct bugy v send pipeline. Žádný mail recipientovi nedoručen (oba SMTP attempts failed na auth s mrtvými legacy schránkami), ale 27 contacts se v DB falešně označilo `completed`. Iniciativa AU (production launch) je tímhle pozastavená; tohle je její prerequisite.

## Kontext

Campaign 457 byla aktivována po 1.5h pre-flight přípravě (24/7 send window, Date header Praha tz, mb-to-mb wire ověření). 5 sekund po `UPDATE campaigns SET status='running'` orchestrator's daemon zachytil campaign, začal RunCampaign, a do dvou minut narazil na 4 různé bugy. Žádné externí škody (oba pokusy SMTP-failed kvůli auth na dead schránkách), ale interní stav je rozházený: 27 contacts s phantom `completed` statusem (rollback hotov), dva send_events s `sent=true` přestože nebyly doručeny.

Zásadní zjištění: **pipeline má 4 nezávislé bugy** které samotné by možná byly tolerovatelné, ale jejich kombinace způsobila že first-launch attempt byl katastrofa. Nelze pokračovat na re-launch dokud nejsou všechny 4 fixnuté a ověřené.

## Sprinty

### AV1 — Apply migration 049 (`parent_ico` sloupec)

`runner.go` dedup-guard SQL query selektuje `contacts.parent_ico`. Sloupec neexistuje na PROD DB → query throws `pq: column "parent_ico" does not exist at position 1:53 (42703)` → dedup-guard fail-open per design. Migration `049_dedup_guard.sql` byla autorovaná v dřívějším PR, ale nikdy aplikována na PROD.

Memory `feedback_migration_apply_immediately` (HARD): napsání migrace = okamžitá lokální aplikace + verify SELECT. Druhý incident tohoto vzoru za pár dní (první byl 2026-05-05).

**Co dělat:** najít migraci 049 v `scripts/migrations/`, ověřit obsah, aplikovat na PROD `outreach-db`, verify `\d contacts` ukáže `parent_ico` sloupec, verify dedup-guard query proběhne bez chyby (`SELECT 1 FROM contacts WHERE parent_ico=''` should return 0 rows ne column missing). Po PASS: ověřit že žádná další migrace v sekvenci 050+ taky nečeká pending.

**Brána:** `\d contacts` ukazuje `parent_ico`, dedup-guard log po dalším send-attemptu nehází column-missing error.

### AV2 — Vyčistit YAML config od legacy schránek

`features/inbound/orchestrator/Dockerfile` kopíruje `modules/outreach/configs/` do image. Tento adresář drží YAML soubor s legacy schránkami (`mazher.a@email.cz`, `a.mazher@email.cz`, plus 2 další) z doby před migrací 090. Migration 090 (dnes večer) odstranila tyhle schránky z DB tabulky `outreach_mailboxes`, ale YAML zůstal. Orchestrator's `cfg.Mailboxes` načítá YAML a overlay-uje DB schránky nahoru — výsledkem je: 4 legacy YAML + 2 nové DB = pool ze 6 schránek. Engine pickMailbox round-robin pak vezme jakoukoli, hesla legacy už neplatí.

Při campaign 457 launch engine sáhl na `mazher.a@email.cz` (dead) místo na `nowak.goran` nebo `goran.nowak`. SMTP auth fail.

**Co dělat:** najít YAML config soubor (pravděpodobně `modules/outreach/configs/config.yml` nebo `mailboxes.yml`), odstranit 4 legacy entry. Buď nahradit za prázdný seznam (ať schránky tečou jen z DB) nebo vložit naše 2 nové (nowak.goran/goran.nowak) explicitně. Commit, deploy machinery-outreach. Verify v logu po startu: `mailbox registry overlaid onto config total=2`.

**Brána:** `cfg.Mailboxes` po overlay obsahuje pouze 14227 a 14228, žádný legacy.

### AV3 — Concurrent runner — advisory lock audit

Log `[ERRO] campaign step advance matched 0 rows — concurrent runner detected` říká že 2 instance orchestratoru paralelně zpracovaly stejný `cc_id=303` (a contact 101 = cc_id 243). Vyústilo do double send_events rows pro contact 101.

Architektura má `pg_try_advisory_lock` na campaign_id přes `features/outreach/campaigns/campaign/scheduler_postgres.go`. Lock je per-campaign, ne per-contact, takže 2 instance running mohou obě dostat lock pokud lock se uvolňuje mezi ticky. Pokud obě vidí campaign v `running` status a obě tickly téměř současně, racing condition.

Pravděpodobná příčina: 2 paralelní deploys machinery-outreach v Railway (starší kontejner ještě zombuje) — Railway někdy drží old + new kontejner krátkou chvíli během redeploy. Memory `feedback_dev_server_restart_after_merge` mluví o Express, ale Go orchestrator může mít stejný problém.

**Co dělat:** verify v Railway dashboard kolik aktivních machinery-outreach instancí běží. Pokud >1 → kill all old, force fresh deploy. Pokud 1 → audit `scheduler.go` advisory lock logic, zda lock se neuvolňuje mezi `pg_try_advisory_lock` a `RunCampaign` kontaktovým loopem (pokud ano, druhý deploy mezi tím vskočí). Možná fix: lock acquisition hold přes celý RunCampaign run, ne jen scheduling decision. Audit ratchet test pro to chybí.

**Brána:** dva po sobě jdoucí campaign 457 ticky (manuální force) generují každý ~15 send_events rows, žádný `concurrent runner detected` log error.

### AV4 — Runner-engine state atomicity

26 kontaktů s `status='completed', current_step=1` ale **bez send_events rows**. Runner advansuje step PŘED tím než engine reálně potvrdí send. Pokud engine deferruje (domain rotation skip, mailbox spacing wait, mailbox cooldown), runner už označil contact completed → phantom state.

Správný design: state advance až POST send_events INSERT, atomicky v transakci. Aktuálně runner.go má step advance po enqueue, ne po send confirm. Memory `project_layout` mentions runner_audit_contract_test.go — ten test by mohl být rozšířen o tenhle invariant.

**Co dělat:** audit `features/outreach/campaigns/campaign/runner.go` step advance logic. Najít místo kde `UPDATE campaign_contacts SET current_step=...` proběhne, přesunout PO `INSERT INTO send_events` (nebo PO callback z engine.Run o úspěchu). Test: `runner_engine_atomicity_test.go` — when engine deferruje, contact MUST stay at current_step=0.

**Brána:** simulovaný engine-defer zachová `current_step=0`, status='in_sequence' (ne completed). Test merged + green.

### AV5 — Re-test mb-to-mb (post AV1-AV4 fixes)

Po dokončení AV1-AV4 znovu pustit mb-to-mb test (jak jsme dělali dnes večer): direct curl na relay /v1/submit z nowak.goran do goran.nowak, ověřit že:
- Date header `+0200` (už hotový z PR #1176/#1177)
- Send proběhne (relay log `outbound_smtp_delivered`)
- send_events row se vytvoří jen když fakticky odeslán (post-AV4 atomicity)
- žádný `concurrent runner detected` log
- žádný `dedup_guard column missing` log

**Brána:** 1 mb-to-mb send úspěšný, žádné nové errory v logu, send_events / campaign_contacts state konzistentní.

### AV6 — Re-launch campaign 457

Až AV1-AV5 PASS, znovu aktivovat 457 (status='running'). Tentokrát očekáváme:
- Engine sáhne POUZE po nowak.goran (14227) a goran.nowak (14228) — ne na legacy
- Dedup-guard běží správně, žádný fail-open warning
- 1 instance orchestratoru, advisory lock drží přes celý tick
- Runner advansuje step jen po skutečném sendu

**Brána:** první send PASS (250 OK + send_events row + recipient delivery), 30 min watch bez incidentu, pak orchestrator paceuje sám 24/7 do warmup_d0 cap.

## Mimo scope této iniciativy

- Sprint AU dokumenty zůstávají platné jako forward plán; AU2-AU6 fáze jsou závislé na dokončení AV1-AV5.
- Issue #1179 (orchestrator IMAP-direct-dial) je separate issue, neblokuje send pipeline.
- Seznam webmail TZ profile rendering quirk — necháváme, není to bug v naší codebase.

## Memory updates

Po dokončení iniciativy aktualizovat:
- `feedback_migration_apply_immediately` — připomenout že druhé porušení tohoto pravidla v 4 dnech, pokud se opakuje potřetí, eskalovat process gate
- `feedback_runner_engine_atomicity` (NEW) — runner step advance MUSÍ být po send_events INSERT, ne před enqueue
- `project_orchestrator_concurrent_runner` (NEW pokud AV3 odhalí strukturální bug) — popsat jak advisory lock interaguje s Railway hot-redeploy

## Eskalační pravidla

Pokud kdykoli během AV1-AV5 narazíme na další unforeseen bug:
1. Halt iniciativu, dokumentovat v této MD jako AV-extension
2. Otevřít separate GitHub issue
3. Operator rozhodne zda fixnout nebo defer
4. Žádný pokus o re-launch 457 dokud všechny known issues green

Cíl: **nikdy neaktivovat campaignu pokud existuje známý unfixed bug v send pipeline**.

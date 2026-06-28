# Post-Cleanup Hardening — Wiring Maps, Cron Migration, Secret Hygiene

**Status:** active
**Vlastník:** Chat A (engineering) + operátor pro destructive ops
**Datum založení:** 2026-05-02
**Datum uzavření:** —
**Trigger:** V noci 2026-05-01/02 proběhla brutální Wiring + Hardening + Indexing inventura. Spawnnuté tři paralelní read-only audit agenti vygenerovali reporty `reports/audit-2026-05-02/{dead-code,duplicates,unused-tooling,indexing}.md`. Z nich vznikl konsolidovaný `reports/audit-2026-05-02/MASTER.md` s pěti blockery, šesti high položkami a dvanácti pass kontrolami. Cleanup sweep pak smazal ~8000 LoC a aplikoval čtyři kritické Postgres indexy. Tato iniciativa exekvuje zbylé blocker + high položky a uzavírá tak inventuru jako ucelený sprint balíček.

## Kontext

Cleanup sweep prokázal že pociťovaná „velké množství nepoužitého a duplicitního kódu" byla reálně zhruba 10–15 % monorepa. Konkrétně se mergnulo pět PR — #630 přidal čtyři functional/composite indexy na `outreach-db`, #631 smazal 4135 LoC nepoužitých scripts, #632 smazal 3724 LoC mrtvých React komponent (CampaignNew, DnsAuditPanel, QualityGateModal, SendCalendar) plus jejich e2e specy a barrel exporty, #633 + #634 smazaly drobnější Go orphan helpers v `features/inbound/orchestrator` a `features/outreach/relay`.

Velmi podstatný vedlejší nález: původní agent dead-code audit byl zhruba 10× nadhodnocený, protože používal `deadcode ./services/.../cmd/...` bez `-test` flagu. Test-only callery, audit-ratchet sentinely a samostatné `_test_helper.go` soubory tak vypadaly jako dead. Po správném `deadcode -test ./...` z module rootu klesl počet ověřitelně mrtvých funkcí ze 166 na zhruba 16. Toto procedurální zjištění je teď uložené v memory `feedback_deadcode_test_flag` a musí se aplikovat při všech budoucích Go inventurách.

Co naopak audit udělal správně a posunul nás dopředu: identifikoval dva systémové paradoxy (suppression UNION sync gap, kdy UI write do `suppression_list` neflipne `contacts.status`; rate-limit absence na state-changing Go endpointech), čtyři gapy v BFF→Local refaktoringu (cron jobs jsou tichá od 2026-04-29 protože BFF teď běží lokálně, ne na Railway), a několik secret hygiene incidentů kde produkční DATABASE_URL, anti-trace bearer token a 64hex API key skončily v committed docs.

Pět blockerů a tři ze šesti high položek zbývá doexekvovat, plus tři subsystémové mapy potřebují refresh po 30+ commit driftu. Dvě jsou drobné drobnosti zařaditelné do dnešního sezení (suppression trigger, rate limit), tři jsou samostatné sprinty (cron migrace, secret rotace, mapy).

## Cíle

První cíl je obnovit pipeline observabilitu — cron jobs jsou klíčové pro IMAP polling, watchdog campaigns, mailbox heal a drift detekci, a operatérův Mac pro to není dlouhodobé řešení. Migrace 14 cron jobů do Go orchestrator daemonu vrátí 24/7 běh do produkční Railway environment a zároveň konsoliduje plánovací logiku do jediné kodebáze.

Druhý cíl je uzavřít secret hygiene gap. V committed dokumentech leží produkční DB heslo, relay bearer token a OUTREACH_API_KEY. To není akceptovatelné nezávisle na blast radius — git filter-branch + rotace všech zasažených secretů + force push je nutný sprint kterému se nevyhneme, protože z `git log -p docs/audits/` jsou ty tokeny dohledatelné komukoli s read access na repo.

Třetí cíl je dotáhnout subsystémové mapy do souladu se skutečností. `anti-trace.md` zmiňuje wireproxy a MTU 1080 a stále nereflektuje wgsocks + MTU 1100 + PersistentKeepalive 5s + ListenPort 51820 z PR #623–628. `dashboard-bff.md` je 39 commitů za pravdou (před local-dev refaktoringem). `imap-inbound.md` je 16 commitů zpoždě, protože `runFullCheckCron` se přesunul do Go (PR #370). Mapy jsou foundation pro `/start-task` discipline a pre-task echo checklist; pokud driftují, celý CAD-A2 protokol degraduje na taneček s neaktuálními fakty.

Čtvrtý cíl je systemizovat enforcement T0 HARD RULES. Šest z deseti je pouze doc-only — `feedback_extreme_testing`, `feedback_no_speculation`, `feedback_no_fabricated_test_data`, `feedback_squash_loses_features`, `feedback_no_fabricated_ui_paths` a `project_railway_db_scope` nemají statický audit ratchet. To znamená že silent regression nemá kde se zachytit. Sprint na enforcement design + implementaci pravidel (kde to dává smysl static analysis nebo grep-based check) zavře tu díru.

## Plán (sprinty)

### Sprint S1 — Drobné dnešní fixy (1 sezení) {#sprint-s1}

Cíl: zavřít dvě high položky které jsou jednoduché, mají vysokou bezpečnostní hodnotu a nezávisí na ničem dalším. Spustit dva agenty paralelně, mergnout obě, jít dál.

S1.1 — Suppression UNION sync trigger. Migration 005 udržuje `outreach_suppressions → contacts.status` v sync, ale UI write přes `POST /api/suppression` jde do `suppression_list` a tu mirror nepokrývá. Když operátor manuálně označí adresu jako bounced/complained přes UI, `contacts.status` zůstane `active`, takže další enrollment ji neodfiltruje. Riziko je tichý re-send na adresu kterou operátor právě explicitně suppressoval. Fix je rozšířit migration trigger na obě tabulky — INSERT trigger na `suppression_list` který také flipne odpovídající `contacts.status='suppressed'`. Nový migration soubor `048_suppression_list_status_sync.sql`, ON CONFLICT DO NOTHING semantika, idempotent rerun. Discipline test v `features/platform/common/sqlsuppression/suppression_sync_test.go` pokrývá oba write paths.

S1.2 — Rate limit na state-changing Go endpointy. `/api/campaigns/*`, `/api/segments/*`, `/api/replies/*` a `/api/mailboxes/release-hold` jsou autentizované přes `X-API-Key` ale nemají rate limit. Když OUTREACH_API_KEY unikl do committed docs (B4), kterýkoli kdo stáhl repo má neomezený zápis. Fix je přidat token-bucket middleware (10 req/s per IP, burst 30) v `web/server.go` zalomený kolem všech POST/PUT/DELETE handlerů. Existující per-handler logika beze změny, jen wrapper. Test v `web/rate_limit_test.go` ověřuje že 11. request během vteřiny dostane 429 s `Retry-After`.

DoD sprintu S1: oba PR mergnuté na main, oba zelené v CI (s tolerancí pre-existing inherited failures z main), discipline + rate limit testy passují, žádný regression v 1500+ stávajících orchestrator testech.

### Sprint S2 — Subsystémové mapy refresh (1 sezení) {#sprint-s2}

Cíl: přivést tři mapy do souladu se skutečným kódem v repo a tak obnovit důvěryhodnost CAD-A2 pre-task echo protokolu. Mapy jsou loadovány do kontextu před každou pipeline-touch změnou, takže pokud jsou stale, agent začíná práci s nepřesnou doménovou znalostí.

S2.1 — `docs/subsystem-maps/anti-trace.md` refresh. Map zachycuje 42-step pipeline (sender.Engine.WithAntiTrace().Run() → relay → SOCKS → wireproxy/wgsocks → Mullvad WG → SMTP). Drift od posledního refreshe pokrývá: PR #615 vyrobila in-house wgsocks (separate go.mod), PR #623 přidala wgpool (multi-endpoint Mullvad rotation), PR #625–628 vyřešily PersistentKeepalive UAPI propagaci, ListenPort pinning, MTU 1100. Žádná z těchto faktů není v aktuální mapě. Refresh agent přečte aktuální `features/outreach/anti-trace-relay/wgsocks/main.go` a `entrypoint.sh`, projde `features/outreach/relay/internal/transport/` a vrátí mapě věrný stav včetně commit SHA hlavičky a aktualizovaného diagramu egress flow.

S2.2 — `docs/subsystem-maps/dashboard-bff.md` refresh. Drift zhruba 39 commitů zahrnuje: server.js decomp (PR #305–308) rozdělil monolit do `src/server-routes/` mounter modulů, local-dev refaktoring (PR #~620+) odstranil Railway deployment dashboard service a definitivně přesunul BFF na operatérův Mac s `pnpm dev:full`. Map ještě reflektuje monolitický server.js a Railway deploy. Refresh musí zaznamenat 10 mounter modulů, popsat rolu `GO_SERVER_URL` proxy a aktualizovat sekci „Boot checks" o aktuální local-dev environment proměnné.

S2.3 — `docs/subsystem-maps/imap-inbound.md` refresh. Drift 16 commitů — PR #370 přesunul `runFullCheckCron` z BFF do Go orchestrator. To zásadně mění deployment topologii: IMAP polling už nezávisí na BFF cron, běží samostatně jako daemon goroutine v orchestrator binárce. Refresh map musí přesunout sekci „Polling scheduler" z BFF na Go orchestrator a aktualizovat sekvenční diagram tak aby reflektoval že IMAP poll → reply ingest → thread state se odehrává plně v Go.

DoD sprintu S2: tři PR (jeden per mapu), každý s commit SHA hlavičkou ze zdrojového kódu na který se odkazuje, mergnuto. CAD-drift-detection workflow nesmí flagovat žádnou ze tří map jako stale.

### Sprint S3 — Migrace BFF cron jobů do Go orchestrator (3–4 sezení) {#sprint-s3}

Cíl: 14 cron jobů které dnes spí (BFF lokálně, Railway deploy odstraněný), přesunout do Go orchestrator jako daemon goroutiny. Tím se vrátí 24/7 běh, sjednotí plánovací logika do jednoho deploy targetu (Railway orchestrator service) a uvolní operatérův Mac od role „cron host".

Nejdřív musí proběhnout inventura. S3.1 katalog vyzpovídá `features/platform/outreach-dashboard/server.js` plus mounter moduly a vytvoří tabulku <jméno cron jobu, frekvence, závislosti na DB/redis/external services, kritičnost>. Ne všechny jobs musí migrovat — některé jsou diagnostické / development-time a stačí je smazat.

S3.2 implementuje migraci IMAP poll cron + reply ingest do Go (highest leverage, jediný cron který nesmí spát i jednu minutu). Reuse existujícího `imap/poller.go` který už daemon-style běží jako goroutine; přidat scheduler tick a guard proti overlapping runs (advisory lock per mailbox).

S3.3 migruje watchdog (campaigns running ale stale send_at), bounce flip (DSN parse → suppression), mailbox heal (failed login retry). Tyto tři jsou tightly-coupled k campaign send loopu, mají sdílený stav a chce se je migrovat společně.

S3.4 migruje drift detection a metric aggregation (intelligence loop + 6h analytics). Tyto jsou nejméně urgentní a v podstatě stateless, takže se hodí na konec sprintu jako safe shake-out.

S3.5 cutover — odstraní BFF cron registrace, ověří že žádný kritický job nezůstal jen na BFF straně, smaže `features/platform/outreach-dashboard/src/server-cron/` mounter pokud osiří. Nový boot check v orchestrator main.go validuje že všechny očekávané cron daemony jsou zapnuté.

DoD sprintu S3: 14 cron jobů buď migrovaných do Go orchestrator nebo explicitně smazaných s rationale v PR description. BFF nemusí běžet 24/7 pro produkční health. Operatérův Mac může být offline a campaigns running pokračují v send/poll cyklu. Daily digest report v `reports/cron-migration/` s před/po metrikami.

### Sprint S4 — Secret hygiene rotace + git history scrub (1 destructive sezení) {#sprint-s4}

Cíl: odstranit produkční secrety z git historie, rotovat všechny exposed credentials, koordinovat downstream cache invalidace. Tento sprint je destructive (force push na main historii) takže vyžaduje explicit operator consent před každým krokem a důslednou backup proceduru.

S4.1 inventarizuje všechny exposures. Aktuálně známé: `docs/audits/verify-launch-455-2026-05-01.md:133` obsahuje plný DATABASE_URL, `docs/playbooks/SECRET-HYGIENE-SWEEP.md:72-74` má DB password + relay bearer token + 64-hex API key, `reports/brutal-2026-05-01/probe-matrix.md:6` má anti-trace bearer token. Plus historicky deleted env vars co stále žijou v git log -p. Audit agent grepne celé `git log --all -p` na regex patterny pro produkční tokeny, výstup do `reports/secret-inventory-2026-05-02.md`.

S4.2 rotuje. Operátor manuálně rotuje na Railway dashboardu: `outreach-db` POSTGRES_PASSWORD (regenerate), `anti-trace-relay` ANTI_TRACE_TOKEN (regenerate, propagate na orchestrator + dashboard env), `outreach-orchestrator` OUTREACH_API_KEY (regenerate, propagate na dashboard `.env`). Každá rotace ověřena `curl` health check že nový secret funguje před pokračováním.

S4.3 scrubne historii. `git filter-repo` (preferován před `git filter-branch` per moderní best practice) nebo `BFG Repo-Cleaner` přepíše commits které secret obsahovaly tak aby ho měly odstraněný (replacement na `<REDACTED>`). Force push na origin main. Vytvořit GitHub Issue dokumentující rotation timestamp + commit ranges; všichni s lokálním clonem musí `git reset --hard origin/main`.

S4.4 verifikuje. Re-run secret inventory grep, žádný hit. CI / Railway deploy se rolne s novými secrety. `reports/secret-rotation-2026-05-02/closeout.md` s before/after audit trail.

DoD sprintu S4: žádný produkční secret v aktuální git historii ani na Railway dashboard env vars panelu. Všechny rotované secrety potvrzeny working na production. Operatérova lokální `.env` updatovaná. Memory záznam `project_secret_rotation_2026-05-02` archivuje incident pro budoucí reference.

### Sprint S5 — T0 HARD RULE enforcement (2 sezení) {#sprint-s5}

Cíl: pro 6 z 10 doc-only T0 pravidel navrhnout a implementovat statický audit ratchet (kde aplikovatelné), nebo explicitně zaznamenat že enforcement není možný a proč. Cílový stav: každé T0 pravidlo má buď zelený CI ratchet, nebo dokumentovanou justifikaci „enforcement není feasible".

S5.1 audit current state. Pro každé T0 pravidlo katalogizovat zda existuje audit ratchet, jaká je baseline (preferován 0), kde je test soubor, a jaká je drift detekce. Output v `reports/t0-enforcement-audit-2026-05-02.md`.

S5.2 design pro každé bez ratchetu. `feedback_no_speculation` lze enforce přes regex grep proti `// TODO speculate`, `// FIXME maybe`, `assumption:` v code; baseline 0. `feedback_no_fabricated_test_data` lze enforce přes ratchet co počítá `synthetic_`/`fake_`/`example.com` patterns v `_test.go` mimo `testdata/` adresáře. `feedback_squash_loses_features` je behavioral, enforce přes pre-merge hook který flagne rebase že ztrácí commits ze zdroje. `feedback_no_fabricated_ui_paths` je hard — enforce nelze bez doménové znalosti, takže justifikuje "manual review".

S5.3 implementuje to co jde. Per ratchet samostatný PR s test souborem (typicky `services/.../tier0_<rule>_audit_test.go`) baseline 0, popis v PR description odkazuje memory soubor.

S5.4 dokumentuje v CLAUDE.md sekci „T0 enforcement matrix" tabulkou rule × ratchet × test soubor × baseline. Memory `project_t0_enforcement_state` zaznamenává stav.

DoD sprintu S5: žádné nové T0 pravidlo bez explicit enforcement decision. Při novém T0 navrhnutém v budoucnu bude muset buď přijít s ratchetem nebo s odůvodněním „nelze enforce".

## Pořadí a paralelismus

Sprint S1 a S2 jsou nezávislé a oba krátké — spustit paralelně v jednom sezení. S1 dva mikro-PR (suppression trigger + rate limit), S2 tři map refresh PR. Pět PR otevřeno, mergnuto v jeden den.

Sprint S3 (cron migrace) je dependency-heavy a vyžaduje sériový postup S3.1 → S3.2 → S3.3 → S3.4 → S3.5. Začít hned po dokončení S2 protože refreshovaná `imap-inbound.md` mapa je vstup do S3.2.

Sprint S4 (secret rotace) je orthogonální k S3 a může běžet paralelně, ale operátor musí být u toho při každé rotaci, takže ho neplánovat na stejné sezení s S3 deep-dive prací. Vlastní destructive sezení.

Sprint S5 (T0 enforcement) je technicky orthogonální ke všemu předchozímu, ale chronologicky se hodí až po S3 + S4 — ratchety pro `feedback_squash_loses_features` budou těžit z čerstvé git history po S4 scrubu, a `feedback_no_speculation` je relevantnější po cron migraci kdy je v Go kódu hodně nového.

## Open questions

První otevřená otázka je rozsah S3 cron migrace — kolik z 14 jobů reálně potřebuje 24/7 produkční běh versus kolik jsou diagnostiky které stačí spouštět ad-hoc operátorem. Inventura S3.1 to rozhodne, ale defaultní postoj by měl být „migrovat vše co se týká IMAP/send/suppression, smazat vše co je dev-time only".

Druhá otázka je timing S4 secret rotation. Force push na main historii rozbije všechny otevřené PRs (musí se rebase na nové main) a všechny lokální clony (musí git reset --hard). Je vhodné to udělat když je počet otevřených PRs nejnižší, ideálně po Sprintu S1 a S2 mergi a před začátkem S3.

Třetí otázka je co s 4 audit ratchety které drift-detection potřebuje pro `feedback_extreme_testing` (10+ test cases per change). Jak měříš „test cases per change" mechanicky? Možná `git diff --stat -- '*_test.go'` a srovnat počet add lines proti add lines v `*.go`. To není přesný proxy ale lepší než nic.

## Cross-references

- [`docs/initiatives/2026-05-01-egress-fix-rollout.md`](2026-05-01-egress-fix-rollout.md) — egress sprint S1/S2 (kernel-WG VPS) běží paralelně s tímto plánem; S2 v této iniciativě (mapy refresh) by měl reflektovat egress změny po Hetzner cutover
- [`reports/audit-2026-05-02/MASTER.md`](../../reports/audit-2026-05-02/MASTER.md) — zdroj blockerů a high položek
- [`reports/audit-2026-05-02/dead-code.md`](../../reports/audit-2026-05-02/dead-code.md) — dead-code raw findings (s caveat 10× overestimation; viz memory `feedback_deadcode_test_flag`)
- [`reports/audit-2026-05-02/duplicates.md`](../../reports/audit-2026-05-02/duplicates.md) — duplicate consolidation (BFF try/catch helper, IMAP triple, safeError) — kandidáty pro budoucí cleanup sprint, ne tato iniciativa
- Memory: `project_railway_db_scope` (T0 HARD RULE relevantní pro S1.1 + S3 cron migration), `feedback_deadcode_test_flag` (T1 procedural relevantní pro S5.2 ratchet design)

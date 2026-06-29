# Launch Readiness + Production Scaling — od stabilního produktu k prvním 20→500 kontaktům

**Status:** active
**Vlastník:** Chat A (engineering) + operátor pro launch decisions a destructive ops
**Datum založení:** 2026-05-03
**Datum uzavření:** —
**Trigger:** Po dokončení noční brutální audit + cleanup sweep (5 PRs, ~8000 LoC purged) a Sprintů S1+S2 z `2026-05-02-post-cleanup-hardening.md` (suppression UNION trigger committed, rate limit deployed, tři subsystem maps refreshed) je platforma technicky způsobilá k první ostré 20-kontaktové kampani. Sprint A6 (issue #300) je v backlogu od 2026-04-23 a zatím se nespustil, protože dílčí gaty (egress fix, anti-trace pipeline, suppression sync) vyžadovaly hardening. Tato iniciativa exekvuje cestu od „platforma postavená a auditovaná" k „prvních 500 kontaktů odbavených s 24h dohledem", a paralelně dokončuje zbývající internal-quality sprinty z předchozích plánů (S3 cron migrace, S4 secret rotace, S5 enforcement).

## Kontext

Stávající stav po 2026-05-02 cleanup je následující. Anti-trace pipeline má 8/8 STARTTLS hostů průchozích po fixu MTU 1100 + PersistentKeepalive 5s + ListenPort 51820 (PRs #623–628), wgpool rotuje přes 4 Mullvad endpointy CZ/DE/NL/SE, anti-trace-relay deploy je stabilní na Railway. Anonymity score baseline je dokumentován v `reports/anonymity/`. Suppression UNION trigger je v `scripts/migrations/048_suppression_list_status_sync.sql` ale ještě **neaplikován na produkci** — operatér musí explicitně schválit DB write. Rate limit token-bucket middleware je nasazený na všech state-changing Go endpointech přes PR #640. Tři subsystem maps (anti-trace, dashboard-bff, imap-inbound) jsou refreshované a zarovnané s aktuálním kódem, což obnovuje důvěryhodnost CAD-A2 pre-task echo discipline.

Co naopak chybí pro produkční launch je trojice klíčových gatů. První je migrace 14 BFF cron jobů do Go orchestratoru, protože dnes BFF běží jen lokálně na operatérově Macu a IMAP polling tedy spí pokud Mac usne. Bez 24/7 IMAP poll nelze validně provést „24h dohled" který Sprint A6 vyžaduje. Druhý je rotace produkčních secretů které leží v committed dokumentech (DATABASE_URL, anti-trace bearer token, OUTREACH_API_KEY) — to je hygienická povinnost před tím než půjdou na server data víc kontaktů. Třetí je dokončení LLM classifier accuracy verifikace (Sprint B2) na prvních 20 odpovědích, protože bez baseline accuracy nelze validovat reply triage kvalitu po větší kampani.

Vedle těchto core gatů je v backlogu šest kvalita-zaměřených pracovních toků (Mail Lab AT1/AT3, Operator Practice OP5, Tier 3 envconfig + package cycle, KT-B15 chaos sim) které jsou orthogonální k launch decision a běží paralelně jako background fleet. Tyto se nesmí pokoušet zahrnout do launch critical path; jejich rozvrh diktuje agent capacity, ne launch timeline.

Memory `feedback_check_backlog_when_idle` říká nikdy default do wait — když není explicit launch direction, agent pokračuje v platí backlogu. Tento plán dává tu strukturu: jasná main path k 500 kontaktům, paralelní background work fleet, explicit go/no-go per scaling stair tak aby operatér mohl kdykoli pause-resume.

## Cíle

První cíl je odbavit prvních 20 kontaktů ve Sprintu A6 podle staircase v `docs/playbooks/first-campaign-launch.md` (0 → 1 → 5 → 20) s 24h watch oknem a explicit rollback triggers. Úspěch znamená 20 SMTP delivery, ≥85% open rate baseline, ≥0% unsubscribe spike, žádný bounce → suppress flip mimo očekávání, žádná Sentry alert eskalace. Pokud kterýkoli práh padne mimo, kampaň se okamžitě pauzuje a operátor + agent dělají incident review.

Druhý cíl je škálování po validovaném 20-baseline. 100 kontaktů s pokračujícím 24h dohledem ověří že watchdog + bounce flip + IMAP poll handle 5x objem. 500 kontaktů ověří týdenní throughput cyklus. Cíl je reach 500/týden steady state do konce května 2026, s explicit go/no-go gate na každém kroku.

Třetí cíl je dokončit Sprinty S3-S5 z `2026-05-02-post-cleanup-hardening.md` paralelně s launch staircase tak aby launch timeline neblokoval internal hardening, a internal hardening neblokoval launch. Cron migrace je soft gate pro 100+ kontaktů (24/7 monitoring requirement); secret rotace je soft gate před růstem auditového povrchu; T0 enforcement je vlastní timeline.

Čtvrtý cíl je background quality fleet — Mail Lab AT1/AT3 pro test infrastructure, OP5 pro operatorův denní workflow, T3 envconfig + cycle resolve pro architectural debt. Tyto běží jako paralelní agent batch a jejich progres je orthogonální k launch staircase. Memory `project_autonomous_dev_north_star` říká „meta-level innovation, ne incremental fixy" — background fleet by měl mít minimálně jednu položku kvartálně která je strukturální zlepšení, ne jen cleanup.

## Plán (sprinty)

### Sprint L1 — Pre-launch gating (1-2 sezení) {#sprint-l1}

Cíl je zavřít tři pre-launch gaty které nesmí zůstat otevřené při první 20-kontaktové kampani. Žádný z nich není sám o sobě destructive, ale nedořešený znamená degradované odhalení problémů během launch.

L1.1 aplikuje migration 048 (suppression UNION trigger) na outreach-db. Operátor manually spustí `psql "$DATABASE_URL" -f scripts/migrations/048_suppression_list_status_sync.sql`. Verifikace: `SELECT count(*) FROM contacts WHERE status='suppressed'` před/po, plus INSERT do `suppression_list` přes UI a okamžitý SELECT na `contacts.status` aby trigger zafungoval. Trigger záznam v `operator_audit_log` confirma execution.

L1.2 spustí Phase 0 verifikaci přes `pnpm verify:launch` CLI. Tento end-to-end smoke pokrývá preflight (env vars, DB ping, pending migrations, region, branch), egress sanity (anti-trace probe na 8 SMTP hostů), template render (GDPR footer + unsubscribe URL), SMTP probe se správnými headery (issue #584), BFF preflight gate (issue #586). Pokud kterýkoli gate fialově: blocker, fix před L2.

L1.3 dokončí LLM classifier accuracy baseline (Sprint B2 / issue #311). Operátor manually classify prvních 20 reálných odpovědí jako ground truth. Agent porovná s classifier output, vypočte accuracy + precision + recall per category. Výstup `reports/classifier-baseline-2026-05-03.md` s decision: pokud accuracy ≥80%, classifier je production-ready; pokud <80%, sprint na fine-tuning few-shot examples nebo prompt změnu. Memory `feedback_no_fabricated_test_data` (T0) — žádné synthetic samples, jen real reply data.

DoD sprintu L1: migration 048 applied + verified. Phase 0 verifikace 6/6 zelená. Classifier accuracy reportována (číslo, ne assumption). Žádný open issue z labeled `priority/p0` v repo.

### Sprint L2 — První 20-kontakt kampaň + 24h watch (1 launch + 24h dohled) {#sprint-l2}

Cíl je odbavit Sprint A6 (issue #300) — prvních 20 kontaktů ostrou kampaní s pokračujícím 24h sledováním a explicit rollback triggers podle `docs/playbooks/first-campaign-launch.md`. Tento sprint je dominantně operator-driven, agent slouží jako monitoring + incident response.

L2.1 — operatér vybere segment 20 kontaktů z `contacts` table, vytvoří kampaň s template ověřeným v L1.2 (GDPR footer + unsubscribe link). Agent pre-flight verifikuje selection — `lower(trim(email))` bez záznamu v UNION suppression, statuses 'active', validní phone format pro SMS fallback (pokud v scope), žádný honeypot match. Operátor explicitně schválí `POST /api/campaigns/<id>/run`.

L2.2 — staircase 0 → 1 → 5 → 20 podle playbook. Mezi kroky pause window (1h pro 1 send, 4h pro 5 sends, 12h pro 20 sends) ve kterém agent aktivně sleduje Sentry, Railway logs, anti-trace-relay queue depth, SMTP error rate. Při kterékoli anomálii: pauza, incident triage, decision pokračovat / abort.

L2.3 — 24h dohled po dokončení 20 sends. Co se sleduje: open rate (target ≥30% baseline pro B2B cold outreach), click rate (target ≥3% z opens), bounce rate (target <5%), unsubscribe rate (target <2%), reply rate (any reply triggers operator triage), Sentry events (target 0 critical, ≤5 warnings). Hourly snapshot v `reports/launch-2026-05-XX/` per hour pro audit trail.

L2.4 — close-out report. Agent generuje `reports/launch-2026-05-XX/closeout.md` s decision matrix: scale to 100? hold? fix specific issue first? Operátor explicitně rozhoduje go/no-go pro Sprint L3.

DoD sprintu L2: 20/20 sends delivered, 24h watch window completed, closeout report s explicit decision. Žádný silent failure (každý warning má odpovídající ticket).

### Sprint L3 — Scale to 100 (1 týden) {#sprint-l3}

Cíl je 5x scale na 100 kontaktů s pokračujícím 24h dohledem. Tento krok je critical protože 100 je moment kdy se začnou objevovat distribution-tail problémy: edge case domain (cz domain s exotic MX), encoding bugs v subject/body, throttling z mailbox provider strany, anti-spam triggers.

L3.1 — preconditions check. S3 cron migration musí být dokončená (24/7 IMAP poll required), nebo operátor garantuje Mac uptime po dobu 24h x 100 sends = ~1 týden. Pokud cron migrace ještě neskončila, L3 čeká.

L3.2 — second segment 100 kontaktů, jiné domény než L2 segment (anti-overlap). Same staircase pattern: 0 → 5 → 25 → 100 s pause windows. Agent monitoring stejný jako L2 ale s rozšířeným scope: per-domain delivery rate (Seznam vs Gmail vs Outlook vs custom), per-template render success, per-mailbox sender rotation working as designed.

L3.3 — 5-denní watch okno (5 working days protože reply latency + manual classification). Reply triage daily: operátor labeluje, agent vykonává auto-action (suppress / followup / handoff). Memory `feedback_operator_focus` říká primary axis = inbound triage; tady se prakticky validuje classifier kvalita pod větším objemem.

L3.4 — close-out s rozhodnutím: scale to 500? identify specific bottleneck před scale up? rollback?

DoD sprintu L3: 100/100 delivered, 5-day watch s daily reply triage, classifier accuracy ≥80% udržená, 0 production incident.

### Sprint L4 — Scale to 500/týden steady state (2 týdny ramp + steady state) {#sprint-l4}

Cíl je dosáhnout 500 kontaktů týdně jako sustainable cadence. Tento sprint je chronologicky nejdelší protože „steady state" znamená 2-3 cykly stejného objemu bez incidentu.

L4.1 — týden 1: 250 sends. Polovina cílového cadence aby se odhalily problémy s denominátoru (např. mailbox sender pool má kapacitu pro 250/den ale ne 500/den; nebo daily bounce volume přesahuje suppression list grow rate). Per-day breakdown 50/50/50/50/50 across 5 working days.

L4.2 — týden 2: 500 sends. Full target cadence. Per-day 100/100/100/100/100. Sleduje se total-week delivery rate, total-week reply rate, watchdog stability (žádný zaseklý lock TTL), mailbox heal triggering pattern.

L4.3 — close-out po 2 týdnech. Pokud delivery rate ≥95%, reply rate ≥1%, classifier accuracy stable, žádné production incident: L4 completed jako steady state. Iniciativa přechází do maintenance mode kde agent pokračuje pokrývat backlog ale launch je validovaný.

DoD sprintu L4: 250 + 500 sends across 2 weeks, steady state cadence demonstrated, decision continue 500/week vs ramp to 1000.

### Sprint S3 — Cron migration BFF→Go orchestrator (3 sezení paralelně s L1-L3) {#sprint-s3-bridge}

Tento sprint je převzatý z `2026-05-02-post-cleanup-hardening.md#sprint-s3` a byl tam detailně rozepsaný. Klíčové milestony jsou S3.1 inventura (read-only katalog), S3.2 IMAP poll → Go (highest leverage), S3.3 watchdog/bounce flip/mailbox heal triple, S3.4 drift + intelligence loop, S3.5 cutover. Plný popis viz tamtéž.

Pro tento launch plán je relevantní toto: S3 musí dokončit S3.2 před L3 startem (24/7 IMAP poll je hard requirement pro 100+ scale). S3.3-S3.5 mohou pokračovat paralelně s L3-L4 protože nejsou send-path critical. S3.1 inventura může běžet hned bez závislostí jako read-only příprava.

### Sprint S4 — Secret rotation + git history scrub (1 destructive sezení, gating L3) {#sprint-s4-bridge}

Také převzatý z `2026-05-02-post-cleanup-hardening.md#sprint-s4`. Pro launch plán: S4 musí proběhnout před L3 startem. Důvod je že 100 kontaktů znamená 100 unsubscribe linků s tokeny vázanými na current OUTREACH_API_KEY; pokud se secret rotuje až po, všechny rozeslané linky se invalidují a unsubscribe path zhroutí. Force-push timing: ideálně mezi L2 close-out a L3 kickoff.

### Sprint Q1 — Background quality fleet, paralelní (long-running) {#sprint-q1}

Cíl je dokončit šest backlog položek z `gh issue list` které jsou orthogonální k launch path ale představují produkční debt. Tyto se exekvují jako paralelní agent batch, ne sekvenčně.

Q1.1 (issue #311 / Sprint B2): LLM classifier accuracy on first 20 replies — již výše jako L1.3 dependency.

Q1.2 (issues #284, #285, #286, #287 / AT1.1-1.4): Mail Lab foundation chain, profile API, Operator Practice integration, mail-client-fidelity stack. Tyto čtyři jsou test infrastructure pro fidelity-pinning testů; běží jako background subagent batch s Haiku model tier (read-heavy, low-stake).

Q1.3 (issues #291, #292 / AT3.1-3.2): mail-lab-ci.yml workflow + airtight LAB_ONLY=1 → 0 real SMTP. Tyto navazují na Q1.2 protože vyžadují Mail Lab foundation.

Q1.4 (issues #279, #280 / OP5.2-5.3): Operator runbook final + operator practice metrics export. Operator-driven sprint kde agent generuje first draft a operatér iterates.

Q1.5 (issues / Tier 3): envconfig single source 84→0 ad-hoc os.Getenv calls + package cycle resolve inbox↔orchestrator. Architectural debt; běží jako multi-PR sprint s baseline ratchet pro postupné snižování.

Q1.6 (issue / KT-B15): chaos sim retry. Mutation testing + chaos infrastructure pro send pipeline resilience.

Pro launch plán: žádný Q1 sub-sprint není hard gate pro L1-L4. Q1 dokončení je vlastní timeline, agent pokračuje na Q1 když není akutní launch task.

## Pořadí a paralelismus

Sprint L1 je pre-launch dnes/zítra. Spustí 3 paralelní agenty: L1.1 (DB migration apply, operator-driven), L1.2 (Phase 0 verify, agent-driven), L1.3 (classifier baseline, operator + agent).

S3.1 inventura cron jobů a S5.1 T0 enforcement audit (z 2026-05-02 doc) jsou read-only přípravy bez DB závislosti — spuštět paralelně s L1 jako background batch.

S4 secret rotace musí proběhnout před L3 start. Operatér plánuje destructive sezení mezi L2 close-out a L3 kickoff.

L2 (20-kontakt launch + 24h watch) je explicit operator-driven sprint. Agent pomáhá monitoring + incident triage ale launch decision je operátorova.

L3 a L4 závisí na L2 close-out s go decision. S3 cron migrace musí dokončit S3.2 před L3 start.

Q1 background fleet běží orthogonally celou dobu. Subagent token economy memory `feedback_subagent_token_economy` říká max 2 simultaneous default — pro Q1 batch overide na 3-4 paralelní Haiku jobs protože Mail Lab + OP5 + Tier 3 envconfig jsou deep-research read-heavy s nízkou kontextovou interferencí.

## Open questions

První otevřená otázka je timing S4 secret rotace. Force-push na main historii rozbije všechny otevřené PRs. V momentu psaní (2026-05-03 4:35) je 0 open PRs po dnešním merge sweepu, takže okno je teď dobré. Ale pokud Q1 paralelní fleet otevře nové PRs, S4 timing se posune. Decision: S4 plánovat jako blocker po L1 close-out, před spuštěním Q1 paralelního batche.

Druhá otázka je whether L2 selectovat 20 kontaktů z existing `contacts` table nebo z fresh segmentu. Existing table obsahuje 520k řádků z Garaaage scraperu, většina dormant. Operatér se musí rozhodnout: chce L2 reach existing scraped audience (rychlejší, ale data může být stale), nebo fresh ARES query (čerstvější, ale vyžaduje další ETL run). Default: existing scraped audience filtered for `last_verified_at > now() - 90 days`.

Třetí otázka je classifier baseline scope. Memory `feedback_extreme_testing` (T0) říká ≥10 test cases per change — pro classifier baseline 20 odpovědí je to absolutní minimum. Ideální by bylo 50-100 ground truth labeled odpovědí, ale operatér ještě nemá objem reply traffic na to. Decision: 20 jako minimum baseline, plán reach 100 ground-truth labels po Sprintu L3.

Čtvrtá otázka je Q1.5 envconfig sprint scope. Aktuální baseline je 84 ad-hoc os.Getenv calls (re-měřeno 2026-05-03 v reports/audits/envconfig-baseline-2026-05-03.md, originální baseline 191 z initiative byl stale po PR #373/#374/#629) v services/ tree. Snížení na 0 znamená touch ~191 souborů. Memory `project_bf_g_ops_tooling` říká orchestrator MUSÍ použít common/envconfig — to je 14 callsites z #374, takže baseline po S3 dokončení bude nižší. Decision: re-měřit baseline po S3 cutover, pak design ratchet sprint.



## Status update 2026-05-03 (sprint Q1)

Q1.1 (Sprint B2 / issue #311 LLM classifier accuracy) — agent triage 2026-05-03 zjistil že issue #311 je z TaskList completed pattern; operator-gated pro 20 ground-truth labelů. **OPERATOR-GATED.**

Q1.2 (Mail Lab AT1.1-1.4 / issues #284-#287) — všechny 4 issues triaged + closed 2026-05-03. AT1.1, AT1.2, AT1.3 jsou DONE přes PR #330 stack-rescue. AT1.4 closed jako DEFERRED (čeká na AT2.1 integration window). **DONE.**

Q1.4 (OP5.2-5.3 / issues #279, #280) — obě issues closed 2026-04-30 + 2026-05-02 přes PR #599. Operator runbook (313 lines Czech) + Go metrics endpoint + BFF fallback live. **DONE.**

Q1.5 (Tier 3 envconfig) — baseline re-měřena 2026-05-03 = 84 (down z 191). 69 net violations po annotation discount. Top packages: relay/cmd (9), contacts/prospect (7), mailboxes/mailbox (5). Estimated effort 6h k baseline 0. **READY** pro Phase 2 sprint, ne urgent.

## Cross-references

- [`docs/initiatives/2026-05-02-post-cleanup-hardening.md`](2026-05-02-post-cleanup-hardening.md) — souvisící hardening plán; Sprinty S3-S5 pokračují tam, tato iniciativa je odkazuje
- [`docs/initiatives/2026-05-01-egress-fix-rollout.md`](2026-05-01-egress-fix-rollout.md) — Hetzner CZ kernel-WG VPS rollout (paralelně s L1-L4); pokud cutover, anti-trace map z S2.1 musí refresh znova
- [`docs/playbooks/first-campaign-launch.md`](../playbooks/first-campaign-launch.md) — staircase + rollback triggers pro L2/L3/L4
- [`reports/audit-2026-05-02/MASTER.md`](../../reports/audit-2026-05-02/MASTER.md) — zdrojový audit který definoval pre-launch gaty
- [`gh issue list --state=open`](#) — backlog Q1 položek (#284-292, #279-280, #311, #300, Tier 3)
- Memory: `project_first_campaign_launch` (status pre-L1), `feedback_check_backlog_when_idle` (Q1 background fleet justification), `project_autonomous_dev_north_star` (background quality strategic axis), `feedback_subagent_token_economy` (Q1 paralelism cap)

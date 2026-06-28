# Anti-Trace — Master Merge + Rollout Coordination

**Status:** active
**Vlastník:** operátor pro merge gate, deploy gate, business decision; Chat A pro engineering execution mezi gaty
**Datum založení:** 2026-05-04
**Datum uzavření:** —
**Trigger:** Dnešní session vyrobila 18 otevřených PR (#723–#740) napříč třemi tematickými streamy — RCA + sanitizer fix, anti-trace rollout/cleanup, anonymity score improvement plus operator-flagged HELO=localhost bug. Žádný PR zatím nebyl mergnut. CI je červené napříč všemi PRs kvůli GitHub Actions billing failure (per memory `feedback_no_ci_nag` operátor odmítl fix). Bez koordinovaného merge sequence + deploy gating + verifikace V2 nelze postupovat na produkční reaktivaci kampaně 1. Tato iniciativa orchestruje merge → deploy → verify → cutover sekvenci a slouží jako single point of reference než ostatní iniciativy zavřou.

## Kontext

Aktuální stav po dnešní session je tento.

Engine 25-60% delivery rate problém má identifikovaný root cause v `features/outreach/relay/internal/delivery/sanitizer/sanitizer.go normalizeWhitespace` (collapsed multi-paragraph body do single-line wall of text). Fix v PR #723 čeká merge a deploy. Bez něj žádné delivery testování nedává smysl.

Engine HMAC dot-nanos Message-ID je tichém přepisován v `anonymizeMessageID` (PR #728 fix preserves caller value). Reply correlation v send_events.message_id vůči recipient inbox In-Reply-To headers je rozbitá pro každý Engine-originated send do mergnutí #728.

HELO=localhost bug v relay smtp.go (PR #740 fix) je nezávislý ale související — relay se vůči Seznam serverům identifikuje jako "localhost" místo real FQDN, což je anti-trace anonymity leak plus deliverability risk pro hardened recipient MTAs (Gmail, Outlook strict-check HELO syntax).

Q-prereqs (anonymity-score IMAP CLI v #725, endpoint_label log v #724) odblokují operátorské měření Sprintu V2 ale samy o sobě nemění delivery chování.

Catalog Q4 (#726) + ADR-013 Proposed (#729) + rollout init (#727) + anonymity init (#738) + Sprint A audit (#739) jsou docs-only. Můžou být mergnuty kdykoli bez deploy implication.

Sprint U2 cleanup #732 (Draft) odstraňuje SMTPDELIV_CANARY_M5 + DELIVER_DEBUG_MIME breadcrumby — gated na V2 success protože do té doby canary slouží post-deploy verifikaci.

Sprint F (#730) přidá 10 raw_smtp_test flags pro TBD elementy z Q4 katalogu. Carries dva known issues per audit comment: implicitní U1 commit (76b0df78) a content conflict s #726 na anti-trace-elements.json.

Archive cleanup PRs #731 + #733 + #735 + #737 přesunují celkem 24 mismarked-location iniciativ do `docs/archive/`. Audit script #736 lockuje budoucí drift detection.

Anti-trace verify toolkit #734 vyveze ad-hoc session diagnostic skripty pro Sprint V2 operator reuse.

CI je červené — ale ne kvůli code regresím. GitHub Actions billing failure brání spuštění workflows. Per memory `feedback_no_ci_nag` operátor toto explicitně odmítl řešit. Merge probíhá s admin override.

## Cíle

Primární cíl je **dostat sanitizer fix (PR #723) plus HELO fix (PR #740) na production Railway relay a empiricky ověřit ≥80% INBOX delivery rate přes Sprint V2 36-envelope dual-axis cross-send**. Bez tohoto base line žádná další optimalizace ani campaign reaktivace nemá rozumný expected outcome.

Sekundární cíl je **uzavřít celý anti-trace stream tří iniciativ** (incremental-verification, rollout-and-cleanup, anonymity-score-improvement) ADR-013 amendmentem dokumentujícím final state plus archivací předchůdkyň. To znamená merge všech 18 PRs v dependency-aware pořadí, deploy, V2 verifikaci, operator decision na Open Question 1 (garaaage.cz domain switch), a finální ADR.

Terciální cíl je **production cutover kampaně 1** s konzervativní cadence po V2 success + 24h stability gate. Toto je čistě operator-gated business decision a může být arbitrárně zpožděn.

## Předpoklady

První je **operator availability na merge sequencing**. 18 PRs musí být mergnuto v pořadí které respektuje dependency DAG — některé carry implicit commits z parent branches (PR #730 carries #728's commit), některé conflictují na sdílených docs souborech (#726 vs #730 na Q4 katalogu). Bez operatérova review tempa se sequence neodvíjí.

Druhá je **Railway deploy access**. Po každém merge na main musí Railway anti-trace-relay deployment proběhnout. Aktuálně auto-deploy z main branch v Railway dashboardu — operátor verifikuje že nasazený SHA odpovídá očekávanému.

Třetí je **DE wgsocks endpoint repair na production relay** (memory `egress_canonical` plus dnešní pozorování). Dnes 50% trafficu padlo na rozbitý DE Mullvad endpoint na 127.0.0.1:1081. Bez restartu relay containeru (entrypoint.sh respawnne wgsocks) Sprint V2 měření má 50% systematický drop nesouvisející s testovanou změnou. Operator-gated.

## Plán (sprinty)

Plán se rozdělí na sedm sprintů v sekvenci. **M-sprint** (Merge sequence — 18 PRs v topo pořadí), **D-sprint** (Deploy + smoke), **V-sprint** (Validation V2 dual-axis 36-envelope × 24h gate), **U-sprint** (Cleanup canary + archive), **DKIM-sprint** (operator decision a případná execution Sprintu DKIM z anonymity initiative), **P-sprint** (Production cutover kampaně 1), **A-sprint** (Final archive + ADR-013 finalize + memory updates).

Mezi M a D je tvrdá závislost (deploy nelze bez merge). D a V jsou tvrdě sekvenční. U je paralelní s DKIM po V success. P je operator-gated po V + DKIM rozhodnutí. A je terminal.

### Sprint M — Merge sequence (1 sezení) {#sprint-m}

Cíl je mergnout 18 PRs v dependency-aware pořadí tak, aby každý merge zanechal main v konzistentním stavu a žádné conflict resolution nezhoršilo dříve mergnutý PR.

M.1 — **standalone code fixy** v libovolném pořadí: #723 (sanitizer paragraph), #740 (HELO fix). Oba code-only, žádné docs ani test infra závislosti. Doporučení: #723 first protože je RCA root cause a má více regression risk; pokud V2 ukáže problém, immediate revert je čitelnější.

M.2 — **observability prereqs** paralelně: #724 (endpoint_label), #725 (anonymity-score IMAP CLI), #728 (preserve Engine HMAC MID). Všechny tři jsou nezávislé code changes bez sdílených souborů. Operator volný order.

M.3 — **docs / init / catalog** sequence po M1+M2: #726 (Sprint výsledky + Q4 catalog v1) first protože #730 conflictne na docs/audits/anti-trace-elements.json. Pak #727 (rollout init), #738 (anonymity init), #729 (ADR-013 Proposed), #739 (Sprint A audit).

M.4 — **Sprint F flag exposure** (#730) až po M3 #726 merge. Operator pravděpodobně rebase #730 aby vyřešil katalog conflict — buď přijme jednu verzi (preserve #726 31-element catalog + add raw_smtp_test_flag fields per element) nebo nahradí. Audit comment v #730 dokumentuje obě cesty.

M.5 — **archive cleanup** po M3 nezávisle: #731 (anti-trace-rebuild), #733 (3 plan-v2/brownfield/garaaage), #735 (14 Archived/Superseded), #737 (6 SPRINT-1 era). Mezi nimi není konflikt, lze paralelně. Doporučení: bottom-up alfabeticky aby cross-reference repointy zůstaly konzistentní.

M.6 — **discipline test** (#736) až po M5 protože jeho účel je catch drift a CI by selhal pokud sprint M5 ještě nemergnul všechny mismarked files.

M.7 — **toolkit + draft cleanup** v libovolném pořadí: #734 (anti-trace-verify scripts), #732 (canary cleanup — DRAFT, NEMERGOVAT do V success).

DoD M: 17 z 18 PRs mergnutých na main (kromě #732 který zůstává Draft). Žádný regression v test suites (per local run pre-merge). CI billing fixed nebo admin override per merge.

### Sprint D — Deploy + smoke (1 sezení) {#sprint-d}

D.1 — **Railway anti-trace-relay redeploy** s mergnutým main. Operator verifikuje GIT_SHA env nebo `/v1/egress-debug` reflects nový build SHA.

D.2 — **DE wgsocks restart** (operator-gated separate action). Buď container restart (respawnne všechny wgsocks proces) nebo dočasný shrink `WIREPROXY_POOL_CONFIG` na 1 endpoint (jen CZ) dokud DE neopraví. Bez tohoto kroku V2 měření má 50% systematický drop.

D.3 — **smoke test** přes existující toolkit (`scripts/anti-trace-verify/sprint_y.sh` po merge #734). 5 envelope mb3→mb2 přes /v1/submit s production heavy-01-intro template body. Očekáváno ≥4/5 INBOX (vs Sprint Y 3/5 pre-fix). Pokud výsledek <4/5 → rollback PR #723 + investigate.

D.4 — **HELO smoke** post-deploy. IMAP probe libovolných 3 nedávných sendů, verify Received chain reads `from email.cz` nebo `from mail.local` (nikoli `from localhost`).

DoD D: nový build live, DE pool zdravý nebo dočasně shrunk, smoke ≥4/5 INBOX, HELO header z localhost na FQDN.

### Sprint V — Validation V2 dual-axis (1 sezení + 24h gate) {#sprint-v}

V.1 — **mb-to-mb axis** (36 envelope cross-send přes /v1/submit). 4 sender mailboxů × 3 production templates × 3 recipient mailboxů. 30s sleep mezi sendy. Po drain queue clear (`GET /v1/status` returns `pending_envelopes:0`) plus 60s indexing wait, IMAP probe každého recipientu pro Message-ID (#728 preserves Engine HMAC, takže lookup matches wire format). Cílová metrika: ≥80% INBOX, baseline anonymity score ~60/100 (per Sprint A1 finding mb-to-mb cannot validate L3+L4).

V.2 — **Engine→Gmail axis** (12 envelope, 4 senders × 3 templates → 1 Gmail recipient). Recipient = osobní Gmail z Sprint Q1. Sleep 30s mezi. IMAP probe Gmail (operator must provide app password for IMAP access, nebo manuální vizuální verifikace v Gmail UI). Cílová metrika: ≥80% INBOX, anonymity score ≥80/100 (Gmail recipient MX přidá Authentication-Results header s dkim/spf/dmarc evaluací).

V.3 — **24h stability gate**. Po V.1 + V.2 (T0) počkat 24 hodin a re-run obojí (T0+24h). Druhý run musí udržet ≥80% INBOX nebo se případně blíže k tomu co první. Drop pod 70% v druhém runu znamená že T0 byl statistický fluctation a fix nedosahuje cíl — escalate na další investigation.

V.4 — **report**. Tabulka před/po napříč 4 dimenzemi (recipient class × time window × score breakdown × INBOX rate). Commit do `docs/audits/2026-05-XX-anti-trace-v2-validation.md`.

DoD V: dva 48-envelope reporty (T0 + T0+24h) s ≥80% INBOX × ≥80 score median. Pass criterion pro Sprint P.

### Sprint U — Cleanup po V success (1 sezení) {#sprint-u}

U.1 — **canary removal** (#732 Draft → ready for merge → merge → deploy). Po V2 success je SMTPDELIV_CANARY_M5 + DELIVER_DEBUG_MIME + DRAIN_DISPATCH_M5 instrumentace dead code. Cleanup nestáhne observability (slog records remain).

U.2 — **archive predecessor initiatives**. Move `2026-05-04-anti-trace-incremental-verification.md` plus `2026-05-04-anti-trace-rollout-and-cleanup.md` do `docs/archive/` per `feedback_initiative_status_required` jakmile V2 success potvrdí jejich completion. Status header flip na "Closed" + Datum uzavření populated. Cross-reference repoint v `2026-05-04-anonymity-score-improvement.md` plus tato master initiative.

U.3 — **Q4 catalog post-V2 update**. Per-element `prior_observation` field aktualizovat výsledky V2 measurements. `status: pending` → `status: validated_safe` u 16 ALLOW elementů.

DoD U: canary code odstraněn, dva initiatives archivovány, Q4 catalog reflects V2 outcomes.

### Sprint DKIM — operator decision na Open Question 1 (1 sezení operator-gated, případně 5+ sezení execution) {#sprint-dkim}

DKIM je single biggest open architectural decision z dnešní session. Anonymity initiative Sprint A2/A3 audit potvrdil že email.cz nelze DKIM-publish (Seznam-owned), garaaage.cz vyžaduje own MTA setup, messing.dev inheriduje Seznam-pipeline limity. Operator volí ze tří cest.

DKIM.A — **akceptovat ceiling**. Document v ADR-013 amendmentu že Engine SAFE profile má strop 60/100 pro mb-to-mb scenarios protože Seznam internal hop neemituje receiving-side headers. Production B2B sends (Seznam → external) by měly L3+L4 z recipient MX, takže real-world score bude 80+. Žádná infrastructure investice. Closed-out anonymity initiative jako "Closed-Architectural-Strop" per její Maintenance section.

DKIM.B — **garaaage.cz migrace s own MTA**. Postavit Postfix nebo Dovecot na operator-owned VPS (Hetzner CZ, Vultr Praha etc.), publikovat DKIM/SPF/DMARC TXT records pro garaaage.cz, switch sender domain v `outreach_mailboxes` z @email.cz na @garaaage.cz, retire stávající 4 Seznam mailboxy. Substantial infrastructure investment — ~5 sezení engineering plus DNS propagation gates plus risk že non-Seznam sender domain má lower recipient trust.

DKIM.C — **active24.cz coordinated DKIM publish**. Operator request u current mail provider (active24.cz pro garaaage.cz) aby publikovali DKIM TXT pro outbound. Lower control než own MTA, ale eliminuje VPS cost + ops burden. Závisí na active24.cz feature support — pravděpodobně ne, ale operator decision.

DoD DKIM: operator decision dokumentovaná v ADR-013 amendmentu plus odpovídající execution path zahájena nebo accepted-as-strop.

### Sprint P — Production cutover (1 destructive sezení + 7-day stability window) {#sprint-p}

Sprint P je business decision plus operator-supervised execution. Není engineering work.

P.1 — **kampaň 1 status verify**. Currently paused (per Sprint Q stop). Confirm via `pnpm report` nebo direct DB query.

P.2 — **Engine SAFE profile config deploy**. 16 ALLOW flags z Q4 katalogu aktivované jako default Engine konfigurace na orchestrator service. Per-mailbox + per-campaign flag set.

P.3 — **konzervativní resume**. Kampaň 1 set na 5 sends per mailbox per day initial (max ~20 sendů celkem napříč 4 mailboxy). Daily delivery monitoring přes cmd/anonymity-score (Mode 2 IMAP) plus tracking pixels (gap k vyřešit separate).

P.4 — **7-day stability window**. Pokud delivery >80% maintained, postupný ramp 5/d → 30/d → 60/d → 90/d → 120/d (daily_cap). Pokud degrades, rollback flag set + investigate.

DoD P: kampaň 1 doručuje verifikovaně at scale. Daily monitoring dashboard live. 7-day window přežít bez incident.

### Sprint A — Final archive + ADR-013 finalize (1 sezení) {#sprint-a}

A.1 — **ADR-013 amendment**. Status flip Proposed → Accepted s evidencí ze Sprintu V (delivery rate ≥80% × 24h gate). Plus dokumentace SAFE profile final flag set, V2 measurement methodology, a strukturální ceiling rationale per DKIM-A/B/C decision.

A.2 — **memory updates**. `feedback_anti_trace_full_stack` HARD RULE updated s aktuální SAFE profile mandate post-deploy. `seznam_proxy_geo_mismatch` validity confirmed nebo updated podle V.2 Gmail-axis výsledků.

A.3 — **archive všech anti-trace initiatives**. Tato master initiative + tři child initiatives přesunout do `docs/archive/` s Status: Closed + Datum uzavření 2026-05-XX.

A.4 — **subsystem map cross-link**. `docs/subsystem-maps/anti-trace.md` aktualizovat s ADR-013 final reference jako canonical decision pro Engine pipeline změny.

DoD A: čtyři iniciativy archivovány, ADR-013 finalizovaný, memory updated, anti-trace map cross-linked. Anti-trace stream zavřený.

## Pořadí a paralelismus

M, D, V jsou tvrdá sekvence. Bez merge nelze deploy. Bez deploy nelze validate.

V.4 24h gate je pasivní wait. Ostatní práce může v té době pokračovat, ale ne další V/U/P/A sprinty.

U a DKIM jsou paralelní mezi sebou po V success. U je 1 sezení, DKIM-A je 1 sezení (decision-only), DKIM-B je 5+ sezení.

P navazuje na V plus na DKIM rozhodnutí (i když operator může spustit P i s DKIM-A accepted-ceiling pokud business chce go-live ASAP).

A je terminal po P plus po DKIM execution path.

Doporučené timing pokud všechno bezproblémové: M dnes/zítra, D zítra ráno, V zítra (T0) + pozítří (T0+24h), U a DKIM-A pozítří, P pozítří večer s 7-day window startem, A za týden po P success.

Realisticky s operator gates a CI billing fix mezi nimi: 1-2 týdny do A.

## Open questions

První je CI billing. PR test runs jsou červené kvůli GitHub Actions billing failure. Operator může merge přes admin override, ale absence test signal znamená každý merge nese explicit "trust local pre-merge tests" risk. Memory `feedback_no_ci_nag` říká nenabízet CI billing fix — operator to dnes znovu nepotvrdil.

Druhá je merge order pro #730. PR carries implicit U1 commit (76b0df78 — duplicates #728's privacy.go change) plus content conflict s #726 na Q4 katalogu. Operator volí: A) squash-merge po #728 (privacy.go diff stane no-op, catalog conflict resolved manuálně), B) rebase #730 onto post-#728 main (cleaner ale operator action), C) drop #730 a re-author Sprint F na clean branch po V2.

Třetí je DKIM decision timing. Sprint DKIM-A vs DKIM-B/C má kaskádový efekt na Sprint P timing. Pokud DKIM-A accept ceiling, P start hned po V. Pokud DKIM-B own MTA, P delay ~2 týdny. Operator/business decision.

Čtvrtá je gmail-axis V.2 metodologie. Currently `pnpm report` + cmd/anonymity-score nemají Gmail IMAP credentials. Operator either A) provides Gmail app password v IMAP_PASSWORD env per-run, B) skips automated scoring a verifies vizuálně v Gmail UI, C) skips Gmail-axis vůbec a accepts mb-to-mb only ceiling. (A) je nejvíc rigorous ale vyžaduje operator to revoke app password po V2.

Pátá je co když V.1 mb-to-mb klesne pod 80% nebo V.4 24h gate selže. Tehdy je rollback PR #723 nutný plus deeper investigation. Sprint M.1 pořadí #723 first explicitly preferences cleaner rollback path.

## Cross-references

- [`2026-05-04-anti-trace-incremental-verification.md`](2026-05-04-anti-trace-incremental-verification.md) — RCA + dimensional sprints; archived after V success
- [`2026-05-04-anti-trace-rollout-and-cleanup.md`](2026-05-04-anti-trace-rollout-and-cleanup.md) — předchozí rollout plán; tato iniciativa rozšiřuje
- [`2026-05-04-anonymity-score-improvement.md`](2026-05-04-anonymity-score-improvement.md) — anonymity sprint A done, L3/L4 strukturální findings
- ADR: [`ADR-013-anti-trace-safe-profile.md`](../decisions/ADR-013-anti-trace-safe-profile.md) — Proposed; will be amended in Sprint A
- Audit: [`docs/audits/2026-05-04-anonymity-header-audit.md`](../audits/2026-05-04-anonymity-header-audit.md) — Sprint A1+A2+A4 evidence
- Memory T0 HARD RULES: `feedback_anti_trace_full_stack`, `feedback_no_pii_in_commands`, `feedback_no_speculation`, `feedback_no_external_services`, `feedback_extreme_testing`, `feedback_campaign_send`
- Subsystem map: [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md) at SHA c82e95a2
- Q4 catalog: [`docs/audits/anti-trace-elements.json`](../audits/anti-trace-elements.json)
- Companion PRs (this session): #723–#740 (18 PRs total)

## Maintenance

Tato iniciativa se aktualizuje po každém sprintu — M progress (PRs mergnutých), D outcomes (build SHA, smoke result), V matrix tabulka, U cleanup confirmation, DKIM decision dokument, P daily monitoring window, A close-out artifacts. Po dokončení Sprintu A celá iniciativa flipne na Status: Closed a přesune se do `docs/archive/` per discipline test #736 (post-merge expectation).

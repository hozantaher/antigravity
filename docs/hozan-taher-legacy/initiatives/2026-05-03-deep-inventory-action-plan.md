# Deep Inventory Action Plan — 2026-05-03

**Status:** active
**Vlastník:** Chat A (engineering)
**Datum založení:** 2026-05-03
**Datum uzavření:** —
**Trigger:** Operator požádal o reindex + deep inventory + nový Plan po dnešním cleanup sweepu (~8000 LoC purged) a Sprintech S1 + S2 + Q1 z `2026-05-02-post-cleanup-hardening.md` + `2026-05-03-launch-readiness-and-scaling.md`. Reindex byl spuštěn (`pnpm rebuild-claude-knowledge`) a šest paralelních read-only inventory agentů vygenerovalo per-axis reporty (maps drift, audit ratchets, PRs+branches, production health, test coverage, architectural debt). Verifikace tří kritických zjištění odhalila nesoulady mezi dokumentací a realitou kódu, plus jednu blokující regresi v relay test suite.

## Kontext

Stávající stav po inventuře je následující. Subsystem maps drift je minimální — čtyři z pěti dosud nerefreshovaných map (`protections`, `worker`, `content-render`, `scrapers`) jsou GREEN (0 commit drift od 2026-05-01), pouze `common-libs.md` je YELLOW (5 utility commits od refreshe). Audit ratchety jsou solidní: 14 z 23 ratchetů na baseline 0 (steady state), 9 v controlled migration s identifikovanými top třemi kandidáty na ratchet down (contacts/enrichment baseline 11, mailboxes/watchdog 14, relay/transport 11). Open PRs jsou nízké (7 celkem: jeden aktivní, pět dependabot, jeden aging), orphan branches kolem 50 a 24 worktrees s pěti prune kandidáty. Test suite čítá 5700+ Go testů a 206 dashboard testů; +80 vůči 2026-04-25 baseline.

Inventura ale odhalila tři vážné nálezy které vyžadují okamžitou akci. První je blokující regrese v relay test suite — `TestLoadConfigDefaults` v `features/outreach/relay/cmd/relay/main_test.go:210` očekává `transportMode="direct"` ale config loader vrací `"proxy"`. Test failuje na všech runech. Pravděpodobná příčina je drift mezi egress canonical work (PRs #623–628 wgsocks/wgpool/MTU 1100) a outdated test fixturou. Tento test blokuje CI signál pro všechny relay PRs a maskuje další možné regrese.

Druhý nález je nesoulad envconfig measurement methodology mezi PR #644 (claim 84 violations) a aktuálním měřením (178 total os.Getenv calls, 144 mimo `_test.go`, 0 annotated `// envconfig-allowed:`). Discrepancy 60+ calls znamená že buď PR #644 měřil jinak (možná jen orchestrator scope, ne všechny services), nebo došlo k regresi po merge. Před plánováním Phase 2 envconfig migration sprintu musí být methodology sjednocena a baseline stanovena pravdivě.

Třetí a nejvíc nepříjemný nález je **drift mezi CLAUDE.md textem a realitou repa** ohledně server.js decompozice. CLAUDE.md (sekce „outreach-dashboard") říká: „server.js decomp (Tier 3, 2026-05-01): 9285 → 7469 LoC. 10 mounter modulů under `src/server-routes/`: unsubscribe.js, dsr.js, privacy.js, health.js, mailboxes.js, campaigns.js, replies.js, companies.js, leads.js, segments.js." Realita: adresář `src/server-routes/` **nikdy neexistoval** (žádný creation commit v `git log --all --diff-filter=A`). Existuje pouze `src/routes/replies.js` (jeden modul), `git ls-tree` ho potvrzuje. server.js je 7627 LoC s **144 inline route registracemi** (`grep -cE "^app\.(get|post|put|delete|patch)"`). TaskList tasks #305-308 (T3.4-T3.7 server.js extract) byly označeny jako completed, ale skutečná extrakce 9 z 10 mounter modulů nikdy neproběhla. Toto je dokumentační lež která mohla zmást i dnešní dashboard-bff map refresh agent (PR #636), který tvrdil „all 13 mounter modules listed with verified mount line numbers" aniž by directory existoval. Pre-task echo discipline (CAD-A2) selhala protože agent věřil CLAUDE.md textu místo aby ověřil filesystem.

Jeden bonusový nález: PR #649 (architectural debt inventory) byl při dnešním cherry-pick sanitization sweepu omylem mergnut s commitem od PR #648 (production health template). Arch-debt report content je tedy ztracen z gitu — findings ale máme v chat history a jsou zahrnuty v tomto plánu.

## Cíle

První a nejdůležitější cíl je odblokovat relay CI signal opravou `TestLoadConfigDefaults`. Bez toho jakákoli budoucí relay PR má red CI baseline a maskuje další regrese, což znehodnocuje audit ratchety. Fix je buď update test fixture na očekávání `transportMode="proxy"` (pokud je proxy nový default po egress canonical work), nebo rollback config loader change pokud test reflektoval správné default chování.

Druhý cíl je sjednotit envconfig measurement methodology a stanovit pravdivý baseline. PR #644 reportoval 84 ale aktuální měření ukazuje 178/144. Phase 2 envconfig migration nelze rozumně plánovat dokud není jasné z čeho a kam migrujeme. Potřebujeme jednotnou measure-script utilitu která je deterministická a CI-runnable, aby každý PR měl reprodukovatelný baseline check.

Třetí a strategicky nejdůležitější cíl je dokončit reálnou server.js decompozici (9 zbývajících mounter modulů) a opravit CLAUDE.md aby odpovídal realitě. Toto je multi-PR sprint protože každý mounter modul vyžaduje route extraction + test propagation + integration test že request shape je preserved. Nedělat to znamená nadále lhát v CLAUDE.md a spoléhat na zmateného nového operátora ranní routinu.

Čtvrtý cíl je ratchet down tří highest-leverage audit ratchetů (contacts/enrichment, mailboxes/watchdog, relay/transport) z baseline 11/14/11 na 0. Mechanická refactorizace, agent reportoval ~3h cumulative effort. Tím se baseline ratchets zarovnají všechny na 0 a budoucí drift detekce bude maximálně senzitivní.

Pátý cíl je hygienic cleanup — refresh `common-libs.md` (1 mapa YELLOW), prune ~50 orphan remote branches a 5 stale worktrees, plus close-out 5 stale Dependabot PRs (batch merge nebo close-as-superseded).

## Plán (sprinty)

### Sprint D1 — Critical fixes (1 sezení) {#sprint-d1}

Cíl je zavřít tři kritické nálezy které blokují další development nebo zkreslují stav. Tři paralelní agenti.

D1.1 opraví relay `TestLoadConfigDefaults`. Agent přečte `features/outreach/relay/cmd/relay/main_test.go:210` a `features/outreach/relay/internal/config/config.go` aby pochopil proč test očekává `direct` ale loader vrací `proxy`. Cross-reference s memory `project_egress_canonical` (mode table) a recent egress PRs #623–628 zjistí zda je `proxy` nový rightful default (tehdy fix test) nebo zda config loader má bug (tehdy fix loader). Pokud `proxy` je correct default po egress canonical migration, update test fixture k očekávání `proxy` s cross-reference na ADR/memory. Discipline test že future drift bude detected.

D1.2 sjednotí envconfig measurement methodology. ✓ Agent vytvořil `scripts/audits/envconfig-count.sh` jako single source of truth — počítá `os.Getenv` calls vyloučí `_test.go` a `// envconfig-allowed:` annotated lines. Updatoval `docs/audits/envconfig-baseline-2026-05-03.md` s opraveným číslem a methodology popisem. **Nález:** PR #644's 84 count byl intermediate state (batch 1 complete, batch 2 pending). Aktuální baseline je **0 violations** (ověřeno AST parserem v `TestEnvconfigConsumption_RatchetBaseline` — test PASSING). Žádná Phase 2 migrace potřeba.

D1.3 opraví CLAUDE.md drift ohledně server.js decompozice. Agent přečte aktuální stav `features/platform/outreach-dashboard/src/routes/` (zjistí že jen replies.js existuje), `features/platform/outreach-dashboard/server.js` LoC count a inline route count. Updatuje sekci „outreach-dashboard" v CLAUDE.md aby říkala pravdu: „server.js: 7627 LoC, 144 inline routes; pouze 1 z 10 plánovaných mounter modulů extracted (src/routes/replies.js); kompletní decomp tracked v Sprintu D2". Plus poznamenat memory entry o pre-task echo selhání aby budoucí agenti ověřili filesystem před tím než věří CLAUDE.md textu.

DoD sprintu D1: relay test green, envconfig measurement reproducible, CLAUDE.md doc-vs-reality reconciled, žádný PR contamination.

### Sprint D2 — Real server.js decompozice (2-3 sezení) {#sprint-d2}

Cíl je dokončit to co T3.4-T3.7 nikdy neudělaly — extrakce 9 zbývajících inline route blocks ze server.js do mounter modulů v `src/routes/`. Toto je významný refactor, vyžaduje pečlivost aby žádný request shape nezměnil chování.

D2.1 inventura — agent přečte server.js a pro každou skupinu inline routes (campaigns, mailboxes, replies, companies, leads, segments, unsubscribe, dsr, privacy, health) zjistí start/end line ranges a počet rout v skupině. Output v `reports/server-js-inventory-2026-05-03.md` s tabulkou. Replies group už extracted — slouží jako reference pattern.

D2.2 extrahuje **campaigns** mounter modul. Reuse pattern z `src/routes/replies.js`: createCampaignsRouter funkce co bere `db` + ostatní deps a vrací Express router. server.js dostane `import createCampaignsRouter from './src/routes/campaigns.js'` a `app.use('/api/campaigns', createCampaignsRouter(...))`. Test pak ověřuje že GET /api/campaigns + POST /api/campaigns/:id/run + atd vrací identické response shapes.

D2.3 podobně **mailboxes** modul. Tento je hot path (mailbox heal, score, password set), takže kontrakt-based testy jsou kritické. Testy v `src/routes/__tests__/mailboxes.routes.test.js`.

D2.4 **companies + leads + segments** — tři menší skupiny, lze v jednom PR. Tady je nejmenší riziko regrese.

D2.5 **unsubscribe + dsr + privacy** — všechny tři jsou compliance-critical (GDPR), čistá extrakce s dedicated discipline tests.

D2.6 **health** — jednoduchý read-only endpoint, finální mounter, server.js zůstane s minimálním glue code (boot + middleware mount + .listen()).

D2.7 closeout — verify server.js < 1500 LoC, 0 inline route registrations, všechny 10 modulů v `src/routes/`, integration test že `pnpm dev:full` boot + smoke 100% endpoints. Update CLAUDE.md s pravdivým stavem.

DoD sprintu D2: 10 modulů v `src/routes/`, server.js shrunk na <1500 LoC s pure glue, 144 → 0 inline route registrations, contract-shape testy proti staré server.js verzi.

### Sprint D3 — Ratchet down 3 services (1-2 sezení) {#sprint-d3}

Cíl je snížit baseline na top třech audit ratchetech z 11/14/11 na 0. Mechanická refactorizace per memory `project_bf_g_ops_tooling` slog conventions.

D3.1 ratchet contacts/enrichment slog-op (baseline 11). Agent najde 11 sites bez `op` field v slog calls v `features/acquisition/contacts/enrichment/`, přidá je. Spustí ratchet test, snižuje baseline o 1 každý passing run dokud není 0. Single PR.

D3.2 ratchet mailboxes/watchdog slog-op (baseline 14). Stejný pattern jako D3.1. Memory `project_bf_g_ops_tooling` říká `op` format je `<package>.<func>/<branch>`. Single PR.

D3.3 ratchet relay/transport slog-op (baseline 11). Stejný pattern. Memory cross-ref s `project_egress_canonical` aby agent rozuměl kontextu transport modes. Single PR.

DoD sprintu D3: tři ratchety na baseline 0, žádný drift v ostatních 20 ratchetech.

### Sprint D4 — Common-libs map refresh (1 sezení) {#sprint-d4}

Cíl je refresh `docs/subsystem-maps/common-libs.md` po 5 utility commitů driftu. Memory `feedback_initiative_status_required` říká maps musí mít commit SHA hlavičku.

D4.1 agent přečte aktuální stav `features/platform/common/`, identifikuje co je nového od 2026-05-01 (pravděpodobně `envconfig`, `sqlsuppression`, `slog conventions`, `telemetry` updates). Refresh map s commit SHA hlavičkou. PR.

DoD sprintu D4: common-libs.md drift na 0, commit SHA cited.

### Sprint D5 — Hygienic cleanup (1 sezení) {#sprint-d5}

Cíl je vyčistit ~50 orphan branches a 5 stale worktrees, plus close-out 5 dependabot PRs.

D5.1 prune orphan branches. Agent identifikuje branches které nemají odpovídající PR, jsou starší než 14 dní, a nemají recent commits. `git push origin --delete <branch>` per kandidát. Bezpečnost: skip jakékoli s `feat/`, `release/`, `hotfix/` prefixy bez explicit confirm.

D5.2 prune stale worktrees. `git worktree list` filtered podle last touch >7 dní. `git worktree remove <path>` per kandidát.

D5.3 dependabot PRs (#517-521). Agent posuzuje per-PR — pokud bumped major version v dep který je staticky safe (linter, formatter), admin-merge. Pokud breaking-changes risk (action runner, build tooling), close-as-superseded s comment.

DoD sprintu D5: ~50 → ~10 remote branches, 24 → 19 worktrees, 5 dependabot PRs resolved.

## Pořadí a paralelismus

Sprint D1 je dnes nebo zítra, tři paralelní agenti (relay test fix + envconfig methodology + CLAUDE.md correction) — všechny nezávislé, single-file edits. Token economy: dva Sonnet (D1.1 reasoning-heavy debugging, D1.3 docs nuance) + jeden Haiku (D1.2 measurement script).

Sprint D2 je sekvenční (každý mounter modul zvlášť) ale mezi D2.2 až D2.6 jsou skupiny nezávislé takže lze spawnnout paralelně po D2.1 inventuře. Předpoklad: extraction pattern je už ověřený v `src/routes/replies.js`.

Sprint D3 je tři paralelní agenty Haiku (mechanical refactor, žádné kreativní rozhodnutí).

Sprint D4 je jeden Haiku agent.

Sprint D5 je jeden Haiku agent (s operator confirm gate před `git push --delete` a `gh pr close`).

Doporučené pořadí: D1 → D4 paralelně s D3 → D2 (multi-sprint).

## Open questions

První otázka je zda relay `transportMode="proxy"` default je správný. Memory `project_egress_canonical` definuje mode table, ale agent musí explicitně verify s aktuální egress topology (Mullvad-only, wireproxy v1.1.2 / wgsocks). Pokud `direct` zůstává jako fallback v některých prostředích (např. local dev test), musí být test fixture buď environment-aware nebo split na direct-default vs proxy-default test cases.

Druhá otázka je rozsah server.js decomp v Sprintu D2. 144 → 0 inline routes je ambiciózní cíl pro jeden multi-sprint balíček. Alternativní scope: extrahovat jen top 5 hot-path skupin (campaigns, mailboxes, replies, companies, segments) jako D2 a zbývajících 5 ponechat na D6 v dalším plánu. Operator decision.

Třetí otázka je memory entry o pre-task echo selhání. Dnešní dashboard-bff map refresh agent věřil CLAUDE.md textu místo aby ověřil filesystem. Memory rule typu `feedback_verify_before_doc_claim` by mohlo zachytit pattern: před tím než agent píše „X exists per CLAUDE.md", musí `find` nebo `ls` verify. Zda toto memory přidat či ne.

Čtvrtá otázka je timing relativně k existujícím sprintů. Sprint S3 (cron migrace) z `2026-05-02-post-cleanup-hardening.md` a sprint L1-L4 (launch staircase) z `2026-05-03-launch-readiness-and-scaling.md` jsou stále v plánu. Sprint D1-D5 by neměl blokovat tyto launch-path sprinty, ale D2 (server.js decomp) může konzumovat agent capacity. Doporučení: D1 + D3 + D4 + D5 dnes/zítra (rychlé wins), D2 jako primární engineering focus dokud operátor nespustí L1.

## Cross-references

- [`docs/initiatives/2026-05-02-post-cleanup-hardening.md`](2026-05-02-post-cleanup-hardening.md) — Sprinty S1+S2 done, S3-S5 pending bridge
- [`docs/initiatives/2026-05-03-launch-readiness-and-scaling.md`](2026-05-03-launch-readiness-and-scaling.md) — L1-L4 launch path; L1.2 Phase 0 verify is AMBER (operator-gated)
- [`docs/audits/2026-05-03-cron-inventory.md`](../audits/2026-05-03-cron-inventory.md) — S3.1 inventura základ
- [`docs/audits/envconfig-baseline-2026-05-03.md`](../audits/envconfig-baseline-2026-05-03.md) — bude updated v D1.2 s correct methodology
- [`docs/audits/inventory-prod-health-2026-05-02.md`](../audits/inventory-prod-health-2026-05-02.md) — production health template (PR #648)
- [`docs/test-inventory-2026-05-03.md`](../test-inventory-2026-05-03.md) — test coverage baseline (PR #650)
- Memory: `project_egress_canonical` (D1.1 relay test context), `project_bf_g_ops_tooling` (D3 slog conventions), `feedback_deadcode_test_flag` (D2/D3 audit methodology), CLAUDE.md (D1.3 fix target)

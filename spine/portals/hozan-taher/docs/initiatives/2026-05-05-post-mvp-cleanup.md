# Post-MVP cleanup — odstranění zbylých nedoladěností

**Status:** Active
**Datum:** 2026-05-05
**Trigger:** Po dokončení deep-sweep (PRs #810 až #835) zůstaly 3 měřitelné test-suite trhliny + 4 ne-blokující sprint backlogy. Operator požaduje "vše opravit" než campaign 457 půjde do první vlny.

## Kontext

Repo prošlo dnes velkou audit kúrou. Měřená data k 14:00:
- Go orchestrator + relay: zelené (2010 + 1893 testů)
- Go campaigns: 1629 zelené, 1 statistický flake (Poisson distribuce)
- Dashboard JS: 231 souborů zelené, 1 soubor (5 testů) selhává kvůli test-env izolaci
- Issue #763 listuje 17 pre-existujících contract failures z různých diagnostických endpointů
- 0 issues na p0 / mvp-blocker / security
- Deploys live

Žádný z těchto nálezů nezablokuje první kampaňový send. Ale aby test-suite byla spolehlivý signál (memory `feedback_extreme_testing`), je potřeba je dotáhnout.

## Sprint 1 — Stabilizace test-suite (paralelní)

Tři nezávislé úlohy které mohou jít současně:

**1.1 Oprava verify-launch.test.mjs**
Pět testů (TC-05, TC-06, TC-07, TC-12, TC-17) padá na exit code 2 místo očekávaného 0/1. Důvod: test-runner spawne CLI s prázdným `DATABASE_URL` a `BFF_BASE_URL=http://localhost:__unit_test_no_bff__`. Skript pak crashne ještě před tím než dojde k CLI parsování. Cíl: buď vylepšit test-env mocking aby skript měl čím navrátit graceful failure, nebo přepsat test aby toleroval exit 2 jako "boot-time abort". Skript samotný funguje bez změny.

**1.2 Statistický flake v TestHumanSendDelayConfig**
Test bere 100 vzorků z Poissonovy distribuce s mean 120s, expectuje průměr v okně [100s, 140s]. Aktuální výběr občas dá průměr ~144s. Příčina: clampedPoisson(min=30, max=300) má pravostrannou skewness — clamping zleva vyřízne víc než zprava. Cíl: buď zvednout n na 1000 (statistická stabilita), nebo posunout upper bound na 150s (kompenzace skew), nebo udělat oboje.

**1.3 Triage 17 pre-existujících contract failures (issue #763)**
Failures jsou v `tests/contract/{anonymity-latest, bff-diagnostics, bff-threads-g3-extract, bff-campaigns-send-test, bff-mailbox-healing-cron, bff-mailboxes-extended, bff-threads-stream}`. Většina má jeden ze dvou kořenů: env-dep test čeká 502 ale endpoint refactor mu vrátí jiný status, nebo SSE/PG LISTEN setup chce in-test PG mock co koexistuje s real-pg pool. Cíl: per-test diagnostika, kategorizovat na "stale assertion" vs "skutečný regression", opravit první + filovat ticket pro druhý.

## Sprint 2 — Dependabot batch (paralelní)

Pět open dependabot PRs (#787–#791) na features/platform/mcp + features/platform/worker + dashboard. Jsou to drobné minor-version bumpy: bullmq, zod, anthropic-sdk, vitest. Cíl: pro každý PR projít CHANGELOG, ověřit že nejde o breaking change, batch admin-merge. Pokud nějaký PR shodí build, hold ten jeden a odhad cost-benefit.

## Sprint 3 — Mail-lab dokončení (paralelní)

Tři otevřené tickety na mail-lab (test-only stack, žádný PROD overlap):

**3.1 ML1.7 quickstart playbook (#219)**
`docs/playbooks/mail-lab-quickstart.md` — operator runbook. Sekce: prereq (docker, swaks), `pnpm mail-lab:up`, smoke test (send mail mezi prospect[1-5]@seznam.lab), troubleshooting běžných failure módů, teardown.

**3.2 ML1.3 Roundcube webmail (#215)**
Docker compose service `mail-lab-roundcube` na portu 8080 — webmail GUI pro inspection lab schránek. Konfigurace IMAP/SMTP host = `mail-lab-seznam`. Login operator@seznam.lab / lab-demo-only.

**3.3 ML1.2 unbound DNS resolver (#214)**
Lokální DNS resolver kontejner co odpovídá na `seznam.lab`, `gmail.lab`, `outlook.lab` zóny. Použité od ostatních lab kontejnerů pro resolving inter-domain MX. DKIM TXT záznamy už vyplnil PR #814 (init-dkim.sh).

## Sprint 4 — Mail-client S1.x cleanup

Tři tickety #196 (S1.4 RecordInbound), #197 (S1.5 round-trip integration test), #198 (S1.6 GDPR Art.17 erasure cascade). Tahle série by měla jít sekvenčně — S1.5 testuje S1.4 path, S1.6 staví na obou. Postpone do ranního batch po Sprintech 1+2+3.

## Sprint 5 — Post-launch follow-ups

Po prvním send-cyklu (až operator aktivuje campaign 457):
- ANON-S6 nightly cron (#533) — staging ratchet wiring
- Sprint A6 (#300) — expand to 20 contacts s 24h dohledem
- Recalibrate probability scorer z Day-7 reply-rate dat
- Pokrýt classifier accuracy harness reálnými ground-truth labels

Tyhle čekají na first-launch metriky.

## Acceptance

Hotovo když:
- Sprint 1 zelené: dashboard `pnpm test:fast` 0 failed; campaigns `go test ./...` clean
- Sprint 2: 0 dependabot PR otevřených starších 24h
- Sprint 3: ML1.x tickety zavřené, mail-lab plně funkční
- Sprint 4 + 5 mohou zůstat otevřené až do post-launch — nejsou MVP-required

## Pravidla

Per memory `feedback_pr_stack_eager_merge`: každý sprint = 1 comprehensive PR nebo merge-as-you-go, ne stack. Per `feedback_agent_isolation_default`: každý spawned agent s `isolation: "worktree"`.

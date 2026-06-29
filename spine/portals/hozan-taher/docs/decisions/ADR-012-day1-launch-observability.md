# ADR-012 — Day 1 launch observability stack (campaign 1, 2026-05-05 07:00)

**Status:** Proposed
**Date:** 2026-05-04
**Related:**
- ADR-002 — Autonomous Ops Architecture
- ADR-004 — Mail Lab + Operator Practice
- ADR-008 — server.js decomposition
- ADR-011 — Production egress: Hetzner CZ kernel-WG VPS
- Initiative: `docs/initiatives/2026-05-04-mvp-launch-2026-05-05.md` (PR #744)
- Playbook: `docs/playbooks/MVP-LAUNCH-2026-05-05.md` (PR #745)
- Subsystem map: `docs/subsystem-maps/anti-trace.md` (canonical 42-step pipeline)
- Memory: `feedback_anti_trace_full_stack`, `feedback_no_speculation`,
  `project_mb_to_mb_anonymity_ceiling`

## Kontext

Campaign 1 (Strojírenství — první kontakt) cuts over 2026-05-05 07:00. Tonight (2026-05-04) the question facing the team is: **co potřebuje operátor vidět, aby zachytil regresi v prvních 24 hodinách bez toho, aby musel přepínat mezi pěti kartami?**

Před touto iniciativou žil monitoring rozházený:
- Per-mailbox reputation v `Mailboxes.jsx` AnonymizationBar.
- Per-campaign send-rate v `CampaignDetail.jsx`.
- Bounce rate jenom přes ad-hoc SQL.
- Žádný strukturovaný checkpoint plán pro T+0 / T+15m / T+1h / T+4h / T+24h.
- Žádný pre-flight panel zobrazující 13-axis sanity sweep, který skript `scripts/audits/launch-sanity-2026-05-05.sh` (PR #748) pokrývá z příkazové řádky.

Operátor by zaplatil za to switchování pozorností daň, kterou nelze ráno během launch dovolit. Sender engine v `features/outreach/campaigns/sender/engine.go` drží 13 safety mechanisms; observability vrstva nad ním zaostávala.

Druhá motivace: dnešní RCA prokázalo dvě nezávislé regrese (sanitizer `normalizeWhitespace` PR #723; relay HELO=`localhost` PR #740), které šly **diagnostikovat až přes ruční IMAP harvest přes čtyři schránky**. Bez strukturovaných structured slog op fields v relay (PR #756) bude další takový bug stejně neviditelný.

## Rozhodnutí

**Zavádíme observability stack jako multi-PR balíček spojený do operátorské kokpitové vrstvy na stránce Mailboxes** plus pre-flight panel na Dashboardu plus strukturovaný observation log template plus synthetic probe scaffold (default off) plus relay slog discipline. Decision rozsah:

1. **`/api/campaigns/:id/launch-stats` + `LaunchStatsRow`** (PR #752) — last-hour + 24h sent/bounce/queue + last-send-age, render pod `AnonymizationBar` na stránce `/mailboxes`. Self-hides na non-launch dnech (zero activity + zero queue).
2. **Per-step pills** (PR #757, stacked na #752) — rozdělení odeslaných emailů na step=0 (intro), step=1 (followup1), step=2 (followup2). Skrývá scénář, kdy 5 followup-ů odejde, zatímco intro fronta se zasekne na 0.
3. **`/api/campaigns/:id/ramp-progress` + `RampStaircase`** (PR #758) — 5→10→20→30/day staircase pokrok pro Day 2+ ramp.
4. **`/api/launch-sanity?campaign_id=N` + `PreflightPanel`** (PR #760) — 13 sanity tiles na Dashboardu (`/`), 5 server-checks + 8 placeholder unknowns s copy-pasteable SQL/curl pro operátora.
5. **`docs/audits/2026-05-05-launch-observation-log.md`** template (PR #753) — předpřipravený observation log s 7 timed checkpoints (T+0/15m/1h/4h/8h/12h/24h) + escalation gates + rollback playbook.
6. **`features/inbound/orchestrator/probe/synthetic.go` + cron** (PR #759, **default off**) — flag-gated synthetic probe runner, který pošle mb-to-mb test přes anti-trace relay každých 30 minut. Hard rule: TO mailbox musí být v internal set (mb1–mb4); validovaný in-test.
7. **Relay slog op-field discipline** (PR #756) — každý `slog.Error/Warn` v `features/outreach/relay/` nese kanonický `op="relay.<package>.<func>/<branch>"` + `error` (ne `err`). Audit ratchet test fixne baseline na 0.
8. **`scripts/verify-launch.mjs` BFF prerequisite probe** (PR #761) — fast-fail s exit 2 + structured JSON, když operátor zapomene `pnpm dev` před invokací gate chainu (zavírá #586).
9. **Sequence-config alignment audit** (PR #754) — ověřuje 1:1 mapování mezi `campaigns.sequence_config` (DB) a `features/outreach/campaigns/configs/templates/*.tmpl` (disk). Status: PASS pro campaign 1.
10. **PR triage report** (PR #755) — read-only triage 10 open PRs s bucket klasifikací (READY / NEEDS REBASE / WAITING ON REVIEW / BLOCKED-BY-CI).

### Zvažované alternativy

#### Option B — All-in-one campaign cockpit page — odmítnuto

Postavit dedikovanou stránku `/launch` a redirect na ni z `/mailboxes` při aktivním launch módu. Sjednotit vše tam.

**Proč ne:** dvojí pravda zdroje. Operátor během launch nepřestává řešit reputation per mailbox — to je primárně jeho práce v T+0 až T+1h. Přesun do dedikované stránky znamená, že buď AnonymizationBar je duplikovaný na obou, nebo `/mailboxes` během launch ztrácí kontext. Zvolili jsme augmentaci jediné výchozí stránky.

#### Option C — Deferral synthetic probe na post-launch sprint — odmítnuto

Synthetic probe aktivně testuje anti-trace pipeline mb-to-mb. Mohli jsme ho deferovat až po Day 1.

**Proč ne:** scaffold nestojí nic (default off, zero side effect). Deferal by znamenal **nemít** ho v ten den, kdy se ukáže, že potřebujeme automatizovaný regression check. Memory `feedback_helo_audit_blind_spot` z PR #740 RCA: HELO=`localhost` šlo zachytit jen ručním Received-header diff přes 4 schránky. Synthetic probe + `op` fields v PR #756 udělají to samé strojově.

#### Option D — Rely on Sentry exclusively — odmítnuto

Sentry už máme. Mohli jsme spoléhat na Sentry alerty + dashboards místo BFF endpoints.

**Proč ne:** Sentry je dobrý na **error funnel** (exception, slog.Error). Není dobrý na **delivery success metric** (`MAX(sent_at)`, queue depth, ramp staircase). Operátor potřebuje vidět, **že** věci fungují, ne jenom čekat, jestli **nefungují**. Live BFF endpoints jdou refresh každých 15 s; Sentry dashboards mají větší latency.

## Důsledky

### Pozitivní

- Operátor během launch okna 06:55 → T+24h pracuje **na jediné stránce** (`/mailboxes`) s rozšířeným AnonymizationBar.
- Pre-flight panel (`/`) říká operátorovi co opravit **před tím** než stiskne Run, ne až gate chain selhal.
- Per-step pills explicitně rozliší 7 contacts at step=0 vs 193 at step=2 — dnešní cohort audit (PR #751) ukázal, že tento rozdíl jde jinak ztratit.
- Synthetic probe scaffold + slog discipline (PR #756) sníží MTTR příští anti-trace regrese z hodin (HELO bug 2026-05-04) na minuty.
- ADR + observation log + verify-launch prereq fix dělají onboarding nového operátora reprodukovatelným bez toho, aby seděl vedle původního.

### Negativní / náklady

- **+4 BFF endpoints** v `features/platform/outreach-dashboard/src/server-routes/campaigns.js` + `health.js`. Každý přidává poll-load 15-30 s. Dimenzování pool size měřeno: žádná regrese (build clean, contract tests 23+).
- **+3 React components** (`LaunchStatsRow`, `RampStaircase`, `PreflightPanel`) v `Mailboxes.jsx` / `Dashboard.jsx`. Per-step pills rostou s `seq.length` (pro campaign 1 to znamená 1, pro pozdější 3). 4 pill řada zůstává v limitu rozložení.
- **+1 Go package** `features/inbound/orchestrator/probe/`. Default off neznamená nulová cena: 220 LoC + 360 LoC testů + cron registrace v BFF. Údržbová zátěž real, ale post-launch hodnota převažuje.
- **CI billing-red** zůstane červená napříč 10 PRs. Memory `feedback_no_ci_nag` = admin override OK; operátor merguje s --admin --skip-checks. Není to tech regrese.
- **Stack PRs**: PR #757 stojí na PR #752. Topo merge order: #752 → #757 → cokoli dalšího, co dotklo `Mailboxes.jsx` (#758 ramp staircase). Memory `feedback_pr_stack_topo_order` říká: stack >= 5 PRs ve stejném balíčku → merge dle dependency DAG, ne FIFO.

### Co se rozhoduje **až po launch**

- **Synthetic probe activation**: `SYNTHETIC_PROBE_ENABLED=true` + `SYNTHETIC_PROBE_FROM_MAILBOX_ID` + `SYNTHETIC_PROBE_TO_MAILBOX_ID` flip až po T+24h zelený checkpoint. Aktivace je single env-var operation v Railway.
- **Ramp staircase target curve**: PR #758 má hardcoded 5→10→20→30. Pokud Day 1 metrics ukáže jiný profile, retarget v koeficientové konstantě v `RampStaircase.jsx`.
- **Per-step pills max count**: pokud někdy přidáme step=3 nebo step=4, `STEP_LABELS` pole v `Mailboxes.jsx` nutno rozšířit. Současný fallback `Krok ${row.step}` to neukládá tichým bugem.

### Status flip plán

- **2026-05-04 → Proposed**. Toto ADR.
- **2026-05-05 T+24h → Accepted** pokud Day 1 zelený (bounce <2 %, žádný ROLLBACK trigger, observation log filled).
- **Když Day 1 vyhodí ROLLBACK**: ADR přechází na **Superseded** a otevírá se nové ADR s lessons learned + náhradním návrhem.

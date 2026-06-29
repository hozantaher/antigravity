# CI Bypass — kdy a jak obejít červené checky

**Účel:** rozhodnout, jestli červený CI check na PR znamená skutečnou chybu v kódu nebo systémové selhání infrastruktury, a podle toho buď opravit kód, nebo PR pustit přes `gh pr merge --admin`.

---

## Proč tenhle playbook existuje

Za posledních 7 dní byla významná část selhaných CI běhů na tomto repu způsobena ne chybami v kódu, ale buď systémovými problémy (vyčerpaný GitHub Actions billing — typický symptom HTTP 402 v logu, runner-image regrese, timeouty k externí službě jako Railway PostgreSQL nebo npm registry, padající `Triage CI failures` workflow). Když `--admin` bypass používáme bez disciplíny, riskujeme, že protáhneme reálnou chybu na `main`. Když naopak čekáme na zelené CI, které nikdy nebude zelené, blokujeme deploy. Proto: explicitní rozhodovací strom a auditní stopa.

V neposledních CI runs převažují tři jména: `Go Services CI`, `Merge Gate`, `CodeQL Security Analysis`. `Merge Gate` často padá ne kvůli kódu, ale kvůli "all CI workflows green" check, který závisí na ostatních a propaguje jejich failures.

---

## Rozhodovací strom

### Krok 1 — Identifikace selhání

Otevři PR a podívej se na sekci "Checks". Pro každý červený check zjisti:

1. **Název workflow** (např. `Go Services CI`, `Merge Gate`, `CodeQL Security Analysis`).
2. **Tail logu** (`gh run view <run-id> --log-failed | tail -50`).
3. **Obvykle běží zeleně?** Pokud ano a teď je červený, je vyšší pravděpodobnost systémového problému.

### Krok 2 — Klasifikace

Použij tabulku níže. Pokud splní KTERÝKOLIV vzor v levém sloupci, je to **systémové** selhání. Pokud ne, je to **reálné**.

| Vzor v logu / chování | Klasifikace | Akce |
|----------------------|-------------|------|
| `Error: Resource not accessible by integration` | systémové (permissions/billing) | Pokud opakuje → bypass povolen |
| HTTP 402, "Payment Required", "spending limit" | systémové (GH billing) | Bypass povolen |
| `dial tcp: i/o timeout` na railway.internal nebo npm registry | systémové (síť) | Retry workflow → pokud znovu, bypass povolen |
| `runner: error preparing environment`, `Image hash mismatch` | systémové (runner) | Retry → pokud znovu, bypass povolen |
| `Merge Gate / merge-ready` failure s "all CI workflows green = false" | systémové (gate kaskáda) | Vyřeš upstream check → Merge Gate se zfixne sám |
| `Triage CI failures` workflow sám fail | systémové (workflow has bug) | Ignore — to je infra-side regrese, ne PR-side |
| `--- FAIL: Test...` (Go) nebo `Test failed` (vitest) | reálné (test) | NIKDY bypass; oprav |
| `tsc: error TS2xxx` | reálné (typecheck) | NIKDY bypass; oprav typy |
| `eslint: error` / `golangci-lint` issue | reálné (lint) | NIKDY bypass; oprav |
| `Build failed: ...` s konkrétní syntax/import chybou | reálné (build) | NIKDY bypass; oprav |
| Flaky: 1 z 10 běhů selže, ostatní zelené | reálné (flake) | Oprav nebo karanténuj test; nevyklikávej `--admin` |
| `CodeQL Security Analysis` red s konkrétní vulnerability | reálné (security) | NIKDY bypass; viz security-reviewer agent |
| `CodeQL Security Analysis` red s "could not init databases" | systémové | Retry → pokud znovu, bypass povolen |

### Krok 3 — Použití bypassu

Bypass je povolen **pouze pokud VŠECHNY červené checky jsou systémové**. Stačí jeden reálný fail a PR se opravuje, ne mergeuje.

```bash
gh pr merge <PR-N> --admin --merge   # nebo --squash dle convence
```

### Krok 4 — Auditní záznam (POVINNÉ)

Každé použití `--admin` musí být zaznamenáno do `docs/audits/admin-merges.jsonl` jedním JSON řádkem (append-only, machine-greppable). Existující baseline: PR #325 (tier A), PR #326 (tier B).

```bash
# Z root repa, jeden řádek per merge:
cat >> docs/audits/admin-merges.jsonl <<'EOF'
{"ts":"2026-MM-DDTHH:MM:SSZ","pr":<N>,"title":"<title>","tier":"A|B|C","reason":"<classification z tabulky + tail logu>","failed_checks":["<name1>","<name2>"],"reviewer":"<orchestrator (AI) | Tomáš>","local_tests":"<co lokálně prošlo>","operator_approved":"<citace explicitního souhlasu nebo 'docs-only zero risk'>"}
EOF
```

Tier convention (z PR #325 + #326 baseline):
- **A** — docs-only / zero-risk, žádné code changes
- **B** — feature s lokálně zelenými testy, ne v security-critical path (anti-trace-relay, auth, encryption, suppression)
- **C** — security-critical path nebo broader blast radius — vyžaduje **explicitní** Tomášův souhlas s citací v `operator_approved`

Pole `failed_checks` musí jmenovat každý červený check, který byl klasifikován jako systémový. Pokud byl jakýkoli check klasifikován jako reálný, **bypass se nesmí použít** (vrať se do Kroku 2).

Commit zápis ve stejném sezení jako merge:
```bash
git add docs/audits/admin-merges.jsonl
git commit -m "chore(audit): log admin-merges of PR #<N> (tier <X>)"
```

Auditní stopa = bezpečnostní záruka. `jq` nad JSONL umí zpětně dohledat každý bypass:

```bash
jq -r 'select(.pr == 325) | .reason' docs/audits/admin-merges.jsonl
jq -r 'select(.tier == "C")' docs/audits/admin-merges.jsonl   # všechny security-critical bypass
jq -s 'group_by(.tier) | map({tier: .[0].tier, count: length})' docs/audits/admin-merges.jsonl
```

---

## Co NIKDY nedělat

- **Nikdy `--admin --no-verify`.** I při systémovém selhání musí lokální pre-commit hooky (lint + typecheck) běžet — kontrolují kód, ne CI.
- **Nikdy bypass na branch `main`.** Pokud se merge do `main` rozbije kvůli nepoužitelnému CI, počkáme. Hotfix má vlastní cestu (přímý push pro `docs/handoff/*.md` + `CLAUDE.md` doc-pointer; pro reálný hotfix se otevírá PR s zelenou pre-merge sadou aspoň dvou checků).
- **Nikdy neztichat selhání pre-merge `pnpm build` lokálně.** Lokální build je poslední záchrana před deploy.
- **Nikdy bypass kvůli flaky testu** — flaky test je sám reálný problém. Buď ho oprav, nebo ho karanténuj v `_skip` souboru s issue ticketem.
- **Nikdy bypass CodeQL findings.** I když workflow padá kvůli timeout, neignoruj real findings. Pokud máš pochybnost, použij security-reviewer agent.

---

## Příklady — typické situace

**Příklad 1 (systemic, bypass OK):** PR #114, otevřený 2026-04-29. Vidíš: `tests / outreach-go` červený, tail: `dial tcp 10.0.0.x:5432: i/o timeout`. Klasifikace: síťový timeout na Railway internal PostgreSQL → systémové. Retry: `gh run rerun <id>`. Po retry zelený? Žádný bypass nepotřebuješ. Pokud zase červený se stejnou chybou: bypass povolen, zaznamenej.

**Příklad 2 (real, NIKDY bypass):** PR #115. Vidíš: `tests / outreach-go` červený, tail: `--- FAIL: TestSegmentBuilder/nace_primary`. Klasifikace: reálné. Bypass NIKDY. Oprav test (nebo kód, podle toho, co je špatně). Konzultuj memory rule `feedback_extreme_testing` — pravděpodobně chybí pokrytí boundary case.

**Příklad 3 (gate kaskáda):** Vidíš `Merge Gate / merge-ready` červený a `Go Services CI` zelený, `CodeQL` zelený, `Test Quality` zelený. Tail Merge Gate: "all CI workflows green: false" — ale nic není červené. Příčina: `Triage CI failures` workflow sám fail, gate ho započítá jako not-green. Klasifikace: systémové (gate logic bug). Akce: PR mergnout přes `--admin` nebo počkat na fix triage workflow. Zaznamenej.

---

## Aktuální 24h baseline (2026-04-30)

Z `gh run list --status failure --limit 50` v posledních 24h:

| Workflow name | Failures (24h) | Typická příčina | Bypass strategie |
|---|---|---|---|
| `Triage CI failures` | ~13 | meta-workflow, padá pokud upstream selže (sama je infra) | Ignore — tahle workflow se sama nestará o PR; je to interní triage runner |
| `Go Services CI` | ~11 | Railway PG i/o timeout, dial tcp errors do `*.railway.internal` | Retry; pak tier-A/B bypass povolen pokud lokální `go test ./... -race` zelené |
| `Merge Gate` | ~10 | "all CI workflows green = false" kaskáda od Triage / Go / CodeQL | Vyřeš upstream check → Merge Gate sám zelená; bez bypassu |
| `CodeQL Security Analysis` | ~10 | "could not init databases", runner-image regrese; rare-real findings | Retry → pokud "init databases" persistentní, tier-A bypass; reálné findings NIKDY |
| `Dashboard Real-Backend Smoke` | ~3 | Railway preview deploy timeout | Retry; pokud lokální `pnpm test:full` zelené, tier-B bypass |
| `Test Quality (Adversarial)` | ~2 | mutation-test budget exceeded (1h timeout), náhodně | Retry; pokud opakuje se stejnou TIMEOUT chybou, tier-A bypass — to je test budget, ne real fail |
| `Node Services CI` | ~1 | npm registry timeouts, sporadické | Retry; pokud opakuje, tier-A bypass |

**Tip pro Triage CI failures:** Pokud na PR nejsou červené nic JINÉHO než `Triage CI failures` + `Merge Gate`, je to čistě infra — bypass je legitimní. Důležité: nikdy bypass jen proto, že "většinou je červený". Vždy si ověř tail logu.

```bash
# Rychlá klasifikace všech červených checků na PR <N>:
gh pr checks <N> --required --json name,state,detailsUrl --jq \
  '.[] | select(.state == "FAILURE") | "\(.name)\t\(.detailsUrl)"'

# Pro každý URL otevři logs:
gh run view <run-id> --log-failed | tail -50
```

---

## Kdy hlásit problém uživateli

- Když billing byl exhausted už 24h+ a nic se neděje (pravděpodobně zapomenutý refill — explicitně zmínit, **ne nabízet** automatický fix per `feedback_no_ci_nag` memory rule).
- Když runner-image regrese trvá > 48h (možná je třeba pin verze).
- Když flaky test prolézá 3 PR po sobě (zaslouží si vlastní GH issue + karanténu).
- Když `Triage CI failures` sám padá víc než 3× po sobě (regrese v workflow definici).

Drobné jednorázové timeouty (1 PR, 1 retry, zelený) — nehlásit, je to provozní šum.

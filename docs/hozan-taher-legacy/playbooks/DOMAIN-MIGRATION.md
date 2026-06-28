# Playbook: Domain Migration

**Status:** active
**Kind:** playbook
**Owner:** tomas
**Related:**
- [Initiative: Discipline + Domain Migration](../initiatives/2026-04-22-discipline-and-domain-migration.md)
- [DOMAIN-MAP.md](../architecture/DOMAIN-MAP.md)
- [Template: `_template/service/`](../../_template/service/)

> Checklist jak bezpečně migrovat jednu doménu z `modules/outreach/internal/<pkg>/`
> nebo `services/<stará>/` do `services/<doména>/`. Určeno pro malé PRs
> (≤3 dny, 1 doména / PR, runtime-neutral).

---

## 1. Před migrací (pre-flight)

- [ ] **Owner identifikován** v [`DOMAIN-MAP.md`](../architecture/DOMAIN-MAP.md). Pokud "?" → vyřešit před psaním PR.
- [ ] **Target location potvrzen**: top-level `services/<doména>/` vs sub-service v rámci parent domény (např. `features/acquisition/contacts/sub-services/enrichment/`). Rozhodnutí je v DOMAIN-MAP sloupci "Target state" + "Sub-services".
- [ ] **Depends-on domains zmapovány** — z `DOMAIN-MAP.md` si vypiš upstream/downstream. Pokud downstream doména ještě nemigrovala, ujisti se že zachováváš její import path jako kompatibilitní alias.
- [ ] **CI je green** na `main` a `wm/development`. Nezačínat migraci na červeném stromu.
- [ ] **Žádný jiný open PR** nesahá na stejné soubory (konflikt = zbytečný pain).
- [ ] **Existující testy běží zeleně** před jakoukoli změnou (baseline run).
- [ ] **Railway service name** rozhodnut (zachovat původní alias? rename? nový deploy?). Zaznamenat do `service.yaml` → `railway_service_name`.
- [ ] **Rollback path napsaný** (co se stane když deploy failne — revert merge, co s daty, Railway service co dělat).

---

## 2. Kroky migrace

Provádět v tomto pořadí. Každý bod = jeden commit (co nejmenší, revertovatelný).

1. **Vytvořit target adresář ze šablony:**
   ```bash
   cp -r _template/service/ services/<doména>/
   ```

2. **Upravit `service.yaml`:**
   - `name`, `domain`, `owner`
   - `status: in-progress`
   - `deploy_target` + `railway_service_name`
   - `technology[]`
   - `dependencies.upstream` / `dependencies.downstream` (z DOMAIN-MAP)
   - `public_api.rest` / `events` / `schemas`
   - `invariants` (min. 3 ostré věty)
   - `slo.availability` + `slo.latency_p95_ms`
   - `sub_services` (pokud relevantní)

3. **Upravit `README.md`** — vyplnit všechny placeholder sekce (Purpose, Public API, Invariants, Getting Started, Tests, Deploy).

4. **`git mv` původního kódu.** Důležité: `git mv`, ne copy+delete (zachová history):
   ```bash
   git mv modules/outreach/internal/<pkg>/ services/<doména>/internal/<pkg>/
   # nebo pro celou službu:
   git mv services/<stará>/ services/<nová>/
   ```

5. **Update Go imports** (pokud Go):
   - V přesunutých souborech: najdi všechny `import "github.com/.../<pkg>"` a aktualizuj na novou cestu.
   - V `go.work` + všech `go.mod` které referují: aktualizovat `replace` direktivy nebo module paths.
   - `go mod tidy` v každém relevantním module root.

6. **Update pnpm workspace entries** (pokud TS/UI):
   - `pnpm-workspace.yaml`: přidat nový path, odstranit starý (pokud se odstěhoval kompletně).
   - `package.json` dependencies které referovaly na starou cestu.
   - `pnpm install` pro rebuild lockfile.

7. **Update Dockerfile + railway config:**
   - Pokud `Dockerfile.template` z šablony → přejmenuj na `Dockerfile` a customizuj (viz komentáře v šabloně).
   - `railway.json` / `railway.toml` path update (pokud Railway service root se změnil).

8. **Update `.env.example`** — nech jen env vary které doména skutečně používá. Zarovnej s produkčními vars na Railway (audit Secret hygiene).

9. **Unit testy — musí být zelené:**
   ```bash
   # Go
   go test ./services/<doména>/...
   # TS
   pnpm --filter <service> test
   ```

10. **Integration testy:**
    ```bash
    # Nastavit test DB / Redis / atd. dle konvence služby.
    # Spustit integration suite.
    ```

11. **E2E testy** (pokud doména se dotýká dashboard):
    ```bash
    cd features/platform/outreach-dashboard && pnpm test:e2e
    ```

12. **Update docs v tom samém PR:**
    - [`DOMAIN-MAP.md`](../architecture/DOMAIN-MAP.md): status domény `planned → in-progress` (během PR) → `active` (před merge).
    - `service.yaml` → `status: active` těsně před merge.
    - Relevant playbooky v `docs/playbooks/` (pokud obsahují cesty).
    - `CLAUDE.md` pokud obsahuje odkazy na starou cestu.
    - Aktuální initiative v `docs/initiatives/` (checkbox na příslušném M-tasku).

13. **Commit strategie** — malé logické kousky:
    - Commit 1: `feat(<doména>): bootstrap services/<doména>/ from template`
    - Commit 2: `refactor(<doména>): git mv <pkg> to services/<doména>/`
    - Commit 3: `refactor(<doména>): update Go imports + go.work`
    - Commit 4: `test(<doména>): verify tests pass after move`
    - Commit 5: `docs(<doména>): update DOMAIN-MAP + service.yaml status=active`

---

## 3. PR pravidla

- **Max 1 doména / PR.** Žádné "při té příležitosti přesunu ještě…"
- **Max 3 dny doba života PR.** Když to trvá déle, rozsekni na subsprinty (M1 je přesně proto rozsekaný do M1a-M1e).
- **Migrace + nový feature v jednom PR = NO GO.** Migrace = rearrangement, ne feature.
- **Rollback path explicitně v PR description** — co udělat když deploy failne:
  - Railway service pokud existuje: jak ji vrátit na starý image.
  - DB migrace pokud byly: down migration připravená.
  - Feature flags pokud jsou: jak vypnout.
- **PR title:** `refactor(<doména>): migrate <pkg> to services/<doména>/`
- **PR description template:**
  ```
  ## Co a proč
  Migrace <pkg> z <stará cesta> do services/<doména>/.
  Část iniciativy: M<N> v 2026-04-22-discipline-and-domain-migration.md.

  ## Runtime dopad
  Žádný. Jen adresářová struktura + imports.

  ## Rollback
  `git revert <merge-commit>`. Žádná data migrace, žádné schema změny.

  ## Verifikace
  - [ ] Unit tests green
  - [ ] Integration tests green
  - [ ] E2E green (pokud relevantní)
  - [ ] Manual smoke test prod (po deploy)
  ```
- **Review checklist:**
  - [ ] DOMAIN-MAP status updated
  - [ ] service.yaml vyplněný reálnými hodnotami (ne placeholders)
  - [ ] Všechny imports aktuální (grep starou cestu → 0 hits)
  - [ ] Žádné nové features, jen move + imports + docs
  - [ ] Rollback path validně popsaný

---

## 4. Po migraci (post-merge)

- [ ] **service.yaml status:** `in-progress → active`
- [ ] **DOMAIN-MAP status:** `in-progress → active`
- [ ] **Původní lokace prázdná** — ověř gripem:
  ```bash
  # Nesmí nic vracet kromě případných dočasných shim/re-export souborů.
  find modules/outreach/internal/<pkg>/ -type f 2>/dev/null
  grep -rn "modules/outreach/internal/<pkg>" --include="*.go" --include="*.ts" --include="*.js" .
  ```
- [ ] **CI green 3+ dny** po merge (bez revert / emergency hotfix).
- [ ] **Manual smoke test prod** — ověř že doména funguje end-to-end.
- [ ] **Railway deploy log** check — žádné crashloop, žádné missing env var errors.
- [ ] **Monitoring** — porovnej SLO metriky 24h před a po migraci. Regrese = issue.
- [ ] **Zavřít task** v iniciativě (checkbox v `docs/initiatives/2026-04-22-discipline-and-domain-migration.md`).

---

## 5. Rollback

**Trigger podmínky:**
- Deploy na Railway selhává po merge.
- SLO regrese > 10 % (latency, error rate, availability).
- Breaking změna v downstream doméně kterou jsme neodhalili.
- Neočekávaný side-effect v prod monitoringu.

**Postup:**

1. **Git revert merge commitu:**
   ```bash
   git revert -m 1 <merge-commit-sha>
   git push origin main   # přes PR, NE přímo (viz CLAUDE.md pravidla)
   ```

2. **Railway:** pokud se vytvořila nová service, ponechej ji offline; traffic vrať na starou (pokud stará ještě existuje).

3. **Runtime behaviour by NEMĚL být dotčen** — migrace = rearrangement. Pokud je regrese, jde o bug v migraci, ne v design rozhodnutí.

4. **Post-mortem** — napsat `docs/postmortem/YYYY-MM-DD-<doména>-migration-rollback.md`:
   - Co selhalo (symptomy, timeline).
   - Proč to CI + E2E nechytili.
   - Co změnit v tomto playbooku aby se to nestalo znovu.

5. **Status reset:** DOMAIN-MAP status doména zpět na `planned`, service.yaml status zpět na `planned` (nebo úplně smaž target dir).

---

## 6. Anti-patterns (co NEDĚLAT)

| Anti-pattern | Proč špatně | Místo toho |
|---|---|---|
| **Big-bang migrace** — všechny domény v 1 PR | Obří diff, nereviewable, rollback = revert 50 commitů | Max 1 doména / PR |
| **Migrace + nový feature v 1 PR** | Míchá rearrangement s behaviour change, rollback zahrabe feature | Feature v samostatném PR **po** migraci |
| **`cp` + `rm`** místo `git mv` | Ztratí git history → `git blame` broken | Vždy `git mv` |
| **Přesun bez update imports** | Broken build, CI rudá, nemergitelné | Imports v tom samém commitu jako move |
| **Přesun bez testů** | Regrese projde do prod, protože "vždyť jsem jen přesunul" | Unit + integration + E2E musí být zelené před merge |
| **"Při té příležitosti" scope creep** | PR roste, dny běží, merge se odkládá | Scope freeze; ostatní věci → další PR |
| **Placeholder values v service.yaml** | "Nevyplním teď, vyplním potom" = nikdy | Vyplnit reálnými hodnotami před merge |
| **Nechat starou lokaci "pro jistotu"** | Dva zdroje pravdy, drift, zmatení | Po migraci starou cestu smazat (nebo nechat jen shim re-export s TODO datem) |
| **Ignorovat downstream domény** | Breaking change v API, downstream crashne | Grep downstream → ověř že nové imports fungují |
| **Migrace za červeného CI** | Nevíš jestli rozbila CI tvoje migrace nebo už to bylo rudé | CI green jako pre-flight condition |

---

## Příklad: M1a (mailboxes registry)

Pro konkrétní příklad použití tohoto playbooku viz první sprint migrace
v [2026-04-22-discipline-and-domain-migration.md](../initiatives/2026-04-22-discipline-and-domain-migration.md) sekce M1.

Stručně:
- Source: `modules/outreach/internal/mailbox/`
- Target: `features/outreach/mailboxes/internal/registry/`
- Scope: pouze registry (ne watchdog, ne bounce — ty jsou M1b, M1c)
- Doba: ≤2 dny
- Risk: L

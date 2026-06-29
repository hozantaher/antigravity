# Stabilizační plán — hozan-taher monorepo

**Datum analýzy**: 2026-04-20  
**Cíl**: Stabilizovat repo pro bezpečný další vývoj — odblokovat CI, vyčistit zombie artefakty, opravit test infrastrukturu.

---

## Přehled problémů

| Priorita | Počet | Popis |
|----------|-------|-------|
| CRITICAL | 5 | Blokuje CI, produkční secret v repotu, broken scripts |
| HIGH | 8 | Test infra iluze, dependency mismatch, chybí security audit |
| MEDIUM | 8 | Legacy kód, chybí CI jobs, Docker pinning |
| LOW | 6 | Drobný drift, prázdné adresáře |

---

## Sprint S1 — Bezpečnost & CI unblock (3–5 dní)

**Cíl**: Odblokovat CI pipeline a eliminovat security rizika.

### Úkoly

#### S1-1 · Rotovat Railway DB heslo + opravit .gitignore [CRITICAL]
- `apps/outreach-dashboard/.env` obsahuje `outreach_053ff0c20c74809c` — heslo je untracked ale `.gitignore` ho nechytá
- Akce:
  1. Rotovat heslo v Railway dashboardu
  2. Přesunout `apps/outreach-dashboard/.env` → `.env.local`
  3. Přidat do root `.gitignore`: `**/.env` (ne jen `*.local`)
  4. Ověřit `git status` — `.env` nesmí být viditelný

#### S1-2 · Přidat `typecheck` skript — odblokovat CI [CRITICAL]
- `go-services-ci.yml:91` volá `pnpm typecheck` který **neexistuje** v `apps/outreach-dashboard/package.json`
- Každý push do `main`/`wm/*` okamžitě selže
- Akce:
  1. `apps/outreach-dashboard/package.json` → přidat `"typecheck": "tsc --noEmit"`
  2. Stejné pro `services/mcp`, `services/worker`, `services/scrapers`
  3. Pushnout, ověřit CI zelené

#### S1-3 · Opravit `.githooks/pre-push` [CRITICAL]
- Hook volá `pnpm run test:impact` a `pnpm run test:impact:e2e` — oba skripty neexistují
- Akce: přidat prázdné/stub skripty, nebo pre-push hook zjednodušit na základní `pnpm test`

#### S1-4 · Smazat `services/privacy-gateway/` a `services/anti-trace-relay/` [CRITICAL]
- Extrahované do jiného repa, zbyly jen binárky + orphaned files (celkem ~30MB)
- Adresáře jsou untracked (`??` v git status)
- Akce:
  1. `rm -rf services/privacy-gateway/ services/anti-trace-relay/`
  2. Ověřit `git status` — žádné untracked
  3. Commit: `chore: remove extracted privacy-gateway and anti-trace-relay artifacts`

#### S1-5 · Opravit `scripts/smoke-all.sh` [CRITICAL]
- Linie 31, 36–38 míří na neexistující cesty (`services/privacy-gateway`, `services/anti-trace-relay`, `services/machinery-outreach`)
- Akce: přepsat smoke-all na reálnou sadu:
  - `modules/outreach` (Go)
  - `services/mcp`, `services/worker`, `services/scrapers` (Node)
  - `apps/outreach-dashboard` (React)

---

## Sprint S2 — Dokumentace & konfigurace (3–4 dny)

**Cíl**: Synchronizovat dokumentaci s realitou, opravit CI matrix, vyčistit config.

### Úkoly

#### S2-1 · Aktualizovat dokumentaci — odstranit zombie reference
Soubory které mluví o privacy-gateway/ATR jako o aktivních službách:
- `README.md:36-50`
- `../archive/MONOREPO-STABILIZATION-PLAYBOOK.md:62-108`
- `DEVELOPMENT-PLAN.md:59-102`
- `docs/HANDOFF.md:42-62`
- `RELEASE-CHECKLIST.md` (celý sekce Privacy Gateway)
- Akce: nahradit zmínky odkazem — "extrahovány do `privacy-mail-gateway` repa (2026-04-19)"

#### S2-2 · Opravit `scripts/coverage-floors.json`
- Odstranit záznamy `privacy-gateway`, `anti-trace-relay`
- Přejmenovat `machinery-outreach` → `outreach`
- Přidat floor pro `apps/outreach-dashboard` (aktuálně 98.57%)

#### S2-3 · Opravit `infra/docker/docker-compose.yml`
- Odstranit services `privacy-gateway` (řádky ~10-30) a `anti-trace-relay` (~31-54)
- `docker compose up` nesmí failovat na prázdných build contextech

#### S2-4 · Opravit `.github/workflows/go-services-ci.yml`
- Odstranit ze smoke matrix: `privacy-gateway`, `anti-trace-relay`
- Přidat golangci-lint job (konfig `.golangci.yml` existuje ale CI ho nevolá)

#### S2-5 · Vyčistit `scripts/mutation-sample.sh`
- Řádek 9: příklad `services/anti-trace-relay/internal/auth` — nahradit reálným `modules/outreach/internal/sender`

---

## Sprint S3 — Test infrastruktura (4–5 dní)

**Cíl**: Opravit vitest coverage configs aby měřily reálný kód. Sjednotit Vitest verze.

### Úkoly

#### S3-1 · Opravit vitest coverage `include` per-service [HIGH]
- Všechny 3 services (`mcp`, `worker`, `scrapers`) mají **identický copy-paste** include který zahrnuje adresáře jiných služeb
- `services/mcp/vitest.config.ts` → include: `['mcp-server/**/*.ts']`
- `services/worker/vitest.config.ts` → include: `['worker/**/*.ts']`
- `services/scrapers/vitest.config.ts` → include: `['scrapers/**/*.ts', 'lib/**/*.ts']`
- Po opravě přeměřit skutečné pokrytí (může klesnout z "90%" na reálnou hodnotu)

#### S3-2 · Sjednotit Vitest verzi na 4.x [HIGH]
- `apps/outreach-dashboard`: `^2.1.0` → `^4.0.18`
- Dashboard má 3196 testů — před upgradem:
  1. Přečíst Vitest 3→4 migration guide (breaking changes v snapshot formátu, config API)
  2. Spustit testy, opravit případné breakage
  3. Ověřit coverage threshold stále platí

#### S3-3 · Extrahovat sdílený `tsconfig.base.json` + `vitest.base.config.ts` [MEDIUM]
- Vytvořit `packages/tsconfig/` a `packages/vitest-config/`
- Services dědí z base, overridují jen `include` a `paths`
- Odstraní copy-paste maintenance problém

#### S3-4 · Přidat CI security job [HIGH]
- Do `node-services-ci.yml` přidat:
  ```yaml
  - run: pnpm audit --audit-level=high
  ```
- Do `go-services-ci.yml` přidat:
  ```yaml
  - run: go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...
  - run: golangci-lint run
  ```

#### S3-5 · CI pro `apps/extension/server/` [MEDIUM]
- Extension nemá žádný CI job
- Přidat do `node-services-ci.yml` jako další matrix item

---

## Sprint S4 — Technický dluh (5–7 dní)

**Cíl**: Zlepšit long-term maintainability. Neblokuje vývoj, ale sníží friction.

### Úkoly

#### S4-1 · Přidat root `package.json` se skripty
```json
{
  "scripts": {
    "test:all": "pnpm -r test",
    "typecheck:all": "pnpm -r typecheck",
    "lint:all": "pnpm -r lint",
    "build:all": "pnpm -r build"
  }
}
```

#### S4-2 · Smazat legacy Nuxt stubs
- `apps/outreach-dashboard/app/` — CLAUDE.md říká "reference only, do not import"
- Přesunout do `docs/archive/nuxt-legacy/` nebo smazat

#### S4-3 · Migrace `lib/pq` → `pgx` v modules/outreach
- `lib/pq` deprecated, `pgx` má lepší performance + typy
- Netriviální migrace — izolovat do PR

#### S4-4 · Pin Docker base images
- `modules/outreach/Dockerfile:7` → `golang:alpine` bez verze
- Opravit na `golang:1.25.5-alpine3.21`
- Ověřit ostatní Dockerfiles

#### S4-5 · Sjednotit závislosti (minor drift)
- `apps/outreach-dashboard/package.json`: `express ^5.0.0` → `^5.2.1`
- `dotenv`: `^17.3.1` / `^17.4.0` → `^17.4.0` všude
- `pg`: `^8.13.0` → `^8.20.0` v dashboard

#### S4-6 · Smazat `.DS_Store` ze git history + přidat do global .gitignore
- `git rm --cached $(git ls-files --cached "*.DS_Store")`

---

## Závislosti mezi sprinty

```
S1 (bezpečnost + CI unblock)
  └─→ S2 (dokumentace, config) — lze paralelně po S1-4
        └─→ S3 (test infra)
              └─→ S4 (tech debt) — lze postupně
```

S1 musí být hotový jako první — blokuje vše ostatní (broken CI = žádná zpětná vazba).

---

## Definition of Done

Sprint je hotový když:
- [ ] CI je zelené na `wm/development`
- [ ] `smoke-all.sh` projde bez chyb
- [ ] `git status` neobsahuje žádné zombie untracked soubory
- [ ] Dokumentace neobsahuje reference na neexistující služby
- [ ] Všechny vitest configs měří jen vlastní kód

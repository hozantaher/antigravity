# Initiatives

Living docs pro multi-sprint iniciativy. Kombinují plán + sprinty + TODO + log změn do jednoho souboru — tak se stav iniciativy vyvíjí s ní.

## Konvence

**Název souboru:** `YYYY-MM-DD-<slug>.md` (datum založení, kebab-case slug).

**Struktura:**

```markdown
# <Title>

**Status:** active | done | abandoned | superseded
**Vlastník:** Chat A | Chat B | obě
**Datum založení:** YYYY-MM-DD
**Datum uzavření:** YYYY-MM-DD (pokud done/abandoned)

## Kontext

Proč tohle děláme, co řešíme.

## Cíle

- Konkrétní měřitelný cíl 1
- ...

## Plán (sprinty)

### Sprint S1 — <název> (<odhad dní>)
- [ ] Task 1
- [ ] Task 2

### Sprint S2 — ...

## Blokátory

- (žádné | seznam)

## Log

- 2026-04-21 — založeno
- 2026-04-22 — S1 dokončen, začíná S2
```

## Kdy iniciativa vs. ADR

- **Iniciativa** = WORK, multi-sprint, vyvíjí se v čase. Po dokončení se může archivovat do `docs/archive/`.
- **ADR** = DECISION, point-in-time, immutable. Zůstává v `docs/decisions/` navždy.

Iniciativa MŮŽE obsahovat ADR jako výstup (např. sprint S2 dospěl k architektonickému rozhodnutí → napíšeš ADR a odkazuješ z iniciativy).

## Archivace

Po dokončení iniciativy:
1. Status → `done`
2. Sekce `Výsledky` shrnuje co vzniklo
3. `git mv docs/initiatives/YYYY-MM-DD-<slug>.md docs/archive/`

Pokud iniciativa nahradila jinou: nová iniciativa + `Supersedes: YYYY-MM-DD-<slug>` v metadata.

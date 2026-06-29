# Architecture Decision Records (ADR)

Immutable záznamy architektonických rozhodnutí. Nemažou se — pokud rozhodnutí nahradí jiné, nové ADR dostane `Supersedes: ADR-NNN` a starý zůstává s `Superseded-By:`.

## Konvence

**Název souboru:** `ADR-NNN-<slug>.md` (trojciferné NNN, kebab-case slug).

**Struktura:**

```markdown
# ADR-NNN — Title

**Status:** Proposed | Accepted | Superseded-By: ADR-MMM
**Date:** YYYY-MM-DD
**Supersedes:** ADR-XXX  (volitelně)

## Kontext

Co řešíme, proč teď, jaké síly působí.

## Rozhodnutí

Jedna věta: "Zavádíme X."

## Důsledky

- Pozitivní: ...
- Negativní: ...
- Neutrální: ...

## Alternativy zvažované

- Alt 1 — proč ne
- Alt 2 — proč ne
```

## Kdy psát ADR

- Architektonická volba s dlouhodobými důsledky (databázový model, transport protokol, deployment topologie)
- Trade-off mezi dvěma rozumnými přístupy, kde volbu bude potřeba později obhajovat
- Změna konvence co ovlivní ≥3 developery / packages

**Nepiš ADR pro:** drobné refactory, volbu knihovny uvnitř jednoho modulu, bug fixy.

## Kdy NE psát ADR

Pokud je rozhodnutí reverzibilní za <1 den práce, stačí PR description.

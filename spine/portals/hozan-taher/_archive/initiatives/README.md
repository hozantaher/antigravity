# _archive/initiatives

Archivované iniciativy, které byly dokončené nebo nahrazené aktivnější iniciativou. Jsou sem přesunuté přes `git mv`, aby zůstala plná historie v gitu.

## Archivační policy

Initiativa patří sem, pokud:

1. **Dokončeno** — všechny sprinty zavřené, `Status: done`.
2. **Superseded** — nahradila ji novější iniciativa, která pokrývá stejný problém ve větší šíři. V master iniciativě musí být sekce "Historical backlog" s odkazem na tento archiv + seznam otevřených položek, které přešly do nové iniciativy.
3. **Abandoned** — přestali jsme tu práci dělat, důvod je v posledním logu iniciativy.

Archivace NESMAZAT — git history stále drží, ale soubor nesmí být vyhledatelný v `docs/initiatives/` aby operátor nevěřil zastaralému plánu.

## Pojmenování

Zachovat původní `YYYY-MM-DD-<slug>.md` jméno. Datum = datum založení iniciativy, ne datum archivace.

## Katalog

| Soubor | Stav při archivaci | Nahrazuje | Poznámka |
|---|---|---|---|
| `2026-04-20-monorepo-stabilization.md` | superseded | `docs/initiatives/2026-04-22-discipline-and-domain-migration.md` | S1 CI unblock + privacy-gateway/ATR removal hotovo; S2-S4 tech debt přešly do master Historical backlog. |
| `2026-04-21-outreach-unblock.md` | partially superseded | `docs/initiatives/2026-04-22-discipline-and-domain-migration.md` | S2 + S3 hotovo (pool expansion + observability + preflight); S1 (user creds) + S4 (Chat B coverage) + S5 (long-tail smoke) přešly do master Historical backlog. T-U01 (preflight UI wiring) vyřešeno commitem `c821d26`. |
| `2026-04-21-outreach-dashboard-quality-refactor.md` | partially superseded | `docs/initiatives/2026-04-22-discipline-and-domain-migration.md` | W0-W2 plně hotové (primitives + critical lies + data integrity), W3 ~60 % (`/schedule`, `/campaigns`, Settings migrace zbývá), W4 částečně (jobs cleanup e2e + alert dedup coverage audit). Follow-upy T-Q01..T-Q07 přešly do master Historical backlog. Implementační commit `9c1fdd0`. |

## Mazání

Po 6 měsících bez jakékoliv reference (grep v docs/ + memory/ vrátí 0 hits) → smaž úplně. Git history stále drží.

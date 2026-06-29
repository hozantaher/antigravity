# AS: pickAllocate Architekturní Oprava — Přesun Alokace z Relay do BFF

**Status:** Open
**Datum:** 2026-05-09
**Trigger:** Q-1 post-AR/AS review odhalil že `features/outreach/relay/cmd/relay/main.go` nevráti `pinWriter` (relay je stdlib-only, žádný DB driver per `features/outreach/relay/CLAUDE.md`). Důsledek: `pickAllocate` v `pool.go` je **dead code v produkci** — relay vždy fallback na `pickByHash`. DB `UNIQUE` constraint funguje jako bezpečnostní síť, ale samotná alokační logika (exclusive assignment) nikdy neběží. Sprint AS1 doručil UNIQUE constraint na DB úrovni, ale assignment algoritmus je stále hash modulo, ne exclusive. Toto je architekturní nesoulad.

## Diagnóza

- `features/outreach/relay/pool.go::pickAllocate` čte/zapisuje DB přes `PinReader`/`PinWriter` interface.
- `features/outreach/relay/cmd/relay/main.go` inicializuje `pool.New(cfg, nil, nil)` — oba parametry `nil`.
- Výsledek: `Pool.Pick()` volá `pickByHash()` za každého requestu, nikdy `pickAllocate()`.
- DB UNIQUE constraint na `pinned_endpoint_label` chytí duplicitní assignment jako chybu, ale nebrání tomu že hash modulo přiřazuje mailboxům stejný endpoint do té doby, než UNIQUE constraint selže.
- Relay **nemá DB driver** a nemá ho mít — je to lightweight TCP proxy, má být stdlib-only.

## Cílový stav

Po dokončení tohoto sprint:

1. **BFF vlastní alokaci.** `features/platform/outreach-dashboard/src/lib/wgpoolPinAllocator.js` (nový helper) implementuje `allocateExclusivePin(mailboxId, pool)` — vybere první volný endpoint z wgpool configu, zapíše `pinned_endpoint_label` do DB atomicky, vrátí label.
2. **Relay je čistý TCP router.** `features/outreach/relay/pool.go` odstraní `PinReader`/`PinWriter` interface + `pickAllocate()` — relay dostane label jako query param od BFF, jen routuje.
3. **BFF `getMailboxSOCKS5Addr` rozšířen.** Stávající funkce už dotazuje DB pro `preferred_country`. Nová verze navíc: pokud `pinned_endpoint_label IS NULL`, volá `allocateExclusivePin()` a zapíše ho. Při každém dalším requestu vrací pinned label přímo.
4. **Relay API zjednodušeno.** `GET /v1/imap-socks-addr?label=cz-prg-wg-101` — BFF posílá konkrétní label; relay lookup je O(1) lookup v in-memory map, žádná DB.
5. **Pool capacity monitoring zachován.** Cron pro `pinned/total` ratio přesunut z relay context do BFF (`runPoolCapacityCron` — již existuje v server.js).

## Motivace

- **Korekce dead code:** `pickAllocate` v relay je nikdy spuštěný; DB UNIQUE constraint je obranná vrstva, ne alokátor.
- **Architekturní soulad:** relay = čistý proxy bez DB. Allocation logic patří tam kde je DB access = BFF.
- **Lepší diagnostika:** BFF může logovat "alokuji endpoint X pro mailbox Y" v místě kde má kontext. Relay nemůže.
- **Výhledový GDPR/oddělení:** Separate concerns — BFF rozhoduje kdo dostane co, relay jen doručuje.

## Rozsah práce

| Krok | Soubor | Typ |
|------|--------|-----|
| 1 | `features/platform/outreach-dashboard/src/lib/wgpoolPinAllocator.js` | Nový helper |
| 2 | `features/platform/outreach-dashboard/server.js` → `getMailboxSOCKS5Addr` | Rozšíření |
| 3 | `features/outreach/relay/pool.go` | Odstranit `PinReader`/`PinWriter`/`pickAllocate` |
| 4 | `features/outreach/relay/cmd/relay/main.go` | Zjednodušit init |
| 5 | `features/outreach/relay/` HTTP handler | `label` query param místo country-based pick |
| 6 | Testy | Unit + contract tests pro allocator |

**Odhad:** 2–3 dny.

## Priority

**P1** — stávající stav má DB UNIQUE constraint jako safety net, ale assignment je hash-suboptimal. Při pool exhaustion (12+ mailboxů na 6 endpoints) začne hash modulo přiřazovat kolize, UNIQUE constraint začne failovat, mailboxy budou nedostupné bez jasné error message. Oprava předchází tomuto incidentu.

## Vazby

- Navazuje na Sprint AS1 (PR #1130 — UNIQUE constraint `pinned_endpoint_label`).
- Navazuje na Sprint AP2 (endpoint pin per mailbox lifetime).
- Koordinovat s Sprint AS2 (pool capacity cron) — `runPoolCapacityCron` zůstane v BFF, jen source dat se změní z relay HTTP na BFF DB query.
- Paměť `project_per_mailbox_proxy_deprecated.md` — sloupec `proxy_url` je legacy; tento sprint neřeší.

## Ne v tomto sprintu

- Přesun `pickAllocate` logiky z relay ven je záměr tohoto sprintu. **Nerefaktorovat** `pickAllocate` v rámci jiných PR (HARD RULE constraints).
- Mullvad pool rotation + quarantine handling — separátní follow-up.
- GDPR data-mapping update pro nový přiřazovací mechanismus — dokumentovat v `docs/legal/art30-register.md` při schválení tohoto PR.

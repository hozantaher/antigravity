# Single Persona + CZ/SK Pool Simplification

**Status:** Open
**Datum:** 2026-05-08
**Trigger:** Po smrti nowak.gorak + goran.nowak operator simplifikuje setup. Místo 2 person × 8-endpoint multi-country pool: **jedna persona, pool jen CZ + SK** (close to recipient base = CZ B2B). Jednodušší = méně permutací = méně kill modes. Plus: AO + AP frameworks dotáhnout BEFORE založení nové schránky, aby žádný operator-driven sequence schránku nemohl zabít.

## Cíl

Po dokončení:

1. **Pool: 4 CZ-Praha + 2 SK-Bratislava** — žádný BG/RO/SI. CZ-heavy = match recipient geography (čeští B2B subjekty), recipient vidí "domácí" sender IP.
2. **Single persona** — pouze 1 jméno (operator decision: Goran Nowak nebo nová persona). Konec multi-persona experimentování.
3. **AO + AP infrastructure** dokončené předtím, než zakládáme nové schránky.
4. **První mailbox vytvořený AŽ poté** — hardened-from-day-0, warmup ramp enforced, single CZ endpoint pinned, žádný operator-bypass možný.
5. **Mrtvé mailboxy** (nowak.gorak, goran.nowak) DELETE — žádný code path je nemůže "omylem" oživit.

## Proč single persona + CZ/SK only

**Single persona benefits:**

- Méně dimenze pro Seznam fraud-detection: 1 jméno = predictable identity
- Méně mailboxů = méně lifecycle management overhead
- Operátorská disciplína: 1 persona, 1 brand voice, 1 follow-up flow
- Výmaz analýzy paralysis ("kterou mailbox použít pro send?")

**CZ + SK only benefits:**

- CZ-Praha endpointy = stejná země jako recipienti = no geographic anomaly
- SK-Bratislava = neighboring country, snesitelný (CZ B2B vidí SK hojně, není flag)
- Drop BG/RO/SI = drop ~50% pool diversity ale 100% relevance
- Operátorské simplification: pool má 2 země místo 4 = méně AP4 multi-country false positives

**Co ztrácíme:**

- IP diversity pro warmup (4 CZ IPs jsou stále dost — Mullvad 4 různé IPs ze 2 subnetů)
- Geographic spreading pro anti-spam (BG/RO/SI by snižovaly volume per IP, ale Seznam-side blacklisting Mullvad ranges víc bije než per-country diversity)

## Sprint AQ1 — Drop dead mailboxes + cleanup (P0, 30 min)

Mrtvé mailboxy nowak.gorak (id=12833) a goran.nowak (id=12834) jsou nepoužitelné. Drop kompletně.

**Co uděláme:**

- Migrace `070_drop_dead_mailboxes.sql`:
  - DELETE FROM outreach_mailboxes WHERE id IN (12833, 12834)
  - CASCADE odstraní mailbox_check_cache, mailbox_check_history, mailbox_imap_state, mailbox_imap_circuit, mailbox_alerts, mailbox_cooldown_log, mailbox_auth_fails entries
  - leads, suppression_list FKs → NULL
  - Žádný způsob jak schránky restoreovat (intentional)
- Verify: `SELECT count(*) FROM outreach_mailboxes WHERE status NOT IN ('retired')` = 1 (just e2e_test fixture)

## Sprint AQ2 — Pool config CZ+SK only (P0, již hotovo Railway-side)

Railway env nastaveno 2026-05-08 ~13:45 UTC:

- `WIREPROXY_POOL_ADDRESS=10.73.178.235/32` (new account)
- `WIREPROXY_POOL_PRIVATE_KEY=wPgd...` (new account, rotated)
- `WIREPROXY_POOL_CONFIG` = 6 endpointů (4× cz-prg + 2× sk-bts)

Old account key (`CPpijFPllDtF...` + `10.65.109.229/32`) deprecated. Old pool config s BG/RO/SI dropped.

**Co zbývá:**

- Po deploy verify: `GET /v1/proxy-pool` → 6 endpointů, 4 CZ + 2 SK
- Update `features/outreach/relay/CLAUDE.md` doc: pool mode wgpool, 6 endpoints CZ+SK only
- Memory note: `project_egress_canonical` aktualizovat — Mullvad CZ-primary + SK-secondary

## Sprint AQ3 — Single persona decision + DB cleanup (P1, 1d)

**Operátorské rozhodnutí:**

- Persona name: Goran Nowak / Adrian Mazher / nová? (operator confirms)
- Telefon: 776 299 933 (CZ — current) nebo MNE (per opsec)?
- Sign-off: "{Persona}, Balkan Motors" / "{Persona}" / jiný?

**Co uděláme po operator decisi:**

- DB cleanup: DROP COLUMN `outreach_mailboxes.persona_slug` (always single persona globally → operator_settings row `persona_default`).
- `operator_settings.persona_name` (NEW key)
- `operator_settings.persona_phone` (NEW key)
- DB body intro_machinery: persona-specific lines pulled from operator_settings template variables (Sprint AF.9 deferred — now becomes blocker pro fully single-persona model).
- Drop `persona_slug` foreign keys / refs in code.

## Sprint AQ4 — Wait AP1+AP3+AP6+AO4 BEFORE creating mailbox (P0)

Tato iniciativa NEdělá nový mailbox. Pouze připraví prostředí. Mailbox creation je task **AFTER** AO+AP shipped.

**Definice hotovo:**

- AO1 (BFF IMAP SOCKS5) ✓
- AO2 (Go orchestrator IMAP SOCKS5) ✓
- AO4 (disable dev cron) ✓
- AP1 (warmup cap enforced) ✓
- AP3 (op rate limits) ✓
- AP6 (auth-fail quarantine) ✓
- Pool deploy verified (6 endpoints active)

**Then:**

- Operator vytvoří 1 novou Seznam schránku (založení z Mullvad CZ exit, ne z residential)
- INSERT do outreach_mailboxes s `lifecycle_phase='warmup_d0'`, `daily_cap_effective=5`, `preferred_country='CZ'`
- 1st send pinuje endpoint label, locked forever
- Day-0 max 5 sends — všechny operations rate-limited

## Sprint AQ5 — Document mailbox creation runbook (P1, 0.5d)

Aby operator (nebo budoucí agent) nemohl chybovat při zakládání další schránky:

- `docs/playbooks/mailbox-creation.md` step-by-step:
  1. Switch local browser to Mullvad CZ-Praha exit (jeden konkrétní)
  2. Register new Seznam mailbox přes UI (Email.cz)
  3. Verify SMTP+IMAP funguje z téhož CZ exit (nebo BFF deployed Railway test)
  4. INSERT do DB s explicit `environment`, `preferred_country='CZ'`, `lifecycle_phase='warmup_d0'`
  5. Run `pnpm pre-launch-check` → expect green
  6. Day 0: max 5 sends přes BFF; AP1 trigger refuses 6th
  7. Day 7: cap auto-relaxes to 25
  8. Day 30: cap auto-relaxes to 100

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AQ1 drop dead mailboxes | žádná | 30min | P0 |
| AQ2 pool CZ+SK only | hotovo Railway | done | P0 |
| AQ3 single persona DB cleanup | operator persona decision | 1d | P1 |
| AQ4 mailbox creation BLOCKER | AO1+AO2+AO4+AP1+AP3+AP6 | (gating) | P0 |
| AQ5 runbook docs | AQ4 hotov | 0.5d | P1 |

Total ~1.5 dne práce navíc k AO + AP. Ale AQ4 je gating gate — bez něj žádný nový mailbox.

## Otevřené otázky

1. **Persona name** — Goran Nowak / Adrian Mazher / Bohdan Mamula / nová?
2. **Body content** — současný "Vykupuju techniku..." OK pro single persona, nebo refresh?
3. **Telefon** — keep CZ 776 299 933 nebo přepnout na MNE? Per opsec.
4. **Mailbox count target** — 1 navždy? 4 jak před? Co je optimum pro 100 contacts/week?

## Co tato iniciativa NEDĚLÁ

- Vytvoření nové schránky — gate AQ4 čeká na AO+AP
- Multi-persona vrátit (intentional simplification)
- Pool re-expansion (CZ+SK je stable target)

# Strict 1:1 Endpoint↔Mailbox Lock (Sprint AS)

**Status:** Open
**Datum:** 2026-05-09
**Trigger:** Po dokončení Sprint AP2 (endpoint pin per mailbox lifetime, PR #1130) má každá schránka přiřazený konkrétní Mullvad endpoint. Algoritmus je ale **hash-based** (`SHA256(envelope_id || mailbox_id) % active_endpoints`), což znamená že při více mailboxech než endpointů dochází ke kolizím — dva mailboxy sdílejí stejný egress IP. Operator během retrospektivy 2026-05-09 ráno upozornil že pro Seznam je multiple-business-accounts ze single-Mullvad-IP signál téměř stejně podezřelý jako multi-country (paměť `features/outreach/relay/CLAUDE.md` "Seznam reject mail from Mullvad IPs as anti-VPN reputation"). Plus volume-per-endpoint roste lineárně s collision ratio — 12 mailboxů × 100 send/d = 1200 mailů/d ze 6 IPs = 200 per IP, což je vysoká koncentrace pro jednu (už tak anti-VPN-flagged) komerční VPN IP.

Sprint AS přepíná AP2 z hash-based sdílení na **exclusive 1:1 allocation**. Každý mailbox dostane vlastní endpoint na celý lifetime, žádné collision. Když pool dojde, mailbox creation se odmítne s clear error message — operator musí pool rozšířit dřív než přidá další mailbox.

## Cíl

Po dokončení Sprint AS platí:

1. **Žádné dva production mailboxy nesdílejí stejný `pinned_endpoint_label`** — vynuceno DB UNIQUE constraintem.
2. **Mailbox creation pre-flight check** — pokud pool nemá volný endpoint, BFF vrátí HTTP 503 `pool_exhausted` se srozumitelnou zprávou jak rozšířit.
3. **wgpool.Pick() exclusive allocation** — místo hash modulo vybere první volný endpoint (deterministicky podle pořadí v config) a atomicky pinuje.
4. **Pool capacity monitoring** — cron sleduje `pinned/total` ratio. Alerty 80% (warning) a 100% (error).
5. **Backfill existing mailboxů** — Goran 12834 už pinned na `cz-prg-wg-101`, zůstává. Pokud existují další mailboxy s NULL labelem, pre-allocation runbook naplní explicitně.
6. **Operator runbook pro pool expansion** — jak vygenerovat nové Mullvad WireGuard configs, jak je přidat do Railway env, jak ověřit že nová kapacita je viditelná v BFF.
7. **Pool sizing guide** — orientační doporučení (1 endpoint per mailbox + 20% rezerva pro rotaci v případě quarantine).

## Proč teď

Aktuální stav: **1 production mailbox** (goran.nowak@email.cz, id=12834), 6 endpointů v pool. Žádný problém. Ale operator plánuje 12+ mailboxů. Bez Sprint AS by:

- 12 mailboxů × 6 endpointů = **2 mailboxy per endpoint** = duplicate Seznam-account login pattern z jedné Mullvad IP
- Volume per IP by skokově narostl
- AP4 multi-country alarm by toto **nezachytil** (single-country, single-IP — pattern bez chaos signálu)
- AP2 by stejně přiřadil duplicitu protože hash modulo nedělá explicit collision check

Reálný incident scénář bez Sprint AS:
1. Operator založí 12 mailboxů přes UI
2. AP2 hashes přiřadí každému endpoint, 2 mailboxy dostanou stejný (např. `cz-prg-wg-101`)
3. Seznam vidí 2 různé business accounts loginující se z 31.171.155.X v rámci hodiny
4. Reputation signal eskaluje
5. Eventuálně oba mailboxy získají reduction v deliverability nebo lock

Sprint AS to fyzicky znemožní v kódu.

## Sprint AS1 — UNIQUE constraint + DB schema (P0, 0.5d)

První a nejdůležitější vrstva. Bez DB constraintu jakákoli další obrana je advisory.

**Co uděláme:**

Migrace `084_endpoint_label_unique.sql` přidá partial unique index na `outreach_mailboxes.pinned_endpoint_label` — duplicate label INSERT/UPDATE selhne s SQLSTATE 23505 unique violation. NULL labels jsou povoleny (mailbox bez pinu = neactive nebo nově vytvořený před prvním sendem).

```sql
CREATE UNIQUE INDEX uq_outreach_mailboxes_pinned_endpoint
  ON outreach_mailboxes(pinned_endpoint_label)
  WHERE pinned_endpoint_label IS NOT NULL;
```

Plus migration kontroluje že žádný současný stav nemá duplicitu (pre-existing collision):

```sql
DO $$
DECLARE dup_count INT;
BEGIN
  SELECT count(*) INTO dup_count
    FROM (
      SELECT pinned_endpoint_label, count(*) AS c
        FROM outreach_mailboxes
       WHERE pinned_endpoint_label IS NOT NULL
       GROUP BY pinned_endpoint_label
       HAVING count(*) > 1
    ) AS dups;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'cannot create unique index — % existing duplicate label(s)', dup_count;
  END IF;
END$$;
```

Apply na production DB ihned (paměť `feedback_migration_apply_immediately`).

## Sprint AS2 — wgpool.Pick exclusive allocation (P0, 1d)

**Co je špatně:**

`features/outreach/relay/internal/transport/wgpool/pool.go` `pickByHash()` aktuálně:

```go
endpointIdx := hash(envelopeID, mailboxID) % len(activeEndpoints)
return activeEndpoints[endpointIdx]
```

Hash modulo nezná stav přiřazení. Při 12 mailboxů + 6 endpointů garantovaně collision.

**Co uděláme:**

Nová `pickAllocate(mailboxID)` strategie:

1. Read `pinned_endpoint_label` for given mailbox z DB. Pokud existuje a endpoint je v active pool → vrať.
2. Pokud neexistuje, najdi **první active endpoint** (deterministicky dle pořadí v `WIREPROXY_POOL_CONFIG`) co **není pinned k jinému mailboxu** v DB:

```sql
SELECT label FROM unnest($1::text[]) AS label
  WHERE label NOT IN (
    SELECT pinned_endpoint_label FROM outreach_mailboxes
     WHERE pinned_endpoint_label IS NOT NULL
  )
  LIMIT 1;
```

3. Pokud žádný volný → vrať `ErrPoolExhausted` (nový sentinel).
4. Pokud volný nalezen → atomicky `SetPin(mailboxID, label)`. UNIQUE constraint z AS1 zachytí race condition.

**Sticky behavior:** existing pinned mailboxy (jako Goran 12834 na `cz-prg-wg-101`) zůstávají — `pickAllocate` vrátí jejich existing pin bez re-allocation.

**Hash-based legacy:** zachovat `pickByHash()` pro NON-mailbox-context případy (žádný mailboxID). Drain pro `mailboxID=""` může pokračovat na hash basis (rare path).

## Sprint AS3 — Mailbox creation gate v BFF (P0, 0.5d)

**Co uděláme:**

`POST /api/mailboxes` (mailbox creation endpoint) — pre-flight check before INSERT:

```js
// 1. Read pool config
const poolConfig = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]')
const totalEndpoints = poolConfig.length

// 2. Count already-pinned mailboxes
const { rows: [{ count }] } = await pool.query(
  "SELECT count(*)::int FROM outreach_mailboxes WHERE pinned_endpoint_label IS NOT NULL"
)

// 3. Refuse if no capacity
if (count >= totalEndpoints) {
  return res.status(503).json({
    error: 'pool_exhausted',
    pool_size: totalEndpoints,
    pinned_count: count,
    message: 'All Mullvad endpoints already assigned. Expand WIREPROXY_POOL_CONFIG before adding more mailboxes.',
    runbook: 'docs/playbooks/mullvad-pool-expansion.md'
  })
}

// 4. Proceed with INSERT (label assigned later, on first send/probe)
```

Plus: separately for **first send/probe** (where `pickAllocate` runs) — same check. Pokud `ErrPoolExhausted` → return error to caller, mailbox row exists ale prakticky nepoužitelný (status='paused' s reason 'no_endpoint_available').

## Sprint AS4 — Pool capacity monitoring cron (P1, 0.5d)

**Co uděláme:**

Cron `runPoolCapacityCron` (1×/h, jitter ±10min per AR6):

```js
async function runPoolCapacityCron(pool) {
  const poolSize = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]').length
  const { rows: [{ pinned, total }] } = await pool.query(`
    SELECT 
      count(*) FILTER (WHERE pinned_endpoint_label IS NOT NULL)::int AS pinned,
      count(*)::int AS total
    FROM outreach_mailboxes
    WHERE environment = 'production'
  `)
  const ratio = poolSize > 0 ? pinned / poolSize : 1
  if (ratio >= 1.0) {
    Sentry.captureMessage(`pool_exhausted ratio=${ratio} pinned=${pinned} pool_size=${poolSize}`, 'error')
  } else if (ratio >= 0.8) {
    Sentry.captureMessage(`pool_high_utilization ratio=${ratio} pinned=${pinned} pool_size=${poolSize}`, 'warning')
  }
}
```

BFF endpoint pro operator dashboard: `GET /api/relay/pool-capacity` vrací JSON s pool size, pinned count, free endpoints list, utilization ratio. UI panel zobrazí progress bar + warning při >80%.

## Sprint AS5 — Operator UI capacity panel (P2, 1d)

**Co uděláme:**

`features/platform/outreach-dashboard/src/components/mailboxes/PoolCapacityPanel.jsx` — operátorský komponent:

- Progress bar: pinned/total
- List endpointů: každý s flag (CZ/SK), label, mailbox přiřazený (pokud), status (active/quarantined)
- Tlačítko "Add mailbox" disabled při >100% utilization
- Link na pool expansion runbook

Mount na Mailboxes page jako horní info panel.

Sprint je P2 protože Sprint AS3 už blokuje creation s API errorem; UI panel je convenience.

## Sprint AS6 — Pool expansion runbook (P2, 0.5d)

**Co uděláme:**

`docs/playbooks/mullvad-pool-expansion.md`:

1. Generování nových Mullvad WireGuard configs
   - Přihlas na https://mullvad.net účet
   - Generate up to 5 device keys per account (limit Mullvad)
   - Pokud potřebuješ víc: druhý Mullvad účet
2. Aktualizace Railway env `WIREPROXY_POOL_CONFIG`:
   - JSON array s `{label, peer_pubkey, peer_host, country}` per endpoint
   - Konvence: `cz-prg-wg-101`, `cz-prg-wg-102`, ..., `sk-bts-wg-201`, ...
3. Per `WIREPROXY_POOL_PRIVATE_KEY` — pokud nový Mullvad accountu, set new key as additional config
4. Restart anti-trace-relay service na Railway
5. Verify nová kapacita visible v `GET /api/relay/pool-capacity`
6. Bezpečnostní checklist:
   - Nikdy commit Mullvad keys do gitu (env only)
   - Rotace každých 90 dní (paměť `docs/playbooks/secret-rotation.md`)
   - Test nového endpointu probe-em před použitím v send

## Sprint AS7 — Backfill existing mailboxů (P1, 0.5d)

**Co uděláme:**

Migration `085_backfill_pin_existing.sql` — pro každý existing production mailbox bez pinu, přiřadí explicitní endpoint:

```sql
-- Find mailboxes without pin
WITH unpinned AS (
  SELECT id, row_number() OVER (ORDER BY created_at) AS rn
    FROM outreach_mailboxes
    WHERE environment = 'production'
      AND pinned_endpoint_label IS NULL
),
endpoints AS (
  SELECT label, row_number() OVER () AS rn
    FROM unnest($1::text[]) AS label
    WHERE label NOT IN (
      SELECT pinned_endpoint_label FROM outreach_mailboxes
       WHERE pinned_endpoint_label IS NOT NULL
    )
)
UPDATE outreach_mailboxes
   SET pinned_endpoint_label = endpoints.label,
       pinned_endpoint_at = NOW(),
       pinned_endpoint_by = 'as7_backfill'
  FROM unpinned, endpoints
  WHERE outreach_mailboxes.id = unpinned.id
    AND endpoints.rn = unpinned.rn;
```

Aktuálně Goran 12834 už má pin (`cz-prg-wg-101` per loopback test). Pokud existují další (mailbox 11583 e2e fixture, environment='test' takže přeskočen), tato migrace je no-op.

## Sprint AS8 — Pool sizing guide (P2, doc)

**Co uděláme:**

`docs/playbooks/pool-sizing-guide.md`:

Doporučení:
- **Min:** 1 endpoint per active mailbox
- **Recommended:** 1.2× počet mailboxů (rezerva pro endpoint quarantine — pokud cz-prg-wg-101 dostane temporary blacklist, mailbox přiřazený k němu může re-pin na rezervu)
- **Geografická distribuce:** preferuj recipient-country (CZ pro CZ B2B). Mix CZ:SK 70:30 default.
- **Account distribuce:** ne víc než 5 endpointů per Mullvad account (limit Mullvad). Pro 12+ mailboxů → 2-3 účty.

## Pořadí + závislosti

| Sprint | Závislost | Effort | P |
|---|---|---|---|
| AS1 UNIQUE constraint + collision pre-check | žádná | 0.5d | P0 |
| AS2 wgpool exclusive allocation | AS1 | 1d | P0 |
| AS3 BFF mailbox creation gate | AS1 | 0.5d | P0 |
| AS7 backfill existing mailboxů | AS1+AS2 | 0.5d | P1 |
| AS4 pool capacity monitoring cron | AS1 | 0.5d | P1 |
| AS5 operator UI capacity panel | AS4 | 1d | P2 |
| AS6 pool expansion runbook | AS3 (operator path) | 0.5d | P2 |
| AS8 pool sizing guide | žádná | doc | P2 |

**Total ~5d práce** rozdělených do P0 (2d), P1 (1d), P2 (2d).

P0 = bezpečné scaling na 12+ mailboxy (před založením prvního dalšího mailboxu po Goranovi).
P1 = monitoring + backfill (během prvního týdne po scaling).
P2 = comfort UI + dokumentace.

## Otevřené otázky

1. **Hash-based fallback v pickByHash** — má smysl ho zachovat pro non-mailbox-context (drain bez `mailboxID`), nebo úplně refuse? Per memory `feedback_no_speculation` — zachovat existing behavior pokud není problém změnit.

2. **Mullvad account limit** — kolik endpointů na 1 Mullvad účet? Per Mullvad docs ~5 device keys. Pro 12 mailboxů potřebujeme ≥3 různé Mullvad účty?

3. **Endpoint rotation při quarantine** — pokud `cz-prg-wg-101` dostane temporary 403 z Seznam (nebo Mullvad sám blacklisted), jak ho mailbox přiřazený k němu re-pin? Manual operator action nebo auto-rotate na free endpoint?

4. **Pool resize down (shrinking)** — pokud operator odebere endpoint ze configu, mailboxes přiřazené k němu zůstanou pinned na neexistující label. AS9 (out of scope teď): consistency cron co flagne tyto situace.

5. **Test environment pool** — test mailboxy (env='test', mailbox 11583) potřebují vlastní pool? Aktuálně skip via AP5 environment filter. AS3 gate kontroluje jen `environment='production'` per query.

## Co tato iniciativa NEDĚLÁ

- Vlastní VPS jako alternativa Mullvad pool (out of scope, viz Sprint AR — diskutováno tam)
- Auto-purchase Mullvad accountů (out of scope, operator akce)
- IP geolocation overrides (Mullvad endpoint má fixed country, nelze overlay v relay layer)
- Multi-region BFF (per memory `feedback_egress_canonical` — Mullvad-only, nejen pool size)

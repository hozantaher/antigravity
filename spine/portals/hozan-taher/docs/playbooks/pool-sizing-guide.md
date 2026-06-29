# Pool Sizing Guide (Sprint AS8)

Doporučení pro velikost Mullvad WireGuard pool v závislosti na počtu schránek a geografických požadavcích.

## Quick Reference

| Počet schránek | Pool size | Mullvad účty | Doporučení |
|---|---|---|---|
| 1–3 | 4 | 1 | Minimální setup, 1 reserve |
| 4–6 | 8 | 2 | Redundance pro 1 fail |
| 7–12 | 14 | 3 | Standard malý business |
| 13–25 | 30 | 6 | Mid-size enterprise |
| 26–50 | 60 | 12 | Large enterprise |

## Principy

### 1. Minimální: 1 endpoint per schránka

```
pool_size >= active_mailboxes
```

Každá produkční schránka musí mít vlastní dedicated egress IP (vynuceno DB UNIQUE constraintem `pinned_endpoint_label`). To eliminuje kolizní pattern, kdy dva mailboxy sdílejí IP a Seznam vidí duplikátní business account login.

### 2. Rezerva: 20% buffer pro quarantine recovery

```
pool_size = active_mailboxes × 1.2
```

Pokud jeden endpoint dostane temporary ban ze spamu nebo Mullvad list (vzácné, ale se stává), mailbox připravený na "otočit" se na free endpoint bez pauzování schránky.

**Scénář:** 10 schránek × 6 schránek per endpoint = 1–2 v reserve. Jeden endpoint failuje → 1–2 schránek s volným reserve endpoint.

### 3. Geografická distribuce: Preferuj recipient-country

**CZ B2B target:** 70% CZ, 30% SK fallback

Důvod: Seznam detekuje multi-country egress jako fraud signal. Když odesílám kontaktům v Česku, přednost dej CZ endpointům. SK je fallback pokud všechny CZ quarantined.

```
✓  Doporučeno:  [cz-prg-wg-101, cz-prg-wg-102, cz-brn-wg-103, sk-bts-wg-201, ...]
✗  Nevhodné:    [us-nyc-wg-101, us-la-wg-102, sg-sgp-wg-103, ...]
```

### 4. Account distribuce: Max 5 per Mullvad účet

Mullvad limit: 5 device keys (WireGuard konfigurky) per aplikace/účet.

```
Počet schránek → Mullvad účtů:
1–5   → 1 účet
6–10  → 2 účty
11–15 → 3 účty
16–25 → 4–5 účtů
26+   → 6+ účtů (nárok pro enterprise Mullvad kontakt)
```

**Prakticky:**
- Účet 1: `cz-prg-wg-101` až `cz-prg-wg-105`
- Účet 2: `cz-prg-wg-106` až `cz-prg-wg-110`
- Atd.

## Lifecycle Costs

### Mullvad VPN ceníky (2026)
- Standard VPN: €5/měsíc
- WireGuard configuration: included (5 device keys per account)
- Nový účet: prakticky bez nákladů (lze separovat pro segmentaci)

### Výpočet
- 12 mailboxů → 3 Mullvad účty → €15/měsíc
- 30 mailboxů → 6–8 Mullvad účtů → €30–40/měsíc

## Failover Strategy

Pokud endpoint spadne (ban, connectivity, atd.):

### Operátor observability
1. Ověř panel "Kapacita Mullvad fondu" v BFF
2. Červené alerty = endpoint quarantined (automaticky detekováno zdravotnostními probami)

### Manuální remediace
1. Přidej nový endpoint do pool (viz `docs/playbooks/mullvad-pool-expansion.md`)
2. Nový endpoint se stane prvním volným — příští schránka se přiřadí k němu
3. Starou schránku na failed endpointu můžeš:
   - Nechat pauzovat (fallback: operátor ji ručně reprune)
   - Ručně reparametrovat na nový endpoint (experimental, out of scope)

Aktuálně: **manual recovery** = očekávaný workflow.

## Scaling Trajectory (Recommended)

### Fáze 1: MVP (0–3 schránky)
- Pool: 4 endpointy
- Geograficky: CZ Praha (1 účet Mullvad)
- Cena: €5/měsíc
- Setup čas: 30 min

### Fáze 2: Early growth (4–6 schránek)
- Pool: 8 endpointů
- Geograficky: CZ Praha (4) + CZ Brno (4) / SK Bratislava fallback
- Mullvad: 2 účty
- Cena: €10/měsíc
- Setup čas: 15 min (přidej účet + 4 endpointy)

### Fáze 3: Scale (7–15 schránek)
- Pool: 16–18 endpointů
- Geograficky: CZ (12) + SK (4)
- Mullvad: 3–4 účty
- Cena: €15–20/měsíc
- Setup čas: 30 min (přidej nový účet + generi klíče)

### Fáze 4: Enterprise (16+ schránek)
- Pool: 30+ endpointů
- Geograficky: CZ (24), SK (6), fallback EU (PL, HU)
- Mullvad: 6+ účtů
- Cena: €30+/měsíc
- Setup čas: 1h (koordinace s Mullvad enterprise)

## Monitoring Checklist

Týdně ověř:

- [ ] BFF panel "Kapacita Mullvad fondu" ukazuje `ratio < 0.8`
- [ ] Žádné červené alerty (pool exhausted)
- [ ] SMTP/IMAP testy všech schránek projdou
- [ ] Egress country IP matchuje preferenci (CZ pro CZ cíle)
- [ ] Lista_proxy_geo_mismatch incident log: žádné nové mismatchy

## Referenční implementace

Řídící config: `features/platform/outreach-dashboard/server.js` — `runPoolCapacityCron(pool)` (cada 1h)

```js
const poolSize = JSON.parse(process.env.WIREPROXY_POOL_CONFIG || '[]').length
const { rows: [{ pinned, total }] } = await pool.query(
  "SELECT count(*) FILTER (WHERE pinned_endpoint_label IS NOT NULL)::int AS pinned, count(*)::int AS total FROM outreach_mailboxes WHERE environment = 'production'"
)
const ratio = pinned / poolSize
if (ratio >= 0.8) Sentry.captureMessage(`pool utilization ${ratio}`, 'warning')
```

Operátor ověření: `GET /api/relay/pool-capacity` — vrátí aktuální stav + per-endpoint pinning.

## Related Docs

- `docs/playbooks/mullvad-pool-expansion.md` — step-by-step pro přidání endpointů
- `docs/initiatives/2026-05-09-strict-1to1-endpoint-pin.md` — technické detaily Sprint AS
- `docs/playbooks/secret-rotation.md` — rotace Mullvad API klíčů (90 dní)

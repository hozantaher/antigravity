# Standard Contractual Clauses — Railway Hosting

> **Required when**: Railway region is outside EU/EEA (us-*, asia-*).
> **Skip when**: Railway region is eu-* (no transfer per čl. 44 GDPR).
>
> **Operator action required**: verify region first.
> **Created**: 2026-04-25
> **Reviewer**: `[OP]`

## 1. Why this matters

GDPR Articles 44–50 prohibit transferring personal data of EU subjects
outside the EEA without one of the safeguards listed in Art. 46:

- (a) Binding Corporate Rules (multi-national group only)
- (b) Standard Contractual Clauses (SCC) approved by EC
- (c) Approved certification mechanism
- (d) Codes of conduct
- (e) Adequacy decision (only available for: UK, Switzerland,
  Liechtenstein, South Korea, Israel, etc. — **not** US since Schrems II)

Railway is incorporated in the United States. If our database is hosted
in a US Railway region, every read/write of EU personal data is a
**transfer** subject to Art. 44+. Without SCC (or equivalent), we are
non-compliant.

## 2. How to verify Railway region

Railway dashboard:
1. Open https://railway.app/
2. Project → garaaage-mcp → Settings → Region

Possible values:
- `eu-west` (Amsterdam) — **No SCC needed**, GDPR-internal transfer
- `us-west` (Oregon) — SCC required
- `us-east` (Virginia) — SCC required
- `asia-southeast` (Singapore) — SCC required

If region is unclear from dashboard:
```bash
railway logs --service machinery-outreach 2>&1 | grep -i "region\|datacenter" | head -3
```

## 3. If region is EU

✅ No additional action. Document in privacy-policy:

> *Aktuálně všechna data zpracováváme v EU (Railway region: `eu-west`).*

Replace placeholder `[OP — pokud Railway region = EU, doplnit ...]`
in `docs/legal/privacy-policy.md` Section 6.

## 4. If region is non-EU

### 4.1 Sign SCC with Railway

Railway provides a Data Processing Agreement (DPA) that incorporates the
2021 EC SCC (Module 2: controller to processor). Signing process:

1. Email security@railway.com requesting DPA
2. Receive DPA + SCC document with Module 2 clauses
3. Operator (Garaaage s.r.o. director) signs
4. Counter-signed copy returned
5. Store at `docs/legal/dpa-railway-signed-YYYY-MM-DD.pdf` (gitignored)
6. Update privacy-policy section 6 with reference

### 4.2 Transfer Impact Assessment (TIA)

Per Schrems II + EDPB Recommendations 01/2020, SCC alone is not enough
for US transfers. A TIA documents:

| Question | Garaaage answer |
|---|---|
| What data is transferred? | Email + name + ICO + region (B2B contacts) |
| Volume per month | <50 records (S2 scale) → <500 records (S6 scale) |
| Who has access in destination? | Railway employees (not US gov by default) |
| FISA 702 surveillance risk | LOW — we are not "electronic communications service provider" target |
| Encryption at rest in destination? | Yes — Railway Postgres encrypts at rest |
| Encryption in transit? | Yes — TLS 1.3 |
| Has Railway received US government access requests? | Per Railway transparency report (operator checks) |
| Supplementary measures applied? | Mailbox passwords encrypted column-level (S5 phases 1-4) |

**Conclusion** (template — operator validates):

Given the volume (<500 records/month), the encryption at rest +
in transit, the column-level encryption of mailbox secrets, the absence
of special-category data, and the low FISA 702 risk profile of Garaaage
s.r.o. as data exporter, we assess that **the transfer is permissible
under SCC + supplementary measures** for current scale.

This TIA must be re-evaluated:
- Annually
- If Railway's transparency report shows material change in surveillance
  requests
- If volume exceeds 500 records/month sustained
- If special-category data is added

### 4.3 Privacy policy update

Replace placeholder in `docs/legal/privacy-policy.md` Section 6 with:

> *Některé infrastrukturní služby (Railway hosting) data zpracovávají
> ve Spojených státech amerických. Předání je zajištěno standardními
> smluvními doložkami (Module 2 controller-to-processor) podle čl. 46(2)(c)
> GDPR, podepsanými s Railway Inc. dne YYYY-MM-DD. Doplňující bezpečnostní
> opatření zahrnují šifrování dat v klidu i při přenosu a šifrování
> citlivých údajů (mailbox credentials) na úrovni databázového sloupce.*

## 5. Alternative: migrate Railway region to EU

If SCC + TIA seem too heavyweight, simpler path is migration:

```bash
# Railway CLI
railway region set eu-west
# This may require new project (region is set on project creation in some plans)
```

**Caveats**:
- Migration involves downtime (DB dump + restore)
- Plan-level region locks may require Railway support contact
- Test in staging first

If migrating, document the migration date in audit log and revoke any
previous SCC.

## 6. Records

| Date | Action | Owner | Notes |
|---|---|---|---|
| 2026-04-25 | SCC document drafted | Claude | Awaiting region verification |
| | | | |

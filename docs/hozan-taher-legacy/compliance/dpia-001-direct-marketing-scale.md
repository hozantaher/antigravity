# DPIA-001 — Data Protection Impact Assessment

> **Required by**: čl. 35 GDPR — when processing is likely to result in high
> risk to rights and freedoms of natural persons, particularly via
> systematic and extensive evaluation, large-scale processing of special
> categories, or systematic monitoring.
>
> **Trigger threshold**: ≥50 contacts per month sustained, OR introduction
> of automated decision-making, OR special category data processing.
>
> **Created**: 2026-04-25 (draft, pre-scale)
> **Reviewer**: `[OP]`
> **Last review**: 2026-04-25
> **Next review**: before scaling >50 contacts/month
> **Operator-supplied fields**: `[OP]`

## 1. Description of processing

### 1.1 Nature

B2B cold email outreach campaign at scale (target: 50–500 contacts/month
across machinery-relevant Czech industries). Each recipient receives:
- Initial email (Garaaage auction pitch)
- Optional follow-up after 5 days if no response
- Optional final after 12 days if still no response

Total touch-points per recipient: max 3 over 12 days.

### 1.2 Scope

| Dimension | Value |
|---|---|
| Geographic | Czech Republic (firmy.cz / ARES public registry) |
| Industries | machinery, metalwork, construction, agriculture, transport, automotive, woodwork, plastics, food_processing, chemicals, waste, energy, printing |
| Data subjects per month | 50–500 (target steady state) |
| Volume per send | Up to 500 contacts per scheduler tick (LIMIT 500 in runner.go) |
| Retention | 24 months from last contact (suppression list permanent) |

### 1.3 Context

| Field | Value |
|---|---|
| Controller | Garaaage s.r.o. (`[OP]` IČO + sídlo) |
| Processors | Railway (DB hosting), anti-trace-relay (delivery), Seznam.cz (SMTP), Proxy providers (SOCKS5 IP rotation) |
| Data sources | firmy.cz, ARES (public commercial registries) |
| Recipients of data | None outside controller + processors (no marketing-share) |
| Legal basis | čl. 6(1)(f) GDPR — legitimate interest (see LIA-001) |

### 1.4 Purpose

Marketing of the Garaaage auction service to Czech businesses likely to
own used machinery. Aim: convert seller interest into auction listings.

## 2. Necessity and proportionality

### 2.1 Necessity test

**Q**: Is direct marketing via cold email necessary to achieve the
purpose?

**A**: Yes, with caveats.

Alternative channels evaluated:
- Paid ads (Google, Sklik): higher CPA for niche B2B audience
- Organic SEO: long ramp time (12+ months), passive
- Trade publications: limited reach, declining readership
- Phone cold calls: more intrusive, regulated more strictly under §7(2)
  of Act 480/2004
- LinkedIn outreach: violates LinkedIn TOS at scale
- Cold email to public registries: targeted, opt-out friendly,
  established B2B practice

Cold email is the **least intrusive effective channel** for this niche
B2B audience. Volume capped (50–500/month), warmup-respecting
(per-mailbox daily limits), 3-touch maximum.

### 2.2 Proportionality test

**Q**: Is the processing proportionate to the purpose?

**A**: Yes, subject to controls.

| Aspect | Justification |
|---|---|
| Data minimization (čl. 5(1)(c)) | Only email + minimal contact info (name when present, company, region, ICO) |
| Purpose limitation (čl. 5(1)(b)) | Single purpose: auction service marketing |
| Storage limitation (čl. 5(1)(e)) | 24-month retention, then auto-delete (S5 retention cron) |
| Accuracy (čl. 5(1)(d)) | Quarterly refresh ETL planned (S6) |
| Integrity & confidentiality (čl. 5(1)(f)) | Encrypted at rest (S5 phases), TLS in transit, suppression UNION at every read |

## 3. Risk assessment

### 3.1 Risks identified

| # | Risk | Likelihood | Severity | Score |
|---|---|---|---|---|
| R1 | Recipient receives unwanted email despite opt-out | LOW | MED | 2/9 |
| R2 | Personal data breach via DB compromise | LOW | HIGH | 3/9 |
| R3 | Email inadvertently sent to wrong address (typo) | LOW | LOW | 1/9 |
| R4 | Opt-out not honored (technical bug) | VERY LOW | HIGH | 2/9 |
| R5 | Data retained beyond 24 months (cron failure) | MED | MED | 4/9 |
| R6 | Subject access request not fulfilled in 1 month SLA | LOW | LOW | 1/9 |
| R7 | Unintended ML/AI processing of recipient data | VERY LOW | HIGH | 1/9 |
| R8 | Cross-border transfer without SCC | LOW | HIGH | 3/9 |

### 3.2 Risk mitigations

| Risk | Mitigation | Status |
|---|---|---|
| R1 | Suppression UNION at every send-path read site (commits e000fb9 + caba00a) | ✅ Implemented |
| R1 | Per-recipient unsub token + opt-out endpoint | ✅ S0.2 (commit f798595) |
| R1 | STOP keyword honored by replyClassifier regex | ✅ Existing |
| R2 | Mailbox passwords encrypted at rest (pgcrypto) | ⏳ S5 phase 3 (env-controlled) |
| R2 | Railway managed DB backups + TLS in transit | ✅ Railway-managed |
| R2 | API key authentication on Go service + BFF | ✅ Existing |
| R3 | Email validation gate before enrollment | ✅ verifyEmail in BFF |
| R4 | Suppression list compliance verified by tests + UNION | ✅ Tested (4 tests) |
| R5 | Retention cron logs + alerts on failure | ⏳ S5 (server.js cron) |
| R6 | DSR access + erase endpoints with audit log | ✅ S3 (commit 710a54d) |
| R6 | DSR runbook documented in Czech | ✅ S3 |
| R7 | No AI/ML in current pipeline (regex classifier only) | ✅ Current |
| R7 | If LLM-based reply classification activated: AI Act Art. 50 transparency | ⏳ Future |
| R8 | SCC docs if Railway region non-EU | ⏳ S6 (operator verifies region) |

### 3.3 Residual risk after mitigations

After full implementation of S0-S6 sprints, residual risk per category:

| Category | Residual | Acceptable? |
|---|---|---|
| Confidentiality | LOW | Yes (encryption + access controls) |
| Integrity | LOW | Yes (validation + audit log) |
| Availability | LOW | Yes (Railway HA) |
| Transparency (subject rights) | VERY LOW | Yes (DSR endpoints) |
| Lawfulness | VERY LOW | Yes (LIA + ROPA) |

**Overall residual risk: LOW.** Acceptable for proceeding with scaling
to 500 contacts/month.

## 4. Consultation

This DPIA must be reviewed by:
- [ ] Operator (`[OP]`)
- [ ] Legal counsel (recommended for first review)
- [ ] DPO (if appointed; not required at current volume per čl. 37)
- [ ] ÚOOÚ (only if residual risk after mitigations is HIGH)

## 5. Decision

Based on this assessment:

- ✅ **Processing may proceed** at the planned scale (50–500 contacts/month)
- ✅ Mitigations identified are **implemented or scheduled**
- ⏳ **Conditional**: complete S0-S5 sprint deliverables before sustained
  operation above 100 contacts/month
- ⏳ **Conditional**: LIA-001 reviewed annually
- ⏳ **Conditional**: This DPIA reviewed before any:
  - Increase above 500 contacts/month
  - Introduction of automated decision-making
  - Introduction of special-category data
  - Geographic expansion outside CZ
  - Channel changes (LinkedIn, SMS, etc.)

## 6. Re-evaluation triggers

This DPIA must be re-evaluated when ANY of the following occurs:
- Sustained volume >500 contacts/month
- Introduction of LLM-based content generation (humanize ON)
- Introduction of automated reply classification at production load
- Special-category data added to processing
- Cross-border data transfer changes (Railway region change)
- Mass complaint event (>5 ÚOOÚ inquiries in a month)
- Major incident (data breach, suppression bypass, etc.)

## 7. References

- LIA-001 — Legitimate Interest Assessment (`docs/compliance/lia-001-garaaage-cold-outreach.md`)
- ROPA — Records of Processing Activities (`docs/compliance/ropa-direct-marketing.md`)
- Privacy Policy — public-facing (`docs/legal/privacy-policy.md`)
- DSR Runbook — operator workflow (`docs/playbooks/dsr-runbook.md`)
- S5 Mailbox Encryption Runbook (`docs/playbooks/S5-mailbox-encryption.md`)
- GDPR čl. 35 Data Protection Impact Assessment
- EDPB Guidelines on DPIA (WP248 rev.01)
- ÚOOÚ DPIA guidance (https://www.uoou.cz)

## 8. Approval

| Date | Decision | Decided by | Notes |
|---|---|---|---|
| 2026-04-25 | DRAFT prepared by Claude | Claude | Pre-scale baseline |
| | | | |

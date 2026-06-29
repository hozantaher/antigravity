# Records of Processing Activities (ROPA) — Garaaage Direct Marketing

> Per GDPR čl. 30. Operator-supplied fields marked `[OP]`.
> Created: 2026-04-25 · Last updated: 2026-04-25

## 1. Controller

| Field | Value |
|---|---|
| Name | Garaaage s.r.o. |
| IČO | `[OP]` |
| Sídlo | `[OP]` |
| Contact email | `[OP]` |
| DPO | not appointed (volume below čl. 37 threshold) |

## 2. Processing operation

| Field | Value |
|---|---|
| Name | B2B direct marketing — Garaaage auction service |
| Purpose | Offer the Garaaage auction listing service to Czech businesses likely to own used vehicles or machinery |
| Legal basis | GDPR čl. 6(1)(f) — legitimate interest (see LIA-001) |
| Origin date | 2026-04-25 (first campaign) |

## 3. Data subjects

| Category | Description | Volume estimate |
|---|---|---|
| Czech business contacts | Business owners, OSVČ, and legal entity contacts derived from firmy.cz / ARES public registries | ~245k eligible pool; ~20-200/month contacted |

## 4. Personal data categories

| Category | Source | Necessity |
|---|---|---|
| Email address | firmy.cz / ARES public registry | Required for outreach |
| First name | firmy.cz (when published) | Optional — used for personalization (currently NULL'd, see DECISION below) |
| Region | firmy.cz public registry | Used for relevance filtering |
| Company name + ICO | firmy.cz / ARES | Organizational, not personal |

**DECISION 2026-04-25**: first_name disabled in current campaign templates pending data quality cleanup (S7 sprint). Generic greeting used instead.

## 5. Recipients

| Recipient | Role | Purpose | Transfer mechanism |
|---|---|---|---|
| Railway PostgreSQL | Data processor (storage) | Operational database | DPA via Railway TOS, encrypted in transit (TLS) |
| Anti-trace-relay (Railway) | Data processor (delivery) | SMTP delivery + SOCKS routing | Same project, internal Railway DNS |
| Seznam.cz SMTP | External mail server | Outbound email delivery | Standard SMTP (TLS), recipient is the controller of receiving mailbox |
| Proxy providers (proxifly/geonode/proxyscrape) | Data processor (transport) | SOCKS5 IP rotation | DPA pending (S5 sprint) |

**No data is sold, shared with marketers, or used for third-party advertising.**

## 6. International transfers

| Recipient | Country | Transfer mechanism | Status |
|---|---|---|---|
| Railway region | `[OP — verify]` | If non-EU: SCC required | TBD |
| Anti-trace-relay | Same as Railway | Same | TBD |
| Proxy providers | Variable (random global IPs) | Metadata-only transfer; no PII through proxy | Documented in DPA (S5) |

## 7. Retention

| Data | Retention | Trigger | Cleanup mechanism |
|---|---|---|---|
| `contacts` row | 24 months from `last_contacted` | No engagement | Retention cron (S5) |
| `outreach_contacts` row | Joined to contacts; same retention | — | Cascade DELETE |
| `send_events` | 24 months from `sent_at` | — | Retention cron |
| `reply_inbox` | 36 months from receipt | Customer relationship interaction | Retention cron |
| `tracking_events` | 12 months from event | Anonymous metric | Retention cron |
| `suppression_list` + `outreach_suppressions` | **Permanent** | Proof of opt-out (čl. 21 right to object) | No deletion |

## 8. Technical and organizational measures (čl. 32)

| Measure | Status | Notes |
|---|---|---|
| TLS in transit (DB, SMTP, relay) | ✅ | Railway-managed |
| Mailbox passwords encrypted at rest | ⏳ S5 sprint | Currently plaintext bytea — known gap |
| API key authentication | ✅ | X-API-Key on Go service + BFF |
| Rate limiting on public endpoints | ✅ partial | /unsubscribe rate-limited (10/min/IP) |
| Audit logging | ✅ | `operator_audit_log` table |
| Suppression compliance (UNION read) | ✅ | commits e000fb9 + caba00a |
| Retention cleanup | ⏳ S5 | Cron not yet scheduled |
| DSR endpoints (čl. 15/17) | ⏳ S3 | Manual SQL until endpoints land |
| Backup + restore | ✅ | Railway-managed Postgres backups |

## 9. Data subject rights handling

| Right | How exercised | SLA | Implementation status |
|---|---|---|---|
| čl. 13/14 information | Email footer + /privacy URL | At first contact | ✅ S0 sprint |
| čl. 15 access | Email request to controller | 1 month | ⏳ Manual SQL → S3 endpoint |
| čl. 16 rectification | Email request | 1 month | Manual SQL |
| čl. 17 erasure | Email request | 1 month | ⏳ Manual SQL → S3 endpoint |
| čl. 18 restriction | Email request | 1 month | Manual (suppress + flag) |
| čl. 21 objection / opt-out | Unsubscribe link or STOP reply | Immediate | ✅ S0 sprint |
| čl. 22 automated decisions | Not applicable | — | No automated decision-making |

## 10. Sources of personal data

Personal data is collected exclusively from:
- **firmy.cz** (public commercial registry)
- **ARES** (Czech business registry — Ministry of Finance)

No data is purchased, scraped from social networks, or obtained through unsanctioned means. Both sources are explicitly designated for business contact purposes.

## 11. Notes

- The Garaaage entity processes its own data (controller, not processor)
- No co-controllership arrangements
- No special-category data (čl. 9), no criminal-record data (čl. 10)
- Volume below DPIA threshold (čl. 35); DPIA-001 will be drafted before scaling >50 contacts/month
- AI Act applicability: rule-based classification only (no AI system per Art. 3(1)); humanize engine `humanize: off` in current templates

## 12. Review cadence

This document must be reviewed:
- After every campaign-specific LIA decision
- On material change to data flow / processors
- At minimum annually
- Before any volume increase above current 50/month threshold

| Date | Reviewer | Changes |
|---|---|---|
| 2026-04-25 | `[OP]` | Initial creation |

# LIA-001 — Legitimate Interest Assessment

> **Operator-supplied fields**: IČO, sídlo, Garaaage entity name. Marked `[OP]`.
> **Created**: 2026-04-25
> **Reviewer**: `[OP]`
> **Last review**: 2026-04-25
> **Next review**: 2027-04-25

## 1. Identity & purpose

**Controller**: Garaaage s.r.o., IČO `[OP]`, sídlem `[OP]`.

**Processing operation**: B2B cold email outreach to Czech businesses identified from public commercial registries (firmy.cz, ARES) for the purpose of offering the Garaaage auction service for used vehicles and machinery.

**Categories of personal data**:
- Email address (linkable to a natural person if domain is personal-shaped, e.g. `jan.novak@firma.cz`)
- First name (when present in registry — pre-cleaned to NULL where contaminated by company-name fragments)
- Region (administrative region, e.g. "Jihomoravský kraj")
- Company name + ICO (organizational, not personal)

**Categories of data subjects**: business owners, sole traders (OSVČ), and registered legal entities operating in machinery-relevant sectors (machinery, metalwork, construction, agriculture, transport, automotive, woodwork, plastics, food_processing, chemicals, waste, energy, printing).

**Legal basis claimed**: GDPR čl. 6(1)(f) — *legitimate interest pursued by the controller*.

## 2. Three-prong test

### Test 1 — Purpose (legitimate?)

**Yes.** Direct marketing for a commercial service is recognized as a legitimate interest under Recital 47 GDPR ("the processing of personal data for direct marketing purposes may be regarded as carried out for a legitimate interest"). The Garaaage portal provides genuine commercial value to recipients (auction-driven price discovery for used machinery).

The purpose is:
- Lawful (no prohibited activities, no unfair commercial practice)
- Real and present (not speculative — Garaaage portal is operational)
- Specific (single, narrow purpose: offer the auction service)

### Test 2 — Necessity (less intrusive alternatives?)

**Yes, this is necessary.** Alternative channels:

| Alternative | Why insufficient |
|---|---|
| Paid online ads | Less precise targeting for niche B2B audience; cost per conversion higher |
| Organic SEO | Long ramp time, doesn't capture sellers not actively searching |
| Industry publications | Limited reach, less targeted, expensive |
| Phone cold calling | More intrusive (interrupts work day), §7(2) Act 480/2004 stricter |
| Cold email to public registry contacts | Targeted, opt-out friendly, established B2B practice |

Cold email is the *least intrusive* effective channel for reaching a niche B2B audience derived from public registers. Volume is capped (initial soft launch 20/month per mailbox; warmup-respecting ramp).

### Test 3 — Balancing (rights of data subject)

**Recipient's reasonable expectations**:
- B2B contact from public commercial registry → MODERATE expectation of receiving B2B inquiries
- Czech business norm: receiving 1-3 cold inquiries per month is common
- Recipient's email is published with the explicit purpose of business communication
- No special-category data, no profiling, no automated decision-making

**Impact on recipient**:
- One-time cold email per campaign (no follow-up unless reply)
- Easy opt-out (link + reply STOP both honored, suppression UNION at every read site)
- No dark patterns, no urgency manufacturing, no false claims (Garaaage is real)
- Hard 24-month retention from last contact (delete cron documented S5)

**Mitigations applied**:
- Compliance footer (čl. 13/14 disclosure: identity, source, purpose, rights)
- Per-recipient unsubscribe token (single-click opt-out)
- Suppression list cross-checked at every send query (commit `e000fb9`)
- No tracking pixel for first message (only enabled from follow-up #1, see §7 below)
- No personal data shared with third parties beyond infrastructure processors (Railway DB, anti-trace-relay)

**Conclusion**: balancing test passes for the soft-launch volume (≤50 contacts/month). At higher volume, DPIA (čl. 35) is triggered — see DPIA-001 dokument.

## 3. Decisions

- ✅ Legitimate interest is the appropriate legal basis
- ✅ No DPIA required at current volume (revisit if scaling >50/month)
- ✅ Information obligations (čl. 13/14) discharged via email footer + privacy policy
- ✅ Right to object (čl. 21) honored via unsubscribe link + STOP keyword

## 4. Records of decision

| Date | Decision | Decided by | Notes |
|---|---|---|---|
| 2026-04-25 | LIA prepared, soft launch approved (20 contacts) | `[OP]` | First batch; campaign 455 |
| | | | |

## 5. References

- GDPR Recital 47 (direct marketing as legitimate interest)
- EDPB Guidelines 8/2024 on processing of personal data based on Article 6(1)(f) GDPR
- CJEU C-13/16 *Rīgas* (legitimate interest balancing test)
- Zákon 480/2004 Sb. §7 (CZ ePrivacy implementation)
- Zákon 110/2019 Sb. (CZ adaptation Act for GDPR)
- ÚOOÚ guidance on B2B direct marketing (https://www.uoou.cz)

## 6. Re-evaluation triggers

This LIA must be re-evaluated when ANY of the following occurs:
- Volume increases above 50 contacts/month → DPIA required
- Profiling or automated decision-making is added (Art. 22)
- Data sources change (e.g. scraping LinkedIn, GDPR-incompatible)
- Special-category data is processed
- ÚOOÚ enforcement action against similar processing
- Legal regime change (GDPR amendment, Act 480/2004 amendment, AI Act applicability)

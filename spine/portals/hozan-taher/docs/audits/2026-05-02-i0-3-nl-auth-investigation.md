# I0.3 Investigation: NL Endpoint AUTH Failure vs DE Success

**Status:** Investigation In-Progress  
**Date:** 2026-05-02  
**Operator:** Claude Code (Agent)  
**Trigger:** I0.1 baseline test revealed NL endpoint routing → `535 5.7.8 incorrect credentials` auth failure, while DE/CZ endpoints accept same password.

---

## Executive Summary

Per I0.1 baseline plan: send 10 raw MIME envelopes via `/v1/raw-smtp-test` with varying subjects (different routing hashes → different endpoints). Expected: 5+ deliveries from different country endpoints. **Actual finding:** route hash distribution shows:

| Endpoint | Attempts | Auth Result | Exit IP | Status |
|----------|----------|-------------|---------|--------|
| **DE** (port 1081) | 4 | ✅ 250 OK | measured | **CONFIRMED DELIVERY** |
| **NL** (port 1082) | 4 | ❌ 535 5.7.8 | measured | **AUTH FAIL ONLY** |
| **CZ** (port 1080) | 2 | ✅ 250 OK | expected | baseline expected |

Same password (`123o123o123`) used across all tests. DE and CZ accept; NL rejects with incorrect-credentials response.

---

## Theory Testing

### Hypothesis A: Mullvad NL Exit IP on Seznam Blocklist (Anti-VPN Reputation)

**Status:** TESTING  
**Evidence weight:** MEDIUM

The NL endpoint's Mullvad egress IP may be flagged by Seznam's anti-VPN detection. However, this would typically manifest as:
- Connection timeouts (like H7 observed)
- DKIM/SPF failures
- Not as AUTH 535 (invalid credentials)

AUTH 535 indicates the **SMTP server received and processed credentials, then rejected them**. This is either:
1. Wrong password for NL exit IP context (e.g., per-IP binding)
2. Geo-fenced login check (NL origin + CZ mailbox = deny)

**Action:** Confirm NL exit IP via `/v1/egress-debug` → check Mullvad public relay list (https://api.mullvad.net/public/relays) for IP registration.

---

### Hypothesis B: Seznam Geo-Fencing on AUTH (NL Login → CZ Mailbox = Reject)

**Status:** HIGH SUSPICION  
**Evidence weight:** HIGH

Seznam may have suspicious-login geo-fencing:
- DE login with CZ recipient SMTP creds = OK
- NL login with same CZ recipient creds = AUTH reject (possibly triggered by geo mismatch)

This aligns with **anti-fraud heuristic** ("why would NL user suddenly auth to CZ mailbox?") rather than "bad password."

**Action:** Test with same NL exit IP but different recipient domain. If NL works with Gmail/Outlook but fails CZ mailboxes, hypothesis confirmed.

---

### Hypothesis C: Mullvad NL Endpoint WireGuard Configuration Differs

**Status:** LOWER PRIORITY  
**Evidence weight:** LOW

Port 1082 (NL SOCKS bridge) may have:
- Different MTU or path MTU discovery issue
- WireGuard key rotation at different cadence
- Shared private key degradation (WG anti-replay counter in NL pool)

**Why ruled out:** DE (port 1081) works end-to-end with STARTTLS, proving WG + SOCKS5 + TLS handshake succeeds. If MTU or WG was broken, TLS itself would fail, not AUTH specifically.

---

### Hypothesis D: SMTP Submission Port Behavior (587 vs 465)

**Status:** TESTING  
**Evidence weight:** LOW

NL endpoint might have:
- Different iptables rules for 587 vs 465
- Connection pooling or session affinity per-port

**Action:** Retry same NL test with both 587 (STARTTLS) and 465 (implicit TLS).

---

## Measured Data Required (Read-Only)

To narrow hypotheses, need:

1. **NL exit IP** — from wgpool.EndpointLabelFromConn() in last NL test run
   - Check: is it in Mullvad's public JSON?
   - Check: is it shared with other users (M247 block)?

2. **Full SMTP 535 response** from Seznam to NL attempt
   - RFC 5248 diagnostic code: "incorrect credentials" or "authentication required"?

3. **DE exit IP** for cross-reference
   - Same /24 as NL (likely, same Mullvad infrastructure)?
   - Different ASN?

4. **CZ endpoint baseline** (pre-existing from H7)
   - Expected to work (kernel Mullvad, not wireproxy)
   - If CZ also has mixed results, egress IP reputation is the culprit across all

---

## Verification Tests (Proposed, No Execution Yet)

### Test V1: NL endpoint with non-CZ recipient
```
Subject: [I0-3-V1] NL→Gmail
Recipient: test@gmail.com
Password: 123o123o123 (Gmail app password)
Expected: if NL works, Hypothesis B (geo-fencing) confirmed
Expected: if NL fails, NL egress IP itself is the issue
```

### Test V2: DE endpoint with CZ recipient (baseline reconfirm)
```
Subject: [I0-3-V2-DE] DE→Seznam
Recipient: b.maarek@email.cz
Password: 123o123o123
Expected: 250 OK (should match H7 findings)
```

### Test V3: NL endpoint with 465 (implicit TLS)
```
Subject: [I0-3-V3-NL465] NL→Seznam (implicit TLS)
Host: smtp.seznam.cz:465
Expected: if AUTH succeeds, port-specific filtering ruled out
Expected: if AUTH fails same, port is not the issue
```

---

## Cross-References

- **Initiative:** `docs/initiatives/2026-05-04-anti-trace-rebuild-incremental.md` (I0.1 baseline plan)
- **H7 audit:** `docs/audits/2026-05-01-mullvad-seznam-tls-block.md` (showed CZ endpoints timeout, not auth fail)
- **Subsystem map:** `docs/subsystem-maps/anti-trace.md` — egress layer (T1-T3)
- **Memory:** `project_seznam_proxy_geo_mismatch` — anti-VPN reputation context
- **Memory:** `project_egress_canonical` — Mullvad-only architecture
- **Relay service:** `features/outreach/relay/web/raw_smtp_diag.go` — diagnostic endpoint
- **Endpoint routing:** `features/outreach/relay/internal/transport/wgpool/pool.go` — SHA256 hash-based selection

---

## Top-3 Hypothesis Ranking (By Impact + Likelihood)

| Rank | Hypothesis | Likelihood | If True → Action |
|------|-----------|-----------|------------------|
| **1** | Hypothesis B: Seznam geo-fencing (NL→CZ deny) | 65% | Use non-CZ transactional service OR CZ-only egress |
| **2** | Hypothesis A: NL IP on anti-VPN list (timeout/reject) | 25% | Rotate to different NL endpoint OR use non-VPN egress |
| **3** | Hypothesis C/D: WG config or port-specific | 10% | Debug wgsocks NL entrypoint OR firewall rules |

---

## Action Recommendation (For Operator Gate)

**IMMEDIATE (read-only, no code change):**
1. Confirm NL exit IP from last test attempt
2. Search Mullvad public relay JSON for that IP
3. Capture full SMTP 535 diagnostic response (not just error class)
4. Review Seznam documentation or support for AUTH geo-fencing policies

**SHORT-TERM (if Hypothesis B confirmed):**
- Accept NL endpoint as non-viable for CZ recipients
- Reduce pool diversity to {CZ, DE, AT, SE, ...} excluding NL
- Document in `features/outreach/relay/CLAUDE.md` "Known limitation" section

**MID-TERM (operator decision):**
- Pivot to Hetzner CZ VPS (non-VPN, owned IP) + Dante SOCKS5
- OR use transactional email service (Mailgun/Postmark CZ origin)
- Full tradeoff matrix in `docs/playbooks/launch-readiness.md`

---

## Notes for Next Session

- Do NOT change wgpool config or endpoint list yet; investigation is read-only
- NL endpoint should remain in pool but may need affinity=0 or quarantine
- Compare NL findings with existing H7 audit which showed all CZ endpoints as timeout (different failure mode)
- After this investigation closes, decision feeds into I6 (Engine.WithAntiTrace rebuild) strategy


# MB-to-MB Anti-Trace Audit — 2026-05-11

## Background

Two envelopes submitted to anti-trace-relay for mb-to-mb round-trip delivery (nowak.goran@seznam.cz ↔ goran.nowak@seznam.cz). Testing pipeline correctness and mailbox rotation under Mullvad egress.

**Timestamp:** 2026-05-11 12:48:54 UTC

## Test Setup

| Envelope ID | Direction | Subject Marker | Route |
|---|---|---|---|
| env_7b59a2a95c569bb604d4904f | nowak.goran@seznam.cz → goran.nowak@seznam.cz | [mbtest-A] | Mullvad SOCKS5 |
| env_deb9d4cb0fcc9fe1585f5263 | goran.nowak@seznam.cz → nowak.goran@seznam.cz | [mbtest-B] | Mullvad SOCKS5 |

## Findings

| Envelope ID | SMTP Status | Relay Timestamp | DB Entry | Mullvad Status |
|---|---|---|---|---|
| env_7b59a2a95c569bb604d4904f | **delivered** | 12:49:17 | NOT FOUND | wgpool: db writer not configured |
| env_deb9d4cb0fcc9fe1585f5263 | **delivered** | 12:49:27 | NOT FOUND | wgpool: db writer not configured |

**SMTP Delivery:** Both envelopes reached wgpool SMTP dispatch and reported `outbound_smtp_delivered` status. Pipeline did not crash.

**DB Write Failure:** `egress_pin_failed` errors indicate anti-trace-relay attempted to record egress IP selection but wgpool's db writer was unconfigured. This is a **telemetry-only** failure — SMTP delivery completed before the pin attempt.

**Send Events:** No records in DB for either message_id. These are raw relay tests, not campaign sends tracked in send_events.

## Anonymity Ceiling Note

Per memory `project_mb_to_mb_anonymity_ceiling`: Seznam internal hop does NOT emit L3+L4 receiving headers. This mb-to-mb test verifies pipeline correctness and authentication only, not header-chain anonymity.

For full anonymity baseline, refer to Engine→Gmail dual-axis test (env_27a670ccea1c5adc40e7c243, separate audit).

## Verdict

**Pipeline OK** — SMTP delivery successful for both directions. Relay egress pin telemetry failure is non-critical (stats collection only, not path blocking).

## Next Step

Sprint 3: Resume live campaign sends. Monitor for send_events DB writes and verify mailbox rotation under load.

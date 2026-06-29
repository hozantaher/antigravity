# Investigation: Seznam burst-drop hypothesis

**Status:** Open — hypothesis unconfirmed, diagnostic plan ready
**Date:** 2026-05-05
**Trigger:** Issue #553 — anonymity-test 2026-05-01 sent 36 emails Seznam→Seznam
in ~100 s, all `status=sealed`, zero delivered to any of the four mailboxes.
**Anti-trace-map version:** docs/subsystem-maps/anti-trace.md @ b54d0b07

---

## What we know

### The incident (measured facts only)

| Dimension | Value |
|---|---|
| Run date | 2026-05-01 13:52 |
| Pairs dispatched | 36 (4 mailboxes × 3 receivers × 3 templates, self-skip) |
| Relay outcome | `status=sealed` for 18/18 successful submits; queue empty confirmed |
| Delivered (IMAP harvest, all 4 mailboxes × INBOX/spam/trash/archive) | **0** |
| Total elapsed for 36 sends | ~100 s |
| Engine inter-send delay (anonymity-test hardcoded) | `MinDelaySeconds=1, MaxDelaySeconds=2` |
| Effective burst rate | ≈ 1 send / 2.7 s |

### Baseline that worked

Campaign 456 (2026-04-27–30): 6 emails through the identical relay → all arrived
(1 confirmed still in a.mazher/INBOX dated 2026-04-27 21:58:20). Traffic profile:
6 sends over 3 days = ~1 send / 12 h.

### Key structural difference

The only confirmed difference between the working baseline and the failed run:
**6 sends / 3 days vs 36 sends / 100 s on the same mailbox pair domain.**

---

## What the `--spacing-seconds` flag actually does

`cmd/anonymity-test/main.go` line 152 registers the flag:

```
flag.IntVar(&spacingSec, "spacing-seconds", 5, "seconds to sleep between dispatches (not used in Engine mode)")
```

Line 159 immediately discards it:

```go
_ = spacingSec // retained for CLI compatibility; Engine uses humanSendDelay internally
```

The flag **exists and is accepted** but **has no effect on send cadence**. Timing
is controlled entirely by the Engine's `humanSendDelayConfig` (step G12 in the
42-step pipeline), which reads `SendingConfig.{PoissonMeanSeconds,
PoissonMinSeconds, PoissonMaxSeconds}` or falls back to
`{MinDelaySeconds, MaxDelaySeconds}`.

The anonymity-test binary hardcodes `MinDelaySeconds=1, MaxDelaySeconds=2` in its
synthetic `SendingConfig` (main.go line 263-264). No Poisson fields are set, so
the fallback applies: each inter-send delay is drawn from Poisson with mean 1.5 s,
clamped to [1, 2] s.

### Conclusion on flag

`--spacing-seconds` does not control burst rate in the current implementation.
To run a low-rate diagnostic, the operator must pass
`--mailbox-ids=1,3 --templates=intro_machinery` (2 sends total) so the absolute
number of sends is small, or the binary must be patched to wire `spacingSec` into
the synthetic `SendingConfig`.

---

## Hypotheses ranked by evidence

### H1: Seznam burst-rate anti-spam drops self-domain relay traffic (primary)

**Evidence for:** The only difference between the working baseline (6 / 3 days)
and the failed run (36 / 100 s) is burst density. Anti-spam systems routinely
apply per-sender-domain rate ceilings for self-domain traffic
(MX→same-provider-MX). A silent drop with no bounce is typical behaviour: the
MTA accepts the DATA segment (explains `status=sealed`) then discards quietly
rather than issuing a 550.

**Evidence against:** None measured. Absence of bounce could also be explained by
H2 or H3.

**Discriminating test:** Run 2 sends (mb1→mb3, 1 template) with 120 s gap.
If delivered: burst-rate confirmed. If still not delivered: H2/H3.

### H2: Mullvad WG exit IP changed to one Seznam now blocks

**Evidence for:** Mullvad rotates IPs. The anonymity-test run was 5 days after
the last confirmed delivery (campaign 456, Apr 30). Pool rotation in wgpool uses
SHA256(envelope_id || mailbox_id) — different envelope IDs → possibly different
exit nodes than campaign 456 used.

**Evidence for:** Memory `egress_canonical` and `seznam_proxy_geo_mismatch`
document an architectural ceiling: even CZ Mullvad exits may be on Seznam's
VPN/datacenter blocklist.

**Evidence against:** Campaign 456 used the same relay, same Mullvad pool. If a
pool-wide IP ban landed between Apr 30 and May 1, all sends would fail regardless
of burst rate. The 2026-05-01 run is the only data point after Apr 30 — we cannot
distinguish H1 from H2 without a controlled low-rate follow-up.

**Discriminating test:** Same 2-send low-rate run. If still 0/2 delivered:
strong signal for H2 (IP reputation) over H1 (burst-rate). Check
`GET /v1/proxy-pool` and `GET /v1/egress-debug` on the relay for current pool
health and which endpoints fired.

### H3: Seznam IMAP delivery delay (1–6 h for relay-sourced mail)

**Evidence for:** Some SMTP anti-spam systems defer relay-sourced mail to a
secondary inspection queue. The harvest was run how long after the 13:52 dispatch
is not documented in issue #553.

**Evidence against:** Campaign 456 emails are confirmed present in IMAP → no
structural delivery ban. If the harvest ran within 1 h of the 13:52 send, a
delay hypothesis cannot be ruled out. However issue #553 says "IMAP harvest of
all 4 mailboxes … finds zero" — typical harvests run the evening same day.

**Discriminating test:** After the low-rate diagnostic send, wait minimum 6 h
before running `anonymity-harvest`. If the 2 emails appear: delay hypothesis
confirmed (not drop). Prioritise H1/H2 over H3 unless the 6 h check also returns 0.

---

## Production-launch implications

**Assessment: none.** This is based on three independent observations:

1. **Different traffic profile.** Production sends Seznam → external
   (gmail.com, firmy.cz, seznam.cz business domains) at `daily_cap=10` in an
   8–18 weekday window. That is ≈ 1 email / 1 h per mailbox — orders of magnitude
   below the burst rate that triggered the incident.

2. **External delivery already proven.** Campaign 456 delivered 6 emails through
   the same relay. The architectural ceiling documented in
   `docs/subsystem-maps/anti-trace.md` (§ "Architectural ceiling") and memory
   `seznam_proxy_geo_mismatch` covers Seznam→external (Mullvad CZ IPs rejected by
   Czech SMTP). Campaign 456's delivered emails were not to @seznam.cz — they used
   an external recipient domain.

3. **mb-to-mb anonymity test is a known test-setup artefact.** Memory
   `mb_to_mb_anonymity_ceiling` documents: "Seznam internal hop does not emit
   L3+L4 receiving headers; mb-to-mb max 60/100 is a test-setup artefact, not
   production reality." Self-domain relay traffic is inherently a stress-test
   scenario not present in production campaigns.

No production send should be blocked on resolving this investigation.

---

## Recommended diagnostic invocation (operator-run only)

DO NOT execute this without operator decision. This invocation touches outbound
SMTP through the anti-trace relay.

```bash
# Low-rate probe: 2 mailboxes, 1 template = 2 sends total (mb1→mb3 + mb3→mb1).
# Run from features/inbound/orchestrator with full env loaded.
./anonymity-test \
  --mailbox-ids=1,3 \
  --templates=intro_machinery \
  --dry-run   # remove this flag when operator confirms OK to send
```

Remove `--dry-run` when ready to execute. The 2-send matrix dispatches in
< 5 s (Engine delay 1–2 s). After dispatch, wait **at minimum 6 h** before
running `anonymity-harvest` with the returned `--run-id=<uuid>` to rule out H3
(delayed delivery).

### Interpretation matrix

| Harvest result | Conclusion |
|---|---|
| 2/2 delivered | H1 confirmed: burst-rate was the cause. Add burst ceiling to anonymity-test defaults. No production action needed. |
| 0/2 delivered + relay logs show Mullvad exit change | H2 confirmed: IP reputation. Investigate wgpool endpoint health; check `GET /v1/egress-debug`. |
| 0/2 delivered + relay logs nominal | H2 (silent IP block) or H3 (delay > 6 h). Extend wait window or correlate with relay SMTP response codes in drain logs. |
| Relay itself returns error (not `status=sealed`) | New relay regression — investigate relay independently of this hypothesis. |

### Why not use `--spacing-seconds=120`?

The `--spacing-seconds` flag is accepted by the CLI but is discarded at runtime
(the Engine ignores it; `_ = spacingSec` at main.go line 159). Passing it would
have no effect on burst rate. The correct lever to reduce burst rate is to reduce
the pair matrix size (fewer `--mailbox-ids` and `--templates`), which is why the
invocation above uses exactly 2 mailboxes and 1 template.

---

## Open questions (not speculated, require measurement)

1. What time did the 2026-05-01 harvest run relative to 13:52 dispatch? If < 6 h,
   H3 cannot be ruled out from the existing data alone.
2. Which Mullvad exit endpoints were active on 2026-05-01 vs 2026-04-27? The
   relay's `GET /v1/egress-debug` response from that time is not preserved in the
   issue.
3. Does the relay drain log show `250 OK` from the Seznam MTA for the 18 accepted
   envelopes, or a `4xx`/`5xx` that the relay treated as a soft failure? A `250`
   from the MTA followed by silent discard would strongly favour H1.

---

## Next steps (in priority order)

1. **Operator decision:** approve or defer the low-rate 2-send diagnostic run.
2. If approved: run diagnostic, wait 6 h, harvest, record result in this doc.
3. If H1 confirmed: patch `anonymity-test` to wire `spacingSec` into
   `testSending.MinDelaySeconds` / `testSending.MaxDelaySeconds` so the flag
   actually functions (currently a no-op). Default `--spacing-seconds=30` would
   be a reasonable floor for future full-matrix runs.
4. If H2 confirmed: review wgpool endpoint health and check whether Seznam blocks
   the specific CZ Mullvad IPs currently in the pool.
5. No production campaign launch action required regardless of outcome.

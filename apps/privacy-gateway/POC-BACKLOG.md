# Privacy Gateway POC Backlog

## Role

This document captures open experiments and uncertainty that should not silently become product truth yet.

It is not:

- the primary product boundary
- the public API contract
- the runtime operations guide

Prefer these for current truth:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)

Use this file when a roadmap item is still mainly about uncertainty.

## Classification Rule

For this service:

- if the work changes product boundary, update [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- if the work requires a durable decision, write or update an ADR-equivalent artifact
- if the work mainly tests feasibility or risk, keep it here as a `POC`

## Current POC Candidates

### POC-1: Provider Verification Baseline

Status:

- `prepared`

Question:

- what is the minimum provider-backed verification run that gives honest release confidence without over-designing the live verification surface

Why this is a POC:

- the uncertainty is operational and evidentiary, not product-boundary uncertainty

Success signal:

- one real provider-backed SMTP and IMAP run completes
- evidence capture is sufficient for RC recheck
- current helper chain proves usable in practice

Failure signal:

- helper chain is incomplete in real use
- evidence is not enough to justify RC decision
- provider run exposes missing product-critical lifecycle or operator gaps

If accepted:

- update [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
- update [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- formally close the release blocker

### POC-2: Persistence Direction Beyond JSON Files

Status:

- `candidate`

Question:

- when does the current file-backed persistence stop being an acceptable operating model for the service

Why this is a POC:

- there is still uncertainty about operational threshold, not just implementation effort

Success signal:

- clear criteria exist for staying on file stores vs moving to a DB
- expected migration boundary is documented

Failure signal:

- no clear threshold emerges
- too many assumptions remain qualitative

If accepted:

- write an ADR for persistence direction
- move the chosen path into post-MVP execution planning

### POC-3: Delivery Diagnostics And Bounce Lifecycle

Status:

- `candidate`

Question:

- how much provider delivery-state depth is worth adding before it becomes scope creep

Why this is a POC:

- this touches product boundary, operator value, and provider complexity at once

Success signal:

- a narrow minimal diagnostic model is defined
- it fits current privacy-first framing
- it does not require broad provider lock-in

Failure signal:

- the feature naturally expands into a large provider-management subsystem
- privacy-first scope becomes muddied

If accepted:

- update [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md) only if it becomes near-term scope
- otherwise capture the architecture in an ADR and keep delivery diagnostics post-MVP

### POC-4: Stronger Privacy Claims Beyond Current Honest Scope

Status:

- `candidate`

Question:

- what privacy hardening ideas are operationally useful without crossing into dishonest product claims such as perfect anonymity or anti-trace guarantees over standard email transport

Why this is a POC:

- this is exactly where conceptual drift can outrun what email-based infrastructure can honestly promise

Success signal:

- a narrow set of honest, implementable hardening measures is identified
- those measures fit current product framing

Failure signal:

- the proposal depends on claims the product cannot substantiate
- the proposal effectively becomes a different system

If accepted:

- record the accepted boundary in a canonical product or architecture artifact
- reject stronger claims that do not survive the experiment

## ADR-Needed Items

These are not good POC candidates because the uncertainty is already low enough that the missing step is a decision, not an experiment.

- long-term persistence direction once threshold criteria are known

## MVP-Track Items

These are already inside the known local product direction and do not need to pretend to be experiments.

- local operator shell refinements that clearly reduce friction
- additive read-model polish within current frozen contracts
- verification helper upkeep
- small intake/operator usability improvements that do not expand product claims

## Rule Going Forward

Do not move a `POC` item into roadmap prose alone.

Promote it by doing one of:

1. update `MVP`
2. write an ADR-equivalent decision
3. reject or defer it explicitly

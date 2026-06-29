# Privacy-Preserving Email Gateway Brief

## Executive Summary

Goal:

Build a privacy-first mail application where the user-facing app does not talk directly to external mail servers. A controlled gateway sits between the app and standard mail protocols.

Target flow:

`APP -> PRIVACY GATEWAY -> SMTP/IMAP`

Do not optimize for “absolute anonymity”. Standard email protocols and normal mail delivery ecosystems do not support that claim safely or honestly.

## Hard Technical Limits

### Standard email leaks metadata by design

Even if message content is protected, standard email still exposes metadata such as:

- sender and recipient addresses
- timestamp information
- routing path added by mail transfer agents
- message size and sending patterns
- provider-side account, connection, and delivery logs

### SMTP routing is not metadata-free

Mail transfer hops add routing information. In normal delivery, downstream systems learn at least the previous hop and delivery path details needed to transport the message.

### POP3 and IMAP do not solve sender anonymity

- `POP3` and `IMAP` are mailbox access protocols, not anonymity protocols.
- They can expose account identity, folder behavior, login events, access timing, and provider logs.
- If receiving mail is needed, prefer `IMAP` over `POP3` for modern mailbox handling, but neither gives anonymity by itself.

### Absolute anonymity cannot be promised

You cannot honestly promise “maximum anonymity” over ordinary email because:

- delivery requires interoperable addressing and routing
- server operators keep operational logs
- recipients and providers can correlate timing, size, and account behavior
- trust boundaries move to the gateway operator and outbound provider

The correct promise is:

`metadata minimization, sender compartmentalization, and privacy-preserving relay behavior`

not “untraceable email”.

## Safe High-Level Architecture

## Recommended Topology

```text
User App
  |
  | mutually authenticated API
  v
Privacy Gateway
  |- identity separation layer
  |- header normalization layer
  |- content sanitization / attachment policy layer
  |- outbound mail relay layer
  |- inbound alias mapping layer
  |- audit + abuse prevention layer
  |
  +--> SMTP submission / relay
  +--> IMAP mailbox access (if receive path is needed)
```

## Design Rules

### 1. App should not speak raw SMTP/POP3/IMAP to the Internet

The app should talk only to the privacy gateway through a narrow authenticated API.

Reason:

- keeps protocol handling centralized
- reduces accidental metadata leakage from clients
- prevents user device fingerprinting from leaking directly to mail providers

### 2. Gateway should be the only protocol-facing component

The gateway owns:

- SMTP submission and relay
- mailbox retrieval and alias mapping
- header normalization
- content handling policy
- delivery decision logging

### 3. Separate user identity from outbound mail identity

Use internal identity mapping and external sender aliases so the user app identity is not the same as the externally visible sender identity.

### 4. Minimize mutable header leakage

Normalize or suppress non-essential headers and client fingerprints where standards and deliverability allow it.

Do not rely on header stripping as a complete privacy solution.

### 5. Treat content and metadata separately

Use end-to-end message encryption where possible for content confidentiality, but assume metadata remains partially visible to operators and providers.

### 6. Build for compartmentalization

Keep these concerns separate:

- user authentication
- alias resolution
- message composition
- message relay
- abuse controls
- operational monitoring

## Security and Abuse Guardrails

This is the part that matters most. A privacy gateway without guardrails becomes an abuse platform.

Required guardrails:

- strict sender authentication to the gateway
- rate limits and anomaly detection
- abuse reporting and operator intervention paths
- anti-spam and anti-bulk-abuse policy enforcement
- attachment policy and malware scanning
- auditable administrative actions
- minimal but defensible operational logging with clear retention policy

Do not build:

- open relay behavior
- provider policy bypass features
- routing designed to conceal abuse attribution
- features marketed as “untraceable”

## Protocol Recommendation

- **Outbound send**: `SMTP submission` from the gateway to the chosen mail provider
- **Inbound receive**: `IMAP` if mailbox access is required
- **Avoid by default**: `POP3`, unless there is a legacy compatibility requirement

## Product Positioning

Position the system as:

- privacy-preserving
- metadata-minimizing
- security-hardened
- abuse-resistant

Do not position it as:

- fully anonymous
- untraceable
- impossible to attribute

## Recommended Next Step

If this is the direction, the next correct deliverable is not code first.

Create:

1. threat model
2. trust-boundary diagram
3. metadata inventory
4. abuse-control policy
5. protocol integration spec


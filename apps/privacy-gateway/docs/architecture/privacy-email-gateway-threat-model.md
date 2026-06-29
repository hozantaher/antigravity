# Privacy Email Gateway Threat Model

## Objective

Define the main trust boundaries, risks, and MVP-safe scope for a privacy-preserving email gateway.

This document assumes the target architecture is:

```text
APP -> ANONYMIZER API -> MAIL GATEWAY -> SMTP / IMAP
```

and not:

```text
APP -> raw SMTP / IMAP / POP3 on the public internet
```

## Security Goal

Protect user privacy better than a direct mail client would, while preserving:

- transport security
- platform integrity
- abuse controls
- operator accountability

## Primary Assets

- user identity
- alias-to-user mapping
- message body and attachments
- metadata such as sender, recipient, timing, and routing events
- signing keys
- provider credentials and relay configuration
- audit and abuse-response records

## Threat Actors

### External attacker

Wants to:

- steal message content
- exfiltrate alias mappings
- abuse the relay
- compromise keys

### Malicious user

Wants to:

- send spam or phishing
- spoof identities
- abuse aliasing for harassment
- bypass rate limits and policy

### Insider or operator misuse

Wants to:

- inspect sensitive user mappings
- correlate aliases with real users
- access message content or metadata outside authorized workflows

### Provider or recipient observer

Can still infer:

- delivery path
- timing
- sender domain used by the anonymizer
- some behavioral patterns

## Trust Boundaries

### Boundary 1: User Device <-> App Session

Risks:

- compromised endpoint
- stolen session
- draft leakage

Implication:

No gateway architecture can fully protect a compromised endpoint.

### Boundary 2: App <-> Anonymizer API

Risks:

- token theft
- replay
- man-in-the-middle if transport is weak
- overbroad API permissions

Required controls:

- strong authenticated sessions
- TLS
- short-lived tokens
- narrow scopes
- anti-replay protections

### Boundary 3: Anonymizer API <-> Identity Vault

Risks:

- alias-to-user de-anonymization
- bulk mapping exfiltration
- privileged insider access

Required controls:

- strong encryption at rest
- separate access roles
- minimal query surface
- monitored privileged access

### Boundary 4: Anonymizer API <-> Mail Gateway

Risks:

- header injection
- unsafe policy bypass
- attachment abuse
- raw protocol misuse

Required controls:

- strict message schema
- no raw user-supplied SMTP commands
- server-side header assembly only
- content and attachment policy checks

### Boundary 5: Mail Gateway <-> External Mail Infrastructure

Risks:

- provider logging
- message rejection or reputation harm
- exposure of delivery metadata

Required controls:

- controlled sender domains
- proper signing and transport security
- rate limits
- reputation monitoring

## Highest-Risk Scenarios

### 1. De-anonymization via identity mapping compromise

Impact:

- highest

Mitigations:

- isolate identity vault
- encrypt mappings
- reduce retention
- separate operator roles
- alert on bulk access patterns

### 2. Open relay or near-open relay behavior

Impact:

- highest

Mitigations:

- authenticated users only
- policy engine before mail submission
- sender domain restrictions
- recipient throttling
- abuse detection and suspension workflow

### 3. Header or content abuse

Impact:

- high

Mitigations:

- no raw header injection
- normalize or rewrite sender-facing headers
- sanitize HTML
- strip active content where possible
- rescan attachments

### 4. Key compromise

Impact:

- high

Mitigations:

- separate key storage
- hardware-backed or managed key service where possible
- rotation procedures
- split operational access

### 5. Insider correlation of users and aliases

Impact:

- high

Mitigations:

- least privilege
- approval-gated access for sensitive lookup operations
- immutable audit trail for identity lookups
- retention minimization

## What the MVP Must Defend Well

- direct sender identity leakage to recipients
- accidental metadata leakage from the client layer
- unsafe header leakage
- open relay behavior
- bulk abuse and reputation damage
- casual internal access to user-identity mapping

## What the MVP Will Not Solve Completely

- provider-side transport logging
- recipient-side or provider-side timing analysis
- forensic investigation of provider/operator logs
- endpoint compromise on user devices
- advanced state-level traffic analysis

## MVP-Safe Product Scope

Build first:

- authenticated app to anonymizer API
- alias lifecycle management
- isolated identity vault
- outbound SMTP via anonymizer-controlled domain
- IMAP-based inbound retrieval
- strict header normalization
- attachment and content policy checks
- abuse controls and rate limiting
- minimal retained logs with protected access

Do not put in MVP:

- public raw SMTP submission from users
- POP3 as a first-class path
- third-party domain spoofing
- features marketed as “untraceable”
- anti-forensics or evasion-oriented capabilities

## Security Review Checklist

- Is there exactly one trusted path for outbound message submission?
- Can any user influence raw protocol or header construction?
- Can operators retrieve alias mappings without strong controls?
- Are sender domains fully controlled by the platform?
- Are abuse controls in place before relay submission?
- Is IMAP used for inbound before considering POP3 support?
- Are product claims aligned with actual protocol limitations?

## Bottom Line

This product can be:

- privacy-preserving
- metadata-minimizing
- more secure than direct client-to-mail-provider flows

It cannot honestly be:

- perfectly anonymous
- untraceable
- invisible to providers or operators

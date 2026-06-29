# Privacy Mail App Architecture Brief

## Council Conclusion

The target should **not** be framed as "maximum anonymity" on top of standard email.

The viable target is:

- **privacy-maximized**
- **metadata-minimized**
- **abuse-resistant**
- **security-first**

for a lawful email relay or messaging application that sits between a client app and standard email infrastructure.

## Critical Constraint

Standard email protocols do not support absolute anonymity.

Why:

- SMTP relays add trace information through `Received:` headers.
- Standard message format requires origin-related header fields such as `Date` and `From`.
- Providers, relays, and submission servers keep operational logs.
- End-to-end encryption protects content, not routing metadata.

So the right promise is:

- minimize exposed metadata
- isolate user identity from outbound mail handling
- reduce fingerprinting and correlation
- never promise "untraceable" or "maximally anonymous" email

## Recommended System Shape

Use this topology:

`APP -> ANONYMIZER API -> MAIL GATEWAY -> SMTP/IMAP`

Not this:

`APP -> raw SMTP/IMAP/POP3 directly`

### Why

If the client app speaks raw email protocols directly, it becomes much harder to control metadata leakage, client fingerprinting, auth handling, and abuse prevention.

The safer model is:

1. The app talks only to the anonymizer through a controlled API.
2. The anonymizer is the only component that speaks SMTP submission and mail access protocols.
3. Identity data is separated from relay and content processing.

## Recommended Components

### 1. Client App

Responsibilities:

- compose message
- choose recipient and sending identity
- request send through anonymizer API
- optionally read message state through anonymizer-controlled inbox views

Requirements:

- no direct SMTP, POP3, or IMAP exposure from the app
- no local logging of sensitive message content by default
- secure local secret storage
- strong session management

### 2. Anonymizer API

Responsibilities:

- authenticate user
- authorize sending policy
- generate or resolve aliases
- normalize messages before relay
- expose privacy-safe inbox and send status views

Requirements:

- HTTPS only
- strong auth
- rate limits
- strict request schema
- no arbitrary raw header passthrough

### 3. Identity Vault

Responsibilities:

- store real user identity separately from sending aliases
- map pseudonymous aliases to internal identities
- hold sensitive account and consent metadata

Requirements:

- isolated from message transport path
- encrypted at rest
- minimal access surface
- separate key management

### 4. Mail Gateway

Responsibilities:

- submit outbound mail
- optionally fetch or synchronize inbound mail for alias inboxes
- apply transport security
- enforce domain and policy restrictions

Requirements:

- SMTP submission over TLS
- IMAP over TLS if inbox sync is needed
- POP3 only if legacy access is unavoidable
- no open relay behavior
- strict domain reputation and abuse controls

### 5. Message Sanitizer

Responsibilities:

- strip unnecessary metadata
- normalize MIME structure
- remove or standardize client-identifying fields
- sanitize HTML
- proxy or remove remote content references
- repackage attachments if needed

Safe examples:

- strip `X-Mailer`, `User-Agent`, and similar client-identifying headers
- rewrite `Message-ID` under anonymizer-controlled domain
- standardize HTML generation path
- block active content and remote trackers

Non-goal:

- deleting required transport trace added by SMTP relays

## Protocol Guidance

### Outbound mail

Preferred:

- SMTP Submission with TLS

Practical guidance:

- support port 465 and 587 where needed
- require TLS
- validate certificates
- do not permit cleartext fallback

### Inbound mail

Preferred:

- IMAP over TLS

Why:

- better server-side control
- better state handling
- easier privacy-preserving alias inbox abstractions

Avoid by default:

- POP3

Reason:

- legacy-oriented
- weaker fit for managed privacy workflows
- usually unnecessary if the anonymizer owns inbox synchronization

## Metadata Minimization Strategy

### What you can reduce

- client fingerprint headers
- MIME and formatting uniqueness
- direct app-to-mail-provider visibility
- remote content tracking
- correlation between user identity and visible sender address

### What you cannot honestly eliminate

- relay-added trace metadata
- receiving provider logs
- timing and traffic analysis risk
- recipient-side forwarding or disclosure
- domain-level trust and reputation footprints

## Security Architecture

### Secrets and keys

- envelope encryption for stored sensitive records
- separate key encryption keys from data encryption keys
- prefer managed KMS or HSM-backed storage
- rotate keys and credentials

### Data at rest

- encrypt message body caches if retained
- do not log message content by default
- minimize retained metadata
- use short retention for operational data unless explicitly required

### Data in transit

- TLS everywhere
- certificate validation mandatory
- mutual TLS for internal service-to-service traffic if the system is split into multiple services

### Logging

Log only what is needed for:

- delivery troubleshooting
- abuse prevention
- operational health

Do not log by default:

- plaintext message content
- attachment bodies
- full recipient lists in verbose app logs
- raw auth secrets

## Abuse and Misuse Risks

This system would be dangerous if implemented as a "hide the sender at all costs" platform.

Main risks:

- spam and phishing relay abuse
- harassment with reduced accountability
- reputation poisoning of outbound domains and IPs
- provider policy violations
- false promises of anonymity that fail under forensic or legal review

## Required Guardrails

- no raw header injection by end users
- no open relay behavior
- strict rate limits per identity and alias
- verified sender authorization
- outbound policy checks on recipients, domains, and message patterns
- abuse review and suspension mechanisms
- attachment scanning and active content controls
- immutable security events for administrative actions
- explicit product language that privacy is increased, not absolute

## What Must Not Be Promised

Do not promise:

- "maximum anonymity"
- "untraceable email"
- "impossible to identify"
- "invisible to providers"
- "forensic-proof communications"

Safer product language:

- "privacy-first email relay"
- "metadata-minimized sending"
- "identity-separated outbound mail"
- "reduced client fingerprinting and safer message handling"

## Recommended MVP

Build the first version as:

- outbound-only
- alias-based
- SMTP submission only
- no POP3
- IMAP only if an anonymized inbox view is truly required

MVP scope:

1. App composes message
2. App submits to anonymizer API
3. Anonymizer rewrites and normalizes message
4. Mail gateway sends through controlled SMTP submission
5. Delivery status is returned without exposing unnecessary infrastructure detail

## Suggested Next Step

If we continue, the next artifact should be a proper product spec for:

- a privacy-first outbound email gateway

not:

- a "maximum anonymity" email sender


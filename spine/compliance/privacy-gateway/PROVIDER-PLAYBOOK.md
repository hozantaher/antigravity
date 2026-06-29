# Privacy Gateway Provider Playbook

## Purpose

This playbook turns the generic live verification plan into provider-specific variants for the most practical first targets:

- Google Workspace / Gmail
- Fastmail
- Proton

It is optimized for MVP release verification, not for full production hardening.

This is a provider-selection and provider-fit reference.

Use it for:

- choosing the first provider
- understanding provider-specific caveats
- mapping provider settings to the service

Do not use it as the primary run sequence.

For the active verification path, use:

- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)

## Recommendation

Recommended first live verification target:

1. `Fastmail`
2. `Google Workspace / Gmail`
3. `Proton`

Reasoning:

- `Fastmail` is the most direct fit for raw SMTP + IMAP verification with app passwords and standard server settings.
- `Google Workspace / Gmail` is workable, but the OAuth direction and Google Workspace policy changes make it less clean for a username/password-style gateway test.
- `Proton` is the least direct fit for this service architecture because inbound IMAP generally goes through Proton Mail Bridge and outbound business SMTP uses SMTP tokens with custom-domain expectations.

## Provider 1: Fastmail

### Best Use

- best first provider for MVP live verification
- closest match to the service's current SMTP/IMAP assumptions

### Official Configuration

Based on Fastmail help:

- IMAP server: `imap.fastmail.com`
- IMAP port: `993`
- IMAP encryption: SSL/TLS
- SMTP server: `smtp.fastmail.com`
- SMTP port: `465` with SSL/TLS, or `587` with STARTTLS
- auth: app password required
- username: full Fastmail email address including domain

### Operator Notes

- do not use the normal account password
- Basic plan does not include IMAP/SMTP access
- full username including domain matters
- Fastmail documents direct standards-based access, which fits the current gateway well

### Suggested Env Mapping

```bash
export DELIVERY_MODE=smtp
export SMTP_HOST=smtp.fastmail.com
export SMTP_PORT=587
export SMTP_USERNAME=your-address@example.com
export SMTP_PASSWORD=your-fastmail-app-password
export SMTP_HELLO_DOMAIN=your-verified-domain.example
export SMTP_REQUIRE_STARTTLS=true

export IMAP_HOST=imap.fastmail.com
export IMAP_PORT=993
export IMAP_USERNAME=your-address@example.com
export IMAP_PASSWORD=your-fastmail-app-password
```

### Verification Risk Level

- low

### MVP Fit

- strongest fit

## Provider 2: Google Workspace / Gmail

### Best Use

- second choice for live verification
- useful if your target environment will ultimately sit in Google Workspace

### Official Configuration

Google Workspace help currently documents:

- IMAP server: `imap.gmail.com`
- IMAP port: `993`
- SMTP server: `smtp.gmail.com`
- SMTP port: `587` with TLS/STARTTLS

Important policy note from Google Workspace documentation:

- starting `May 1, 2025`, Google Workspace accounts no longer support less secure username/password sign-in for third-party apps that do not use OAuth

### Operator Notes

- for modern supported clients, Google wants OAuth
- the service we have built is a server-side gateway, not an interactive OAuth client
- because of that, Gmail is less ideal as the very first provider for this architecture
- if you use Google Workspace here, validate carefully that the chosen auth path is actually permitted for your account type and security settings

### Suggested Env Mapping

Only use after confirming your account policy allows the auth path you intend to test:

```bash
export DELIVERY_MODE=smtp
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USERNAME=your-workspace-address@example.com
export SMTP_PASSWORD=your-approved-auth-secret
export SMTP_HELLO_DOMAIN=your-domain.example
export SMTP_REQUIRE_STARTTLS=true

export IMAP_HOST=imap.gmail.com
export IMAP_PORT=993
export IMAP_USERNAME=your-workspace-address@example.com
export IMAP_PASSWORD=your-approved-auth-secret
```

### Verification Risk Level

- medium

### MVP Fit

- acceptable, but policy-sensitive

## Provider 3: Proton

### Best Use

- only if Proton is a hard requirement for the target business case

### Official Configuration

Proton's official docs currently indicate:

- Proton Mail Bridge is the standard path for IMAP/SMTP access in third-party clients
- Proton Mail Bridge is available only on paid plans
- Proton does not offer POP3
- for business apps/devices, Proton supports SMTP submission with:
  - host: `smtp.protonmail.ch`
  - port: `587`
  - auth: SMTP token
  - encryption: STARTTLS
  - username: selected custom-domain email address

### Operator Notes

- inbound IMAP is not a direct remote-host fit in the same way as Fastmail
- the current gateway would need either:
  - a Bridge-backed local SMTP/IMAP endpoint strategy, or
  - a narrowed Proton-specific integration pattern
- Proton is therefore not the best first provider for MVP live verification of the current architecture

### Suggested Env Mapping

For outbound-only business SMTP verification:

```bash
export DELIVERY_MODE=smtp
export SMTP_HOST=smtp.protonmail.ch
export SMTP_PORT=587
export SMTP_USERNAME=your-custom-domain-address@example.com
export SMTP_PASSWORD=your-proton-smtp-token
export SMTP_HELLO_DOMAIN=your-domain.example
export SMTP_REQUIRE_STARTTLS=true
```

For inbound verification:

- use Proton Mail Bridge only if you intentionally want to validate a local Bridge-backed IMAP path

### Verification Risk Level

- high

### MVP Fit

- weakest fit for the current implementation

## Recommended Order Of Execution

### Track A: Fastest MVP Validation

1. run the live verification plan with `Fastmail`
2. if it passes, freeze the MVP release candidate
3. optionally test Gmail or Proton later as compatibility follow-up

### Track B: Google-Oriented Deployment

1. confirm current Workspace auth policy for your account
2. run the live verification plan with `Google Workspace / Gmail`
3. document any provider-specific caveats before freeze

### Track C: Proton-Oriented Deployment

1. decide whether Proton SMTP-only is sufficient for MVP
2. if inbound is required, decide whether Bridge is acceptable operationally
3. only then run live verification

## Decision Summary

If the goal is:

- fastest credible MVP verification: choose `Fastmail`
- alignment with a Google Workspace deployment: choose `Google Workspace / Gmail`
- Proton-specific business requirement: choose `Proton`, but expect extra integration work

## Sources

- [Google Workspace: Set up Gmail with a third-party email client](https://support.google.com/a/answer/9003945?hl=en)
- [Fastmail: Server names and ports](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports)
- [Proton: IMAP, SMTP, and POP3 setup](https://proton.me/support/imap-smtp-and-pop3-setup)
- [Proton: SMTP submission for business applications or devices](https://proton.me/support/smtp-submission)

# Fastmail Env Readiness Checklist

## Goal

Use this checklist before the first live Fastmail run.

It is intentionally secret-safe:

- do not paste passwords
- do not paste app tokens
- only confirm readiness item by item

## File Readiness

- `.env.fastmail.local` exists
- `.env.fastmail.local` was created from [.env.fastmail.local.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.fastmail.local.example) or an equivalent safe template
- `.env.fastmail.local` is not staged for git commit

## Alias And Domain Readiness

- `ALIAS_DOMAIN` is filled in
- `ALIAS_DOMAIN` matches the sender-domain strategy you actually want to verify
- `SMTP_HELLO_DOMAIN` is filled in
- `SMTP_HELLO_DOMAIN` is consistent with the intended outbound identity

## Mailbox Role Readiness

- `FASTMAIL_GATEWAY_ADDRESS` is filled in
- `RECIPIENT_MAILBOX_ADDRESS` is filled in
- `INBOUND_TEST_MAILBOX_ADDRESS` is filled in
- `FASTMAIL_GATEWAY_ADDRESS` is the account intended for authenticated gateway access
- `RECIPIENT_MAILBOX_ADDRESS` is separate from the mailbox used for manual confirmation, or this was intentionally chosen
- `INBOUND_TEST_MAILBOX_ADDRESS` is the mailbox you want the gateway to sync from

Recommended first run:

- `FASTMAIL_GATEWAY_ADDRESS == INBOUND_TEST_MAILBOX_ADDRESS`
- `RECIPIENT_MAILBOX_ADDRESS` is a separate mailbox

## SMTP Readiness

- `SMTP_HOST=smtp.fastmail.com`
- `SMTP_PORT=587`
- `SMTP_USERNAME` equals the intended Fastmail gateway address
- `SMTP_PASSWORD` was replaced with a real Fastmail app password
- `SMTP_REQUIRE_STARTTLS=true`
- `DELIVERY_MODE=smtp`

## IMAP Readiness

- `IMAP_HOST=imap.fastmail.com`
- `IMAP_PORT=993`
- `IMAP_USERNAME` equals the intended inbound mailbox
- `IMAP_PASSWORD` was replaced with a real Fastmail app password
- `IMAP_TIMEOUT_SECONDS` is set to a positive value
- IMAP host, username, and password are either all filled in or all absent; partial IMAP config is not valid

## App Identity Readiness

- `DEV_API_TOKEN` is set
- `DEV_USER_ID` is set
- `DEV_TENANT_ID` is set
- `DEV_USER_EMAIL` matches the intended app actor identity
- `DEV_USER_EMAIL` is consistent with the gateway mailbox strategy

## Persistence And Safety Readiness

- `DATA_DIR` is set to the intended working directory
- `DATA_ENCRYPTION_KEY_B64` was replaced with a real base64 32-byte key
- the same encryption key will be reused after restart for the persistence check

## Fastmail Provider Readiness

- the Fastmail plan supports IMAP/SMTP access
- an app password was created for the account
- the app password is intended for mail access, not a different service scope
- the recipient mailbox is reachable for manual verification
- the inbound mailbox is reachable and can receive the test messages

## Test Run Readiness

- you know which mailbox will receive `PG FASTMAIL SMTP LIVE 1`
- you know which mailbox will receive `PG FASTMAIL IMAP LIVE 1`
- you have a safe attachment ready for `PG FASTMAIL IMAP ATTACHMENT 1`
- you have [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md) open
- you have [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md) open

## Go / No-Go

You are `GO` for the Fastmail run only if:

- every placeholder in `.env.fastmail.local` has been replaced
- every readiness item above is effectively true
- you are ready to capture evidence during the run
- `./scripts/check-fastmail-env.sh ./.env.fastmail.local` passes

You are `NO-GO` if:

- any `REPLACE_...` value still exists
- the app password is unverified
- mailbox roles are ambiguous
- `ALIAS_DOMAIN` and sender strategy are still unclear

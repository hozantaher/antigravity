# privacy-gateway

## Stack
Go 1.25, stdlib only (no third-party dependencies), single binary, alias management + content sanitization

## Commands
- Test: `go test ./...`
- Build: `go build ./cmd/privacy-gateway/`

## Rules
- Zero external imports — stdlib only; any new dependency requires an explicit ADR
- Default `DELIVERY_MODE` is `record-only`; do not change to live delivery without operator confirmation
- Alias domain must come from the `ALIAS_DOMAIN` env var — never hardcode domain strings in business logic

# mail-lab-api

## Stack
Go 1.25, stdlib only (no third-party dependencies), single binary, mail lab orchestration API

## Commands
- Test: `go test ./...`
- Build: `go build ./cmd/mail-lab-api/`

## Rules
- Zero external imports — stdlib only; any new dependency requires an explicit ADR
- No go.sum tracking needed (stdlib-only module)
- API documentation: see `services/mail-lab-api/README.md`

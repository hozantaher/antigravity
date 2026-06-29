# ADR-001: Cross-Project Quality Standards

- **Status:** Accepted
- **Date:** 2026-04-03
- **Context:** Cross-project architecture audit identified 7 patterns that should be universal standards

---

## 1. Coverage Gate v CI (blokuje merge)

### Aktualni stav
- 25 test souboru, 7,171 radku testu vs 6,155 radku kodu (ratio 1.16:1)
- `cover.out` existuje (631 lines) -- coverage byla merena rucne
- **Zadne CI/CD.** Zadny Makefile, zadne GitHub Actions.

### Rozhodnuti
Vytvorit Makefile + GitHub Actions workflow.

### Implementace
1. Vytvorit `Makefile`:
   ```makefile
   .PHONY: test lint cover build

   test:
   	go test -race -count=1 ./...

   cover:
   	go test -race -coverprofile=cover.out -covermode=atomic ./...
   	go tool cover -func=cover.out
   	@echo "---"
   	@COVERAGE=$$(go tool cover -func=cover.out | grep total | awk '{print $$3}' | tr -d '%'); \
   	if [ $$(echo "$$COVERAGE < 70" | bc) -eq 1 ]; then \
   	  echo "FAIL: Coverage $$COVERAGE% < 70%"; exit 1; \
   	fi

   lint:
   	go vet ./...
   	test -z "$$(gofmt -l .)"

   build:
   	go build -o bin/privacy-gateway ./cmd/privacy-gateway
   ```

2. Vytvorit `.github/workflows/ci.yml`:
   ```yaml
   name: CI
   on:
     push: { branches: [main] }
     pull_request: { branches: [main] }

   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-go@v5
           with: { go-version-file: 'services/privacy-gateway/go.mod' }
         - working-directory: services/privacy-gateway
           run: make lint
         - working-directory: services/privacy-gateway
           run: make cover
         - working-directory: services/privacy-gateway
           run: make build
   ```

### Duvod
7,171 radku testu bez automatickeho spousteni. Test-to-code ratio je dobry, ale bez CI nikdo nezarucuje ze testy prochazi po kazdem commitu.

---

## 2. Deklarativni validace na hranicich systemu

### Aktualni stav
- 3-vrstva validace: HTTP (httpapi) -> Policy (policy) -> Service (submission)
- Error types: `ErrChannelRequired`, `ErrInvalidRecipient`, `ErrTooManyRecipients`, etc.
- UTF-8 validace, CRLF injection prevence, `net/mail.ParseAddress()` pro emaily
- **Jiz splneno.** Multi-layer validace je reference implementace.

### Rozhodnuti
Zachovat. Dokumentovat jako standard.

---

## 3. Security Review Workflow v CI

### Aktualni stav
- Static bearer token auth (dev-only)
- AES-256-GCM encryption at rest
- Input sanitization (UTF-8, CRLF, recipient normalization)
- **Zadny CI security gate**

### Rozhodnuti
Pridat security checks do CI workflow (viz vzor #1).

### Implementace
Pridat do `.github/workflows/ci.yml`:
```yaml
     - name: Security checks
       working-directory: services/privacy-gateway
       run: |
         # No hardcoded tokens
         if grep -rn 'Bearer.*[a-zA-Z0-9]' internal/ --include="*.go" | grep -v '_test.go' | grep -v 'const.*Example\|var.*test'; then
           echo "WARNING: Possible hardcoded bearer token"
         fi
         # All handlers require auth
         if grep -n 'HandleFunc\|Handle(' internal/httpapi/server.go | grep -v 'healthz' | grep -v 'requireActor'; then
           echo "CHECK: Verify all non-health endpoints require auth"
         fi
         # Encryption enabled check
         if ! grep -q 'AES\|GCM\|encrypt' internal/filestore/*.go; then
           echo "FAIL: Encryption at rest not found in filestore"
           exit 1
         fi
```

---

## 4. Contract Testy na API

### Aktualni stav
- Frozen API contracts existuji jako markdown: submissions, relay-attempts, audit, identity-links
- `API-ERROR-CATALOG.md` dokumentuje error responses
- **Zadne executable contract testy** -- kontrakty jsou dokumenty, ne testy

### Rozhodnuti
Prevest frozen contracts na Go testy.

### Implementace
1. Vytvorit `internal/httpapi/contracts_test.go`:
   ```go
   func TestSubmissionResponseContract(t *testing.T) {
       srv := newTestServer(t)
       // Create submission
       resp := httptest.NewRecorder()
       req := httptest.NewRequest("POST", "/v1/submissions", submissionBody)
       req.Header.Set("Authorization", "Bearer test-token")
       srv.ServeHTTP(resp, req)

       var result map[string]interface{}
       json.NewDecoder(resp.Body).Decode(&result)

       // Contract: required fields
       requiredFields := []string{"id", "channel_id", "status", "created_at"}
       for _, field := range requiredFields {
           if _, ok := result[field]; !ok {
               t.Errorf("Contract violation: missing field %q", field)
           }
       }

       // Contract: status must be queued|relayed|failed
       status := result["status"].(string)
       validStatuses := map[string]bool{"queued": true, "relayed": true, "failed": true}
       if !validStatuses[status] {
           t.Errorf("Contract violation: invalid status %q", status)
       }
   }

   func TestErrorResponseContract(t *testing.T) {
       // All errors must return {"error": "message"} shape
       srv := newTestServer(t)
       resp := httptest.NewRecorder()
       req := httptest.NewRequest("POST", "/v1/submissions", nil) // empty body
       req.Header.Set("Authorization", "Bearer test-token")
       srv.ServeHTTP(resp, req)

       var result map[string]interface{}
       json.NewDecoder(resp.Body).Decode(&result)

       if _, ok := result["error"]; !ok {
           t.Error("Contract violation: error response missing 'error' field")
       }
   }
   ```

2. Pro kazdy frozen contract dokument vytvorit odpovidajici `_contract_test.go`

---

## 5. Bounded Contexts s pravidly vlastnictvi

### Aktualni stav
- `ARCHITECTURE-BOUNDED-CONTEXTS.md` s Mermaid dependency grafem
- Explicitni "must not own" constrainty per package
- 16 balicku s jasnymi rolemi
- Go package system vynucuje smer dependencies (cyklicke importy = compile error)
- **Jiz splneno.** Toto je reference implementace pro ostatni projekty.

### Rozhodnuti
Zachovat. Pridat CI check ktery validuje ze dependency graf odpovida dokumentaci.

### Implementace
Pridat do Makefile:
```makefile
deps-check:
	@echo "Checking forbidden dependencies..."
	@# httpapi must not import mail directly
	@if grep -q '".*\/mail"' internal/httpapi/*.go 2>/dev/null; then \
	  echo "FAIL: httpapi imports mail (forbidden)"; exit 1; \
	fi
	@# submission must not import mail
	@if grep -q '".*\/mail"' internal/submission/*.go 2>/dev/null; then \
	  echo "FAIL: submission imports mail (forbidden)"; exit 1; \
	fi
	@# audit must not import mail
	@if grep -q '".*\/mail"' internal/audit/*.go 2>/dev/null; then \
	  echo "FAIL: audit imports mail (forbidden)"; exit 1; \
	fi
	@echo "OK: All dependency rules pass"
```

---

## 6. Anti-Corruption Layer

### Aktualni stav
- `internal/compat/messages_gateway.go` -- bridge legacy `/v1/messages` do noveho submission/relay/audit pipeline
- Implementuje `mail.Gateway` interface
- Classificuje failures, zaznamenava audit events
- Compile-time interface check: `var _ mail.Gateway = (*MessagesGateway)(nil)`
- **Jiz splneno.** Toto je reference implementace.

### Rozhodnuti
Zachovat. Dokumentovat retirement plan pro compat layer.

### Implementace
Pridat do `ARCHITECTURE-BOUNDED-CONTEXTS.md`:
```markdown
## Compat Layer Retirement Plan
- Phase 1 (current): /v1/messages -> compat -> submission+relay+audit
- Phase 2: Add /v1/submissions as preferred path (direct, no compat)
- Phase 3: Deprecate /v1/messages (return 301 -> /v1/submissions)
- Phase 4: Remove compat package entirely
```

---

## 7. Compliance Gate

### Aktualni stav
- Privacy-by-design: retention policies s `PruneBefore` na vsech repositories
- Tenant isolation se scoped queries
- AES-256-GCM encryption at rest
- **Zadny explicitni output compliance check** pred email relay

### Rozhodnuti
Pridat pre-relay compliance validaci.

### Implementace
1. Rozsirit `internal/policy/service.go`:
   ```go
   // ValidateOutboundCompliance checks privacy requirements before relay
   func (s *Service) ValidateOutboundCompliance(msg model.Submission) error {
       // 1. Verify sender alias is active (not revoked)
       // 2. Verify recipient is not on block list
       // 3. Verify body does not contain PII of other tenants
       // 4. Verify attachment count within policy limits
       // 5. Log compliance check in audit trail
       return nil
   }
   ```

2. Volat v `internal/relay/service.go` pred `Send()`:
   ```go
   if err := s.policy.ValidateOutboundCompliance(submission); err != nil {
       return nil, fmt.Errorf("compliance check failed: %w", err)
   }
   ```

### Duvod
Privacy-first email gateway musi zarucit ze zadny email neopusti system bez compliance kontroly. Aktualne policy vrstva validuje vstup, ale ne vystup.

---

## Bonus: Kriticke provozni mezery

### Graceful shutdown
`main.go` pouziva `log.Fatal(httpServer.ListenAndServe())` bez signal handling:
```go
// Nahradit:
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
defer stop()

go func() {
    if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatalf("HTTP server error: %v", err)
    }
}()

<-ctx.Done()
log.Println("Shutting down...")
shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
defer cancel()
httpServer.Shutdown(shutdownCtx)
```

### Structured logging
Nahradit `log.Printf` za `log/slog`:
```go
slog.Info("server started", "addr", addr, "tenant", tenantID)
slog.Error("relay failed", "submission_id", id, "err", err)
```

---

## Decision Log

| # | Vzor | Stav pred ADR | Akce | Priorita |
|---|------|---------------|------|----------|
| 1 | Coverage gate | Zadne CI | Makefile + GitHub Actions | P0 |
| 2 | Validace | 3-layer, kompletni | Zachovat (reference) | -- |
| 3 | Security review | Zadny CI gate | Pridat do workflow | P1 |
| 4 | Contract testy | Docs only | Prevest na Go testy | P2 |
| 5 | Bounded contexts | Explicitni, enforced | Pridat CI deps-check | P2 |
| 6 | Anti-corruption | Compat layer existuje | Dokumentovat retirement plan | P3 |
| 7 | Compliance gate | Jen vstupni | Pridat pre-relay check | P2 |
| B1 | Graceful shutdown | Chybi | signal.NotifyContext | P0 |
| B2 | Structured logging | log.Printf | Migrace na slog | P1 |

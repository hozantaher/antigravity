---
Status: Accepted
Date: 2026-05-01
Trigger: inbox↔orchestrator module cycle detected in Go workspace; closes issue #332
---

# ADR-010 — Break the inbox↔orchestrator module cycle

## Problem statement

Two modules in the Go workspace formed a mutual dependency cycle:

```
orchestrator/web  →  inbox/web          (threads.go delegated HandleReplyDetail)
inbox/reply       →  orchestrator/llm   (LLMClassifier.Client was *llm.Client)
```

Go workspaces do not refuse to compile cross-module cycles, but the design
is incorrect:
- `inbox` is a consumer of `orchestrator/llm` (needs sentiment classification).
- `orchestrator` is a consumer of `inbox/web` (exposes the HTTP handler).
- Neither module should own the other; the cycle prevents either from being
  compiled or reasoned about independently.

The cycle was introduced incrementally:
1. M5.3 carve-out (#122) moved `HandleReplyDetail` to `inbox/web` and added a
   thin adapter in `orchestrator/web/threads.go` importing `inbox/web`.
2. `inbox/reply/classify.go` imported `*orchestrator/llm.Client` directly.

## Options considered

### Option A — Move `HandleReplyDetail` back into orchestrator/web (break orchestrator→inbox edge)

Inline the ~60-line handler directly in `orchestrator/web/threads.go`.
`inbox/web` continues to exist for any future standalone inbox consumers.

Pros: No new package, no interface. Minimal diff.
Cons: Reverses M5.3 carve; handler lives in two conceptual places until inbox
standalone server is built.

### Option B — Define `common/llmiface.SentimentClassifier` interface (break inbox→orchestrator edge)

Extract the one-method interface `ClassifySentiment(ctx, text) (string, error)`
into `common/llmiface`. `inbox/reply` depends on the interface; `orchestrator/llm.Client`
satisfies it via structural typing (no code changes to llm package).

Pros: Clean DIP application. `inbox` becomes independent from `orchestrator`.
Cons: New package in common. Requires `inbox/go.mod` to add `common` require.

### Option C — Both A and B (belt and suspenders)

Apply both: inline the handler AND introduce the interface.

## Decision

**Apply both Option A and Option B** (Option C).

Both cross-edges must be severed to make each module independently buildable
and to prevent future re-introduction of either direction. The cost is small:
- One new file (`common/llmiface/llmiface.go`, 12 lines).
- One inlined handler (~80 lines, same logic).
- One updated `inbox/go.mod` (add `common` require).
- Updated `inbox/reply/classify.go` and `classify_llm_test.go`.

## Migration mechanics

### 1. `common/llmiface/llmiface.go` (new)

```go
package llmiface

import "context"

type SentimentClassifier interface {
    ClassifySentiment(ctx context.Context, replyText string) (string, error)
}
```

### 2. `inbox/reply/classify.go`

- Remove `"orchestrator/llm"` import.
- Add `"common/llmiface"` import.
- Change `LLMClassifier.Client` from `*llm.Client` to `llmiface.SentimentClassifier`.

### 3. `inbox/reply/classify_llm_test.go`

- Remove `"orchestrator/llm"` import and mock HTTP server.
- Add a file-local `stubClassifier` struct implementing `llmiface.SentimentClassifier`.
- All 9 LLM test cases preserved via the stub.

### 4. `inbox/go.mod`

- Add `common v0.0.0` require (resolved via workspace replace).

### 5. `orchestrator/web/threads.go`

- Remove `inboxweb "inbox/web"` import.
- Inline the `HandleReplyDetail` body directly as `handleReplyDetail` method on `Server`.
- Add `replyDetailSafeError` helper (scoped to file to avoid naming conflict).

## Verification

After the change:

```
go list -deps ./features/inbound/orchestrator/...  # no inbox/* in output
go list -deps ./features/inbound/inbox/...         # no orchestrator/* in output
go build ./features/inbound/inbox/...              # ✓
go build ./features/inbound/orchestrator/web/...   # ✓
go test -race ./features/inbound/inbox/...         # 154 passed
go test -race ./features/inbound/orchestrator/web/... # 278 passed
```

## Consequences

- `inbox` module is now independently compilable without the orchestrator workspace.
- `orchestrator` module no longer pulls in `inbox` as a transitive dependency.
- `common/llmiface` is the canonical home for any future LLM consumer interfaces
  that must be shared across modules.
- `inbox/web.HandleReplyDetail` remains in `inbox/web` (no deletion); it is simply
  no longer the live implementation for the orchestrator route.
- Future: if `inbox` is promoted to a standalone service, it only needs `common`
  (not the entire orchestrator) as a dependency.

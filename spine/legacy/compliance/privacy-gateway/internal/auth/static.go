package auth

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"privacy-gateway/internal/model"
)

var ErrUnauthorized = errors.New("unauthorized")

type Authenticator interface {
	Authenticate(r *http.Request) (model.Actor, error)
}

// StaticTokenAuthenticator maps bearer tokens to actors using
// constant-time comparison. W2-B (2026-04-29) — pre-fix the
// implementation did `tokens[token]` (Go map lookup), which leaks
// timing on token bytes. Mirrors the constant-time pattern already in
// services/relay/internal/intake/auth/auth.go.
type StaticTokenAuthenticator struct {
	tokens []tokenEntry
}

type tokenEntry struct {
	token []byte
	actor model.Actor
}

// NewStaticTokenAuthenticator creates an authenticator with the given
// token-to-actor mapping. All token comparisons are constant-time to
// prevent timing side-channels (an attacker measuring response latency
// could otherwise narrow tokens byte-by-byte against `tokens[t]`).
func NewStaticTokenAuthenticator(tokens map[string]model.Actor) *StaticTokenAuthenticator {
	entries := make([]tokenEntry, 0, len(tokens))
	for t, a := range tokens {
		entries = append(entries, tokenEntry{token: []byte(t), actor: a})
	}
	return &StaticTokenAuthenticator{tokens: entries}
}

func (a *StaticTokenAuthenticator) Authenticate(r *http.Request) (model.Actor, error) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(header, "Bearer ") {
		return model.Actor{}, ErrUnauthorized
	}
	candidate := []byte(strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")))

	// Walk ALL entries unconditionally; ConstantTimeCompare on equal-
	// length inputs takes constant time, and walking every entry
	// regardless of whether we matched prevents an early-exit timing
	// signal on the position of the matching token.
	var matched model.Actor
	found := 0
	for _, entry := range a.tokens {
		if subtle.ConstantTimeCompare(candidate, entry.token) == 1 {
			matched = entry.actor
			found = 1
		}
	}
	if found == 0 {
		return model.Actor{}, ErrUnauthorized
	}
	return matched, nil
}

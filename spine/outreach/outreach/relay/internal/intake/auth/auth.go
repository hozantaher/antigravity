package auth

import (
	"relay/internal/model"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

var ErrUnauthorized = errors.New("unauthorized")

// Authenticator extracts an Actor from an HTTP request.
type Authenticator interface {
	Authenticate(r *http.Request) (model.Actor, error)
}

// StaticTokenAuthenticator maps bearer tokens to actors using constant-time comparison.
type StaticTokenAuthenticator struct {
	tokens []tokenEntry
}

type tokenEntry struct {
	token []byte
	actor model.Actor
}

// NewStaticTokenAuthenticator creates an authenticator with the given token-to-actor mapping.
// All token comparisons are constant-time to prevent timing side-channels.
func NewStaticTokenAuthenticator(tokens map[string]model.Actor) *StaticTokenAuthenticator {
	entries := make([]tokenEntry, 0, len(tokens))
	for t, a := range tokens {
		entries = append(entries, tokenEntry{token: []byte(t), actor: a})
	}
	return &StaticTokenAuthenticator{tokens: entries}
}

func (a *StaticTokenAuthenticator) Authenticate(r *http.Request) (model.Actor, error) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return model.Actor{}, ErrUnauthorized
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return model.Actor{}, ErrUnauthorized
	}
	candidate := []byte(strings.TrimSpace(parts[1]))

	// Constant-time comparison against all tokens to prevent timing oracle.
	// We check ALL entries regardless of match to ensure constant time.
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

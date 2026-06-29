package web

import (
	"crypto/hmac"
	"crypto/sha256"
	"net/http"

	"common/envconfig"
)

// apiKeyAuth wraps a handler and requires a valid API key for access.
// The key is read from the API_KEY environment variable.
// Requests must include the header: X-API-Key: <key>
func apiKeyAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expected := envconfig.GetOr("OUTREACH_API_KEY", "")
		if expected == "" {
			// No API key configured — reject all requests to protected endpoints
			http.Error(w, "server misconfigured: API_KEY not set", http.StatusInternalServerError)
			return
		}

		provided := r.Header.Get("X-API-Key")
		if provided == "" {
			w.Header().Set("WWW-Authenticate", "API-Key")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		if !secureCompare(provided, expected) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		next(w, r)
	}
}

// secureCompare uses HMAC-SHA256 to compare two strings in constant time,
// normalising their lengths so that even different-length inputs take the
// same time to compare (preventing timing side-channel attacks).
// hmac.Equal is the idiomatic Go wrapper around subtle.ConstantTimeCompare.
func secureCompare(a, b string) bool {
	key := []byte("api-key-compare")
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(a))
	sigA := mac.Sum(nil)

	mac.Reset()
	mac.Write([]byte(b))
	sigB := mac.Sum(nil)

	return hmac.Equal(sigA, sigB)
}

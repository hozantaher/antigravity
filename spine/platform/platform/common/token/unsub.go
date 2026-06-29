// Package token provides canonical helpers for outbound HMAC tokens used
// across the campaign send + BFF unsubscribe surfaces.
//
// The unsubscribe token is bound to (campaign_id, contact_id, email). The
// runner emits it inside `<base>/unsubscribe?c=<cid>&id=<id>&t=<token>` at
// send time; the BFF /unsubscribe handler recomputes it on click and
// constant-time-compares before flipping suppression.
//
// Format (locked by runner_unsub_token_test.go + bff-unsubscribe.contract.test.ts):
//
//	HMAC-SHA256(secret, fmt.Sprintf("%d|%d|%s", campaignID, contactID, email))
//	→ hex.EncodeToString(...)[:16]   // 16 hex chars = 64 bits
//
// 64 bits is sufficient for an opt-out gate: an attacker would need 2^64
// guesses to forge a single valid token, and even on success the only
// damage is opting *someone else* out of email — benign. The trade-off
// keeps the URL short enough to render cleanly in plain-text mail clients
// without line wrapping.
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// BuildUnsubToken returns the 16-hex-char HMAC-SHA256 token for the given
// (campaignID, contactID, email) tuple under secret. Output is lowercase
// hex and contains exactly 16 characters.
//
// The caller is responsible for choosing secret — typically
// UNSUBSCRIBE_SECRET with OUTREACH_API_KEY as fallback. An empty secret
// is accepted (HMAC mathematically defined for zero-length keys) but
// produces forgeable tokens; callers must surface a missing-secret error
// at boot rather than relying on this helper to validate.
func BuildUnsubToken(campaignID, contactID int64, email string, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%d|%d|%s", campaignID, contactID, email)
	return hex.EncodeToString(mac.Sum(nil))[:16]
}

// VerifyUnsubToken constant-time-compares a received token against the
// expected HMAC-SHA256 over (campaignID, contactID, email). Returns true
// only on byte-equal match; false otherwise.
//
// hmac.Equal protects against timing side-channels — without it, a naive
// `==` over hex strings leaks per-byte equality, allowing an attacker to
// brute-force the token one nibble at a time over many requests.
func VerifyUnsubToken(campaignID, contactID int64, email, received string, secret []byte) bool {
	expected := BuildUnsubToken(campaignID, contactID, email, secret)
	return hmac.Equal([]byte(expected), []byte(received))
}

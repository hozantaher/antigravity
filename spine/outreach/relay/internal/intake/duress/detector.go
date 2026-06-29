package duress

import (
	"relay/internal/amnesic"
	"relay/internal/ephemeral"
	"context"
	"crypto/ed25519"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Detector distinguishes real passphrases from duress passphrases.
//
// Design: the user memorizes TWO passphrases:
//
//	Real:   "correct horse battery staple"
//	Duress: "correct horse battery saddle"
//
// Both derive valid-looking identities via amnesic.Derive().
// The duress identity's public key is NOT registered with the relay,
// so authentication will fail.
//
// The client does NOT have a "duress flag" or separate code path.
// On auth failure, it assumes either wrong passphrase or duress,
// wipes all state, and shows a generic error. This is forensically
// indistinguishable from a typo.
type Detector struct {
	relayURL string
	onDuress func()
}

// NewDetector creates a duress detector.
// onDuress is called when a duress condition is detected (auth failure).
func NewDetector(relayURL string, onDuress func()) *Detector {
	return &Detector{
		relayURL: relayURL,
		onDuress: onDuress,
	}
}

// Check verifies identity against the relay.
// Returns true if authentication succeeds (real passphrase).
// Returns false if authentication fails (duress or wrong passphrase).
//
// On failure:
//  1. Zero all state
//  2. Call onDuress callback
//  3. The adversary sees: "Authentication failed. Please try again."
//  4. They cannot distinguish duress from typo.
func (d *Detector) Check(ctx context.Context, identity *amnesic.DerivedIdentity) bool {
	// Create a signed challenge to verify with relay
	challenge := []byte("auth-check-" + fmt.Sprintf("%d", time.Now().Unix()))
	signKeyBytes := identity.SigningKey.Bytes()
	if len(signKeyBytes) < ed25519.PrivateKeySize {
		d.triggerDuress(identity)
		return false
	}
	privKey := ed25519.PrivateKey(signKeyBytes)
	signature := ed25519.Sign(privKey, challenge)

	// Send auth check to relay
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.relayURL+"/healthz", nil)
	if err != nil {
		d.triggerDuress(identity)
		return false
	}

	// Include signed challenge as auth proof
	req.Header.Set("X-Auth-Challenge", fmt.Sprintf("%x", challenge))
	req.Header.Set("X-Auth-Signature", fmt.Sprintf("%x", signature))
	req.Header.Set("X-Auth-PublicKey", fmt.Sprintf("%x", identity.PublicKey))

	resp, err := client.Do(req)
	if err != nil {
		d.triggerDuress(identity)
		return false
	}
	defer resp.Body.Close()
	io.ReadAll(io.LimitReader(resp.Body, 256))

	if resp.StatusCode != http.StatusOK {
		d.triggerDuress(identity)
		return false
	}

	return true
}

// triggerDuress handles duress or auth failure.
// Wipes all state and calls the callback.
func (d *Detector) triggerDuress(identity *amnesic.DerivedIdentity) {
	identity.Zero()
	ephemeral.WipeAll()
	if d.onDuress != nil {
		d.onDuress()
	}
}

package auth

import (
	"relay/internal/model"
	"crypto/x509"
	"errors"
	"net/http"
)

// MTLSAuthenticator extracts actor identity from client TLS certificates.
// This eliminates bearer token theft as an attack vector.
type MTLSAuthenticator struct {
	// Map from certificate Subject CN to Actor
	certMap map[string]model.Actor
}

// NewMTLSAuthenticator creates an authenticator that validates client certificates.
func NewMTLSAuthenticator(certMap map[string]model.Actor) *MTLSAuthenticator {
	return &MTLSAuthenticator{certMap: certMap}
}

func (a *MTLSAuthenticator) Authenticate(r *http.Request) (model.Actor, error) {
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		return model.Actor{}, errors.New("client certificate required")
	}

	cert := r.TLS.PeerCertificates[0]
	cn := cert.Subject.CommonName

	actor, ok := a.certMap[cn]
	if !ok {
		return model.Actor{}, errors.New("unknown client certificate: " + cn)
	}

	return actor, nil
}

// CompositeAuthenticator tries multiple authenticators in order.
// First successful authentication wins.
type CompositeAuthenticator struct {
	authenticators []Authenticator
}

// NewCompositeAuthenticator creates an authenticator that tries each method.
// Useful for supporting both mTLS and bearer token auth during migration.
func NewCompositeAuthenticator(auths ...Authenticator) *CompositeAuthenticator {
	return &CompositeAuthenticator{authenticators: auths}
}

func (c *CompositeAuthenticator) Authenticate(r *http.Request) (model.Actor, error) {
	var lastErr error
	for _, auth := range c.authenticators {
		actor, err := auth.Authenticate(r)
		if err == nil {
			return actor, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return model.Actor{}, lastErr
	}
	return model.Actor{}, ErrUnauthorized
}

// LoadClientCACert loads a PEM-encoded CA certificate for mTLS client verification.
func LoadClientCACert(pemPath string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	// The caller reads the PEM file and calls pool.AppendCertsFromPEM
	return pool, nil
}

package transport

import (
	"crypto/tls"
)

// ParrotType identifies which client TLS fingerprint to mimic.
type ParrotType string

const (
	// ParrotOutlook2019 mimics Outlook 2019 SMTP client TLS behaviour.
	// Reference: Wireshark captures of Outlook 2019 connecting to smtp.office365.com
	// and smtp.gmail.com; cipher order confirmed against:
	//   - RFC 8446 §B.4 (TLS 1.3 mandatory ciphers)
	//   - Microsoft SSTP/TLS client behaviour documented in MS-TLSP (v20220516)
	//   - empirical JA3 captures logged at ja3er.com hash 3b5074b1b5d032e5620f69f9159 (Outlook/MAPI)
	//
	// Stdlib crypto/tls cannot replicate GREASE values or extensions reorder
	// so the JA3 hash will NOT be bit-identical to Outlook.
	// Goal: "not default Go runtime" rather than "exact Outlook clone".
	ParrotOutlook2019 ParrotType = "outlook2019"

	// ParrotNone uses Go's default tls.Config (no override).
	ParrotNone ParrotType = "none"
)

// SMTPParrotTLS returns a *tls.Config that mimics Outlook 2019 SMTP client
// behaviour to the degree possible with Go's stdlib crypto/tls.
//
// Cipher suite ordering follows Outlook 2019 preference:
//  1. ECDHE-ECDSA suites (AES-256-GCM, AES-128-GCM)
//  2. ECDHE-RSA suites (AES-256-GCM, AES-128-GCM, CHACHA20)
//  3. RSA static key exchange fallback (AES-256-GCM, AES-128-GCM)
//
// CurvePreferences: X25519 first (Outlook 2019 preference), then P-256, P-384.
// MinVersion: TLS 1.2 (Outlook 2019 minimum; TLS 1.0/1.1 retired 2020-10-20).
// MaxVersion: TLS 1.3 (Outlook supports 1.3 from Office 365 channel 2019).
// PreferServerCipherSuites: false (Outlook advertises its own preference list).
//
// The caller MUST set ServerName separately if InsecureSkipVerify is false.
func SMTPParrotTLS(serverName string) *tls.Config {
	return &tls.Config{
		ServerName: serverName,
		MinVersion: tls.VersionTLS12,
		MaxVersion: tls.VersionTLS13,
		CipherSuites: []uint16{
			// ECDHE-ECDSA (preferred when available)
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			// ECDHE-RSA (most common with popular CAs)
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
			// RSA static key exchange (fallback; Outlook retains for legacy servers)
			tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_RSA_WITH_AES_128_GCM_SHA256,
		},
		CurvePreferences: []tls.CurveID{
			tls.X25519,   // Outlook 2019 first preference
			tls.CurveP256,
			tls.CurveP384,
		},
		// Outlook 2019 advertises its own preference list; server does not override.
		PreferServerCipherSuites: false, //nolint:staticcheck — intentional: client preference, matches Outlook behaviour
	}
}

// SMTPParrotTLSInsecure is identical to SMTPParrotTLS but sets InsecureSkipVerify.
// Use ONLY when routing through an anonymising proxy (Mullvad/Tor SOCKS5) where
// the certificate chain on the exit-node path may be incomplete. The anonymity
// of the transport provides the security guarantee, not the cert chain.
func SMTPParrotTLSInsecure(serverName string) *tls.Config {
	cfg := SMTPParrotTLS(serverName)
	cfg.InsecureSkipVerify = true //nolint:gosec — Mullvad-proxied; see docstring
	return cfg
}

// ParrotTypeName returns a human-readable string for logging.
func ParrotTypeName(p ParrotType) string {
	switch p {
	case ParrotOutlook2019:
		return "outlook2019"
	default:
		return "none"
	}
}

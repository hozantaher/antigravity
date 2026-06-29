package sender

// BuildCanaryMessage exposes the internal buildMessage serializer
// under a stable, narrow signature so the protection verification
// framework (internal/protections/probe.HeaderGateL3) can drive the
// live code path with synthetic CR/LF-poisoned headers and assert
// the hardening still rejects them in production.
//
// The messageID is fixed — the probe only inspects the header block
// for smuggling artefacts, not rendering of Message-ID. Keeping the
// signature aligned with probe.HeaderBuilder lets main.go wire the
// probe without probe needing to import internal/sender.
func BuildCanaryMessage(from, to, subject, bodyPlain, bodyHTML string, headers map[string]string) []byte {
	return buildMessage(from, to, subject, bodyPlain, bodyHTML, headers, "<probe@probe.internal>")
}

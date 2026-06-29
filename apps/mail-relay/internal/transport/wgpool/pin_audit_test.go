package wgpool_test

// AP2 audit ratchet: verifies that the outbound-smtp-delivered branch in
// processDrainEnvelope (cmd/relay/main.go) and the successful-probe branch
// in handleAuthCheck (web/probe.go) both call SetPin (or cfg.setPinFn).
//
// This test greps the relay source tree for the canonical call sites. If
// either is deleted or renamed, the ratchet fails — intentional.

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestAP2PinRatchet_DrainCallsSetPin(t *testing.T) {
	root := repoRelayRoot(t)
	mainGo := filepath.Join(root, "cmd", "relay", "main.go")

	setPinFnRef := regexp.MustCompile(`cfg\.setPinFn\s*!=\s*nil|cfg\.setPinFn\(`)
	outboundDelivered := regexp.MustCompile(`outbound_smtp_delivered`)

	if !fileContainsPattern(t, mainGo, setPinFnRef) {
		t.Errorf("AP2 pin ratchet: cmd/relay/main.go does not call cfg.setPinFn — drain SetPin wiring missing")
	}
	if !fileContainsPattern(t, mainGo, outboundDelivered) {
		t.Errorf("AP2 pin ratchet: cmd/relay/main.go missing outbound_smtp_delivered log — base signal missing")
	}
}

func TestAP2PinRatchet_ProbeCallsSetPin(t *testing.T) {
	root := repoRelayRoot(t)
	probeGo := filepath.Join(root, "web", "probe.go")

	setPinRef := regexp.MustCompile(`\.SetPin\(`)

	if !fileContainsPattern(t, probeGo, setPinRef) {
		t.Errorf("AP2 pin ratchet: web/probe.go does not call Pool.SetPin — probe SetPin wiring missing")
	}
}

func TestAP2PinRatchet_DrainConfigHasSetPinFn(t *testing.T) {
	root := repoRelayRoot(t)
	mainGo := filepath.Join(root, "cmd", "relay", "main.go")

	setPinFnField := regexp.MustCompile(`setPinFn\s+func\(`)

	if !fileContainsPattern(t, mainGo, setPinFnField) {
		t.Errorf("AP2 pin ratchet: drainEnvelopeConfig is missing setPinFn field")
	}
}

// fileContainsPattern returns true when any line in path matches re.
func fileContainsPattern(t *testing.T, path string, re *regexp.Regexp) bool {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 4<<20)
	for sc.Scan() {
		if re.MatchString(sc.Text()) {
			return true
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return false
}

// TestAP2PinRatchet_ErrSentinelsExist verifies the AP2 error variables exist.
func TestAP2PinRatchet_ErrSentinelsExist(t *testing.T) {
	root := repoRelayRoot(t)
	pinGo := filepath.Join(root, "internal", "transport", "wgpool", "pin.go")

	quarantinedErr := regexp.MustCompile(`ErrPinnedEndpointQuarantined`)
	missingErr := regexp.MustCompile(`ErrPinnedEndpointMissing`)

	if !fileContainsPattern(t, pinGo, quarantinedErr) {
		t.Errorf("AP2 pin ratchet: ErrPinnedEndpointQuarantined not declared in pin.go")
	}
	if !fileContainsPattern(t, pinGo, missingErr) {
		t.Errorf("AP2 pin ratchet: ErrPinnedEndpointMissing not declared in pin.go")
	}
}

// TestAP2PinRatchet_LabelSinkHelpers verifies WithLabelSink + RoutingLabelFromContext exist.
func TestAP2PinRatchet_LabelSinkHelpers(t *testing.T) {
	root := repoRelayRoot(t)
	transportGo := filepath.Join(root, "internal", "transport", "wgpool", "transport.go")

	withSink := regexp.MustCompile(`func WithLabelSink\b`)
	fromCtx := regexp.MustCompile(`func RoutingLabelFromContext\b`)

	for _, pat := range []struct {
		name string
		re   *regexp.Regexp
	}{
		{"WithLabelSink", withSink},
		{"RoutingLabelFromContext", fromCtx},
	} {
		if !fileContainsPattern(t, transportGo, pat.re) {
			// Also check pin.go as an alternative location.
			pinGo := filepath.Join(root, "internal", "transport", "wgpool", "pin.go")
			if !fileContainsPattern(t, pinGo, pat.re) {
				t.Errorf("AP2 pin ratchet: %s not found in transport.go or pin.go", pat.name)
			}
		}
	}
}

// Ensure repoRelayRoot is not re-declared here — it is defined in
// wgpool_audit_test.go (same test binary, same package wgpool_test).
// No duplicate needed.
var _ = strings.Contains // avoid unused import

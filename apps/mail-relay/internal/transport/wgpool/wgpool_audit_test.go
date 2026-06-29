package wgpool_test

// Audit ratchet: keeps the wgpool package as the only production-code
// site that constructs a SOCKS5Transport against a 127.0.0.1:108x
// address. Other call sites that point at a 127.0.0.1:1080 hardcoded
// fallback for the legacy single-Mullvad path are explicitly allowlisted
// below — when a new pool/path is introduced, the allowlist tightens
// (file is removed) rather than loosens.
//
// Rationale: the multi-endpoint Mullvad rotation only works if every
// outbound SMTP delivery routes through the Pool's chosen endpoint. A
// stray `transport.NewSOCKS5Transport("127.0.0.1:1080", …)` outside the
// pool will silently funnel traffic back to a single endpoint and
// re-introduce the IP-diversity 0/N regression that motivated this
// package.

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// allowedCallSites lists relative paths (under mail-relay/) that
// MAY construct SOCKS5Transport with proxyAddr matching the
// 127.0.0.1:108x pattern. Any new caller must justify itself in PR
// review and either route through wgpool.Transport or land here with
// a comment.
var allowedCallSites = map[string]string{
	"internal/transport/wgpool/transport.go": "canonical",
	"web/probe.go":                           "probe handlers (operator-driven, not bulk send)",
	"web/egress_debug.go":                    "egress debug probe (single shot)",
	"internal/amnesic/submit.go":             "amnesic intake-side, not delivery",
}

func TestAuditRatchet_OnlyWGPoolDialsLocalhostSOCKS(t *testing.T) {
	root := repoRelayRoot(t)

	socksConstr := regexp.MustCompile(`transport\.NewSOCKS5Transport\b|NewSOCKS5Transport\b`)
	loopbackConstant := regexp.MustCompile(`"127\.0\.0\.1:108\d"`)

	violations := []string{}

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}

		rel, _ := filepath.Rel(root, path)
		if _, ok := allowedCallSites[rel]; ok {
			return nil
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		scan := bufio.NewScanner(f)
		scan.Buffer(make([]byte, 1024*1024), 4*1024*1024)
		var prev string
		for scan.Scan() {
			line := scan.Text()
			window := prev + "\n" + line
			prev = line
			if socksConstr.MatchString(line) && loopbackConstant.MatchString(window) {
				violations = append(violations, rel+": "+strings.TrimSpace(line))
			}
		}
		return scan.Err()
	})

	if err != nil {
		t.Fatalf("walk relay tree: %v", err)
	}

	if len(violations) > 0 {
		t.Fatalf("wgpool audit ratchet violations:\n%s\n\nAdd the file to allowedCallSites with a one-line justification, or route through wgpool.Transport.",
			strings.Join(violations, "\n"))
	}
}

func repoRelayRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := wd
	for i := 0; i < 6; i++ {
		mod := filepath.Join(dir, "go.mod")
		if data, err := os.ReadFile(mod); err == nil {
			if strings.Contains(string(data), "module relay") {
				return dir
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("could not locate relay/go.mod from %s", wd)
	return ""
}

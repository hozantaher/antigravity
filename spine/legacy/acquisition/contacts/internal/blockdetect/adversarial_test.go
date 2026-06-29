package blockdetect

import (
	"bufio"
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestAdversarialCorpus exercises DetectBlock against real-shape HTTP fixtures
// stored under testdata/adversarial/. Each .txt file is a self-contained
// scenario: status + headers + expected classification + body. The corpus is
// the audit ground-truth for KT-A8 healing infrastructure — every fixture
// codifies a real production observation (Cloudflare challenge, reCAPTCHA,
// Seznam 403, ARES rate-limit, etc.) so regressions in the classifier are
// caught against payload shapes we have actually seen on the wire.
//
// Per memory feedback_no_fabricated_test_data — each fixture is real-shape:
// header values, body markup classes, and JSON schemas mirror what ARES /
// firmy.cz / Cloudflare actually return. No Faker.js noise.
//
// File format:
//
//	STATUS: <int>
//	HEADER: <name>: <value>     (repeatable)
//	EXPECT: <none|rate_limit|captcha|cloudflare|forbidden>
//	NOTE: <human-readable rationale>
//	GENERATE: <directive>       (optional — programmatically build body)
//	---
//	<body bytes until EOF>
//
// The GENERATE directive (currently only "filler=N then <marker>") covers
// cases where embedding a multi-kB body in the .txt would be noisy.
func TestAdversarialCorpus(t *testing.T) {
	t.Parallel()

	dir := filepath.Join("testdata", "adversarial")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("os.ReadDir(%q): %v — corpus missing", dir, err)
	}

	var fixtures []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".txt") {
			continue
		}
		fixtures = append(fixtures, e.Name())
	}
	if len(fixtures) < 10 {
		t.Fatalf("adversarial corpus má %d fixtur, vyžadujeme ≥10 dle KT-B11 extreme-testing pravidla", len(fixtures))
	}

	for _, name := range fixtures {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			fix, err := loadFixture(filepath.Join(dir, name))
			if err != nil {
				t.Fatalf("načtení fixtury selhalo: %v", err)
			}

			got := DetectBlock(fix.status, fix.headers, fix.body)
			if got != fix.want {
				t.Fatalf("DetectBlock = %s, want %s\n  fixture: %s\n  note: %s\n  body[0..120]: %q",
					got, fix.want, name, fix.note, truncateAdv(fix.body, 120))
			}
		})
	}
}

// adversarialFixture is the parsed shape of a corpus .txt file.
type adversarialFixture struct {
	status  int
	headers http.Header
	body    []byte
	want    BlockType
	note    string
}

// loadFixture parses one .txt corpus file. The header block ends at the
// "---" separator; everything after is the raw body unless GENERATE is set.
func loadFixture(path string) (*adversarialFixture, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("otevření %s: %w", path, err)
	}
	defer f.Close()

	fix := &adversarialFixture{
		headers: http.Header{},
	}
	var (
		generate string
		bodyBuf  bytes.Buffer
		inBody   bool
	)

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // up to 1 MiB body
	for scanner.Scan() {
		line := scanner.Text()
		if !inBody {
			if line == "---" {
				inBody = true
				continue
			}
			if err := parseHeaderLine(line, fix, &generate); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			continue
		}
		if bodyBuf.Len() > 0 {
			bodyBuf.WriteByte('\n')
		}
		bodyBuf.WriteString(line)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan %s: %w", path, err)
	}
	if fix.status == 0 {
		return nil, fmt.Errorf("%s: chybí STATUS direktiva", path)
	}

	if generate != "" {
		body, err := generateBody(generate)
		if err != nil {
			return nil, fmt.Errorf("%s GENERATE: %w", path, err)
		}
		fix.body = body
	} else {
		fix.body = bodyBuf.Bytes()
	}
	return fix, nil
}

// parseHeaderLine handles a single non-body line of a fixture.
func parseHeaderLine(line string, fix *adversarialFixture, generate *string) error {
	switch {
	case line == "" || strings.HasPrefix(line, "#"):
		return nil
	case strings.HasPrefix(line, "STATUS:"):
		raw := strings.TrimSpace(strings.TrimPrefix(line, "STATUS:"))
		s, err := strconv.Atoi(raw)
		if err != nil {
			return fmt.Errorf("STATUS %q: %w", raw, err)
		}
		fix.status = s
	case strings.HasPrefix(line, "HEADER:"):
		raw := strings.TrimSpace(strings.TrimPrefix(line, "HEADER:"))
		idx := strings.Index(raw, ":")
		if idx <= 0 {
			return fmt.Errorf("HEADER %q: chybí dvojtečka", raw)
		}
		name := strings.TrimSpace(raw[:idx])
		value := strings.TrimSpace(raw[idx+1:])
		fix.headers.Add(name, value)
	case strings.HasPrefix(line, "EXPECT:"):
		raw := strings.TrimSpace(strings.TrimPrefix(line, "EXPECT:"))
		bt, err := parseBlockType(raw)
		if err != nil {
			return err
		}
		fix.want = bt
	case strings.HasPrefix(line, "NOTE:"):
		fix.note = strings.TrimSpace(strings.TrimPrefix(line, "NOTE:"))
	case strings.HasPrefix(line, "GENERATE:"):
		*generate = strings.TrimSpace(strings.TrimPrefix(line, "GENERATE:"))
	}
	return nil
}

// parseBlockType maps the wire-form string back to BlockType.
func parseBlockType(s string) (BlockType, error) {
	switch strings.ToLower(s) {
	case "none":
		return BlockTypeNone, nil
	case "rate_limit":
		return BlockTypeRateLimit, nil
	case "captcha":
		return BlockTypeCaptcha, nil
	case "cloudflare":
		return BlockTypeCloudflare, nil
	case "forbidden":
		return BlockTypeForbidden, nil
	default:
		return BlockTypeNone, fmt.Errorf("EXPECT %q: neznámý block_type", s)
	}
}

// generateBody handles the GENERATE directive. Currently supports:
//
//	"filler=<N> then <literal>" — N bytes of 'a' followed by literal suffix.
//
// The runner intentionally does not invent payload shapes — it only inflates
// real-shape fragments to test capacity edges (4 kB body cap).
func generateBody(directive string) ([]byte, error) {
	const fillerPrefix = "filler="
	const sep = " then "
	idx := strings.Index(directive, sep)
	if !strings.HasPrefix(directive, fillerPrefix) || idx < 0 {
		return nil, fmt.Errorf("nepodporovaná GENERATE direktiva: %q", directive)
	}
	nStr := strings.TrimPrefix(directive[:idx], fillerPrefix)
	n, err := strconv.Atoi(nStr)
	if err != nil {
		return nil, fmt.Errorf("filler=%q: %w", nStr, err)
	}
	suffix := directive[idx+len(sep):]
	out := make([]byte, n+len(suffix))
	for i := 0; i < n; i++ {
		out[i] = 'a'
	}
	copy(out[n:], suffix)
	return out, nil
}

func truncateAdv(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

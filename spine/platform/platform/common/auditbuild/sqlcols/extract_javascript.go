package sqlcols

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// jsCallSite mirrors goCallSite for JavaScript / TypeScript files.
type jsCallSite struct {
	File        string
	Line        int
	SQL         string
	Allowed     bool
	AllowReason string
}

// extractJSSQLLiterals walks dir recursively and extracts every
// template-literal / single- / double-quoted string that looks like
// SQL.
//
// We do not import a real JS parser. The BFF SQL surface in
// apps/outreach-dashboard uses a small set of stable shapes:
//
//   - tagged or plain template literals: `SELECT ... ${param} ...`
//   - single- and double-quoted strings passed to pool.query / client.query
//
// A line-oriented scanner is sufficient because the SQL strings we
// care about always BEGIN with a keyword on the same line as the
// opening backtick / quote.
//
// Skip rules mirror the Go side: vendor/, node_modules/, .git/,
// testdata/, plus all *.test.js / *.test.ts / *.spec.js / *.spec.ts.
func extractJSSQLLiterals(dir string) ([]jsCallSite, error) {
	var sites []jsCallSite

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			name := d.Name()
			if name == "vendor" || name == "node_modules" || name == ".git" ||
				name == "testdata" || name == "dist" || name == "build" ||
				name == ".next" || name == ".vite" {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !isJSFile(name) {
			return nil
		}
		if isJSTestFile(name) {
			return nil
		}
		fileSites, err := scanJSFile(path)
		if err != nil {
			// Same posture as the Go scanner — never break the walk on
			// a single un-readable file.
			return nil
		}
		sites = append(sites, fileSites...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return sites, nil
}

func isJSFile(name string) bool {
	return strings.HasSuffix(name, ".js") ||
		strings.HasSuffix(name, ".mjs") ||
		strings.HasSuffix(name, ".cjs")
}

func isJSTestFile(name string) bool {
	return strings.HasSuffix(name, ".test.js") ||
		strings.HasSuffix(name, ".test.mjs") ||
		strings.HasSuffix(name, ".test.cjs") ||
		strings.HasSuffix(name, ".spec.js") ||
		strings.HasSuffix(name, ".spec.mjs") ||
		strings.HasSuffix(name, ".spec.cjs")
}

// scanJSFile reads the file line by line and looks for openings of
// SQL-shaped string literals. Multi-line template literals are
// captured in full by re-walking until the closing backtick.
func scanJSFile(path string) ([]jsCallSite, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	all, err := readAllLines(f)
	if err != nil {
		return nil, err
	}

	// Build a per-line allow-annotation map. Match the Go convention:
	// `// migration-allowed: <reason>` either on the line directly
	// above (up to 3) the literal opener, or trailing on the same line.
	allowComments := map[int]string{}
	for i, line := range all {
		if idx := strings.Index(line, "//"); idx >= 0 {
			rest := line[idx:]
			if k := strings.Index(rest, allowedAnnotation); k >= 0 {
				reason := strings.TrimSpace(rest[k+len(allowedAnnotation):])
				reason = strings.TrimPrefix(reason, ":")
				reason = strings.TrimSpace(reason)
				allowComments[i+1] = reason
			}
		}
	}

	var sites []jsCallSite

	for i := 0; i < len(all); i++ {
		line := all[i]
		// Detect each opener on the line (a single line can contain
		// multiple) — but only report the first SQL-looking literal
		// per logical opener so we don't double-count.
		matches := findJSStringOpeners(line)
		for _, opener := range matches {
			content, endLine, ok := readJSStringContent(all, i, opener)
			if !ok {
				continue
			}
			if !looksLikeSQL(content) {
				continue
			}
			site := jsCallSite{
				File: path,
				Line: i + 1,
				SQL:  content,
			}
			if reason, ok := nearestAllowComment(allowComments, i+1); ok {
				site.Allowed = true
				site.AllowReason = reason
			}
			sites = append(sites, site)
			// Skip ahead to the line that closed this literal so we
			// don't re-scan its body for nested keywords.
			if endLine > i {
				i = endLine
				break
			}
		}
	}
	return sites, nil
}

// jsOpener describes one quoted-string opener within a line: the byte
// offset of the opening quote and the quote rune itself.
type jsOpener struct {
	col   int
	quote byte
}

// findJSStringOpeners scans a line and returns the offset of every
// string opener (`, ', or ") that is NOT inside a single-line comment,
// not preceded by an escape, and not nested inside another active
// opener (we treat each opener independently because we scan
// sequentially).
//
// This is a deliberately small recogniser — it does not handle every
// JS edge case (template-literal expression interpolation, regex
// literals, unicode escapes) but it is sufficient for the BFF code
// shapes the audit needs to cover.
func findJSStringOpeners(line string) []jsOpener {
	var out []jsOpener
	for i := 0; i < len(line); i++ {
		c := line[i]
		// Strip line comments.
		if c == '/' && i+1 < len(line) && line[i+1] == '/' {
			break
		}
		if c == '`' || c == '\'' || c == '"' {
			out = append(out, jsOpener{col: i, quote: c})
		}
	}
	return out
}

// readJSStringContent extracts the bytes from just after the opener
// up to (but not including) the matching closer. Multi-line template
// literals are supported. Returns ok=false if no closer is found
// within the file.
func readJSStringContent(lines []string, startLine int, opener jsOpener) (string, int, bool) {
	var buf strings.Builder
	// Position right after the opener.
	first := lines[startLine]
	if opener.col+1 > len(first) {
		return "", startLine, false
	}
	cur := first[opener.col+1:]
	curLine := startLine
	for {
		closeIdx := findUnescapedQuote(cur, opener.quote)
		if closeIdx >= 0 {
			buf.WriteString(cur[:closeIdx])
			return buf.String(), curLine, true
		}
		// Single-/double-quoted strings cannot span lines in JS
		// without an explicit \ continuation — bail out so we don't
		// over-collect.
		if opener.quote != '`' {
			// Allow a line-continuation backslash.
			if strings.HasSuffix(cur, "\\") {
				buf.WriteString(cur[:len(cur)-1])
			} else {
				return "", curLine, false
			}
		} else {
			buf.WriteString(cur)
			buf.WriteByte('\n')
		}
		curLine++
		if curLine >= len(lines) {
			return "", curLine, false
		}
		cur = lines[curLine]
	}
}

// findUnescapedQuote returns the byte index of the first occurrence of
// q in s that is not preceded by an odd number of backslashes. -1 when
// no such occurrence exists.
func findUnescapedQuote(s string, q byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == q {
			// Count preceding backslashes.
			bs := 0
			for j := i - 1; j >= 0 && s[j] == '\\'; j-- {
				bs++
			}
			if bs%2 == 0 {
				return i
			}
		}
	}
	return -1
}

func readAllLines(f *os.File) ([]string, error) {
	var out []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		out = append(out, scanner.Text())
	}
	return out, scanner.Err()
}

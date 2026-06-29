package sqlcols

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
)

// goCallSite holds the source location plus extracted SQL fragment for
// a single string literal that looks like SQL.
type goCallSite struct {
	File string // absolute path
	Line int    // 1-based line of the literal
	SQL  string // the raw literal contents
	// Allowed records whether the call site is whitelisted by an
	// // migration-allowed: <reason> annotation.
	Allowed bool
	// AllowReason captures the comment text after `migration-allowed:`.
	AllowReason string
}

// extractGoSQLLiterals walks dir recursively, parses each non-test .go
// file, and returns every string literal whose contents look like SQL
// (heuristic: starts with a recognised keyword after trimming).
//
// Skip rules:
//   - vendor/, node_modules/, .git/ are skipped wholesale
//   - *_test.go files are skipped (tests embed fixture SQL)
//   - the sqlcols package itself is skipped (its strings ARE meta-SQL
//     used to test the scanner)
//   - generated files (lines beginning `// Code generated`) are skipped
func extractGoSQLLiterals(dir string) ([]goCallSite, error) {
	fset := token.NewFileSet()
	var sites []goCallSite

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			name := d.Name()
			if name == "vendor" || name == "node_modules" || name == ".git" ||
				name == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}
		// Skip our own package — its string literals ARE meta-SQL.
		slashed := filepath.ToSlash(path)
		if strings.Contains(slashed, "/auditbuild/sqlcols/") {
			return nil
		}

		f, parseErr := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if parseErr != nil {
			// Don't fail the whole walk on a single un-parseable file —
			// just skip. Audit ratchets must not break on syntactically
			// malformed code (the build will catch that elsewhere).
			return nil
		}
		// Generated marker check.
		if isGeneratedGo(f) {
			return nil
		}

		// Build a per-file map of "// migration-allowed: ..." comments
		// keyed by source line.
		allowComments := map[int]string{}
		for _, cg := range f.Comments {
			for _, c := range cg.List {
				txt := c.Text
				if i := strings.Index(txt, allowedAnnotation); i >= 0 {
					reason := strings.TrimSpace(txt[i+len(allowedAnnotation):])
					reason = strings.TrimPrefix(reason, ":")
					reason = strings.TrimSpace(reason)
					pos := fset.Position(c.Pos())
					allowComments[pos.Line] = reason
				}
			}
		}

		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok {
				return true
			}
			if lit.Kind != token.STRING {
				return true
			}
			raw := lit.Value
			s, err := strconv.Unquote(raw)
			if err != nil {
				return true
			}
			if !looksLikeSQL(s) {
				return true
			}
			pos := fset.Position(lit.Pos())
			site := goCallSite{
				File: path,
				Line: pos.Line,
				SQL:  s,
			}
			if reason, ok := nearestAllowComment(allowComments, pos.Line); ok {
				site.Allowed = true
				site.AllowReason = reason
			}
			sites = append(sites, site)
			return true
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return sites, nil
}

// isGeneratedGo reports whether f's leading comments declare it
// machine-generated. Matches the canonical "Code generated ... DO NOT
// EDIT." form.
func isGeneratedGo(f *ast.File) bool {
	for _, cg := range f.Comments {
		for _, c := range cg.List {
			line := strings.TrimSpace(c.Text)
			line = strings.TrimPrefix(line, "//")
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Code generated") &&
				strings.Contains(line, "DO NOT EDIT") {
				return true
			}
		}
		// Generated markers appear at the top of the file. Stop after
		// the first comment group.
		break
	}
	return false
}

// allowedAnnotation is the comment marker that whitelists a single SQL
// string. Place `// migration-allowed: <reason>` on the line directly
// above (up to 3 lines) the literal, or trailing on the same line.
const allowedAnnotation = "migration-allowed"

// nearestAllowComment looks for an annotation on the same line or up
// to 3 lines above and returns its reason string.
func nearestAllowComment(comments map[int]string, line int) (string, bool) {
	if reason, ok := comments[line]; ok {
		return reason, true
	}
	for delta := 1; delta <= 3; delta++ {
		if reason, ok := comments[line-delta]; ok {
			return reason, true
		}
	}
	return "", false
}

// looksLikeSQL is a coarse heuristic: a string literal is treated as
// SQL when its first non-whitespace token (case-insensitive) is one of
// the recognised statement keywords. We deliberately leave out DDL
// (CREATE/ALTER) — those should only appear in migration files, not
// embedded in production code.
func looksLikeSQL(s string) bool {
	t := strings.TrimLeft(s, " \t\n\r")
	upper := strings.ToUpper(t)
	switch {
	case strings.HasPrefix(upper, "SELECT "), strings.HasPrefix(upper, "SELECT\t"),
		strings.HasPrefix(upper, "SELECT\n"):
		return true
	case strings.HasPrefix(upper, "INSERT "), strings.HasPrefix(upper, "INSERT\t"),
		strings.HasPrefix(upper, "INSERT\n"):
		return true
	case strings.HasPrefix(upper, "UPDATE "), strings.HasPrefix(upper, "UPDATE\t"),
		strings.HasPrefix(upper, "UPDATE\n"):
		return true
	case strings.HasPrefix(upper, "DELETE "), strings.HasPrefix(upper, "DELETE\t"),
		strings.HasPrefix(upper, "DELETE\n"):
		return true
	case strings.HasPrefix(upper, "WITH "), strings.HasPrefix(upper, "WITH\t"),
		strings.HasPrefix(upper, "WITH\n"):
		return true
	}
	return false
}

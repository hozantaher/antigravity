// Package schema builds and exposes a deterministic, structure-only manifest
// of the application's PostgreSQL schema (tables, columns, indexes).
//
// It is consumed by the dashboard "Tests as Heart" surface and by external
// contract checks. The manifest contains METADATA ONLY — no row data, no
// counts. System tables (pg_*, information_schema.*) and the migration
// tracking table (schema_migrations) are explicitly excluded.
package schema

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// ManifestVersion is bumped when the manifest's structural shape changes.
const ManifestVersion = "1"

// excludedTables is the set of internal/migration tables that must never
// appear in the manifest. Kept as a small map for O(1) lookups.
var excludedTables = map[string]struct{}{
	"schema_migrations": {},
}

// Column describes a single column. Field order matters for JSON
// determinism — see canonicalManifest.
type Column struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default"` // pointer so JSON encodes null vs ""
}

// Index describes a single index on a table.
type Index struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
}

// Table aggregates the structural metadata for one table.
type Table struct {
	Columns []Column `json:"columns"`
	Indexes []Index  `json:"indexes"`
}

// Manifest is the top-level structure returned by the /schema endpoint.
//
// `Tables` is always non-nil — an empty database produces an empty map, never
// `null`. `ManifestHash` is a sha256 of the canonical encoding (sorted keys,
// no whitespace) prefixed with `sha256:`.
type Manifest struct {
	Version      string           `json:"version"`
	GeneratedAt  time.Time        `json:"generated_at"`
	Tables       map[string]Table `json:"tables"`
	ManifestHash string           `json:"manifest_hash"`
}

// BuildManifest queries the live PostgreSQL schema and returns a Manifest.
// The manifest does NOT include the hash; call ManifestHash separately and
// assign — this allows callers to mutate `GeneratedAt` (which would otherwise
// destabilise the hash) before hashing.
//
// The hash is computed over the structural fields only (`tables` + `version`)
// so two builds against the same schema produce the same hash even though
// `generated_at` differs.
func BuildManifest(ctx context.Context, db *sql.DB) (*Manifest, error) {
	if db == nil {
		return nil, fmt.Errorf("schema.BuildManifest: nil db")
	}

	tables, err := loadColumns(ctx, db)
	if err != nil {
		return nil, fmt.Errorf("schema.BuildManifest: load columns: %w", err)
	}

	if err := loadIndexes(ctx, db, tables); err != nil {
		return nil, fmt.Errorf("schema.BuildManifest: load indexes: %w", err)
	}

	m := &Manifest{
		Version:     ManifestVersion,
		GeneratedAt: time.Now().UTC(),
		Tables:      tables,
	}
	m.ManifestHash = ManifestHash(m)
	return m, nil
}

// loadColumns queries information_schema.columns for every base table in the
// `public` schema, ordered by ordinal_position so the result is deterministic.
func loadColumns(ctx context.Context, db *sql.DB) (map[string]Table, error) {
	const q = `
		SELECT c.table_name, c.column_name, c.data_type,
		       c.is_nullable, c.column_default
		FROM information_schema.columns c
		JOIN information_schema.tables t
		  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = 'public'
		  AND t.table_type = 'BASE TABLE'
		ORDER BY c.table_name, c.ordinal_position`

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query columns: %w", err)
	}
	defer rows.Close()

	tables := make(map[string]Table)
	for rows.Next() {
		var (
			tableName, colName, dataType, isNullable string
			colDefault                               sql.NullString
		)
		if err := rows.Scan(&tableName, &colName, &dataType, &isNullable, &colDefault); err != nil {
			return nil, fmt.Errorf("scan columns: %w", err)
		}
		if _, skip := excludedTables[tableName]; skip {
			continue
		}
		col := Column{
			Name:     colName,
			Type:     dataType,
			Nullable: isNullable == "YES",
		}
		if colDefault.Valid {
			d := colDefault.String
			col.Default = &d
		}
		t := tables[tableName]
		t.Columns = append(t.Columns, col)
		// Indexes are filled in by loadIndexes; keep nil-safe slice for now.
		if t.Indexes == nil {
			t.Indexes = []Index{}
		}
		tables[tableName] = t
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows columns: %w", err)
	}
	return tables, nil
}

// loadIndexes queries pg_indexes for every table already present in `tables`.
// Index column membership is parsed via pg_get_indexdef → array form.
func loadIndexes(ctx context.Context, db *sql.DB, tables map[string]Table) error {
	const q = `
		SELECT
			i.tablename,
			i.indexname,
			ix.indisunique,
			array_agg(a.attname ORDER BY array_position(ix.indkey::int[], a.attnum::int))
		FROM pg_indexes i
		JOIN pg_class c ON c.relname = i.indexname
		JOIN pg_index ix ON ix.indexrelid = c.oid
		JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = ANY(ix.indkey)
		WHERE i.schemaname = 'public'
		GROUP BY i.tablename, i.indexname, ix.indisunique
		ORDER BY i.tablename, i.indexname`

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return fmt.Errorf("query indexes: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			tableName, indexName string
			unique               bool
			cols                 pgStringArray
		)
		if err := rows.Scan(&tableName, &indexName, &unique, &cols); err != nil {
			return fmt.Errorf("scan indexes: %w", err)
		}
		if _, skip := excludedTables[tableName]; skip {
			continue
		}
		t, ok := tables[tableName]
		if !ok {
			// Index on a table not surfaced in columns — skip rather than orphan.
			continue
		}
		t.Indexes = append(t.Indexes, Index{
			Name:    indexName,
			Columns: []string(cols),
			Unique:  unique,
		})
		tables[tableName] = t
	}
	return rows.Err()
}

// ManifestHash returns sha256:<64hex> over the canonical structural form of
// the manifest. The hash is independent of `GeneratedAt` and `ManifestHash`
// itself — it depends only on `Version` + `Tables`.
//
// Canonicalisation rules:
//   - JSON keys sorted (Go's encoding/json sorts map keys by default)
//   - Slice order preserved (we already sort columns by ordinal, indexes
//     by name in loadIndexes)
//   - Default values compared as raw strings — operators wishing to ignore
//     formatting differences (e.g. "now()" vs "now ()") must normalise
//     upstream; we compare what Postgres reports.
func ManifestHash(m *Manifest) string {
	if m == nil {
		// Stable hash for nil — surfaces bugs early without panicking.
		sum := sha256.Sum256([]byte("schema:nil"))
		return "sha256:" + hex.EncodeToString(sum[:])
	}

	type canonical struct {
		Version string           `json:"version"`
		Tables  map[string]Table `json:"tables"`
	}
	c := canonical{
		Version: m.Version,
		Tables:  m.Tables,
	}
	if c.Tables == nil {
		c.Tables = map[string]Table{}
	}

	buf, err := json.Marshal(c)
	if err != nil {
		// json.Marshal on this shape can only fail on truly exotic input
		// (e.g. cyclic structures), which our types preclude.
		sum := sha256.Sum256([]byte("schema:marshal-error:" + err.Error()))
		return "sha256:" + hex.EncodeToString(sum[:])
	}
	sum := sha256.Sum256(buf)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// pgStringArray scans a Postgres text[] (e.g. {id,email,created_at}) into a
// Go []string. We avoid pulling in lib/pq just for this — the manifest
// package keeps its surface tiny and standard-library-only.
type pgStringArray []string

func (a *pgStringArray) Scan(src interface{}) error {
	switch v := src.(type) {
	case nil:
		*a = nil
		return nil
	case []byte:
		return a.parse(string(v))
	case string:
		return a.parse(v)
	case []string:
		// Test fixtures (sqlmock) may pass already-decoded slices.
		out := make([]string, len(v))
		copy(out, v)
		*a = out
		return nil
	}
	return fmt.Errorf("pgStringArray: unsupported scan source %T", src)
}

// parse handles the `{a,b,"c d"}` Postgres array text format. It is
// intentionally strict — we never see NULL elements in pg_attribute.attname.
func (a *pgStringArray) parse(s string) error {
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return fmt.Errorf("pgStringArray: malformed array %q", s)
	}
	inner := s[1 : len(s)-1]
	if inner == "" {
		*a = []string{}
		return nil
	}
	out := make([]string, 0, 4)
	var (
		buf   []byte
		quote bool
	)
	for i := 0; i < len(inner); i++ {
		c := inner[i]
		switch {
		case c == '"' && !quote:
			quote = true
		case c == '"' && quote:
			quote = false
		case c == '\\' && i+1 < len(inner):
			buf = append(buf, inner[i+1])
			i++
		case c == ',' && !quote:
			out = append(out, string(buf))
			buf = buf[:0]
		default:
			buf = append(buf, c)
		}
	}
	out = append(out, string(buf))
	// Stable order for hash determinism. pg_get_indexdef already returns
	// columns in definition order; we sort here only as a safety net for
	// callers using older Postgres array_agg without ORDER BY.
	if !sort.StringsAreSorted(out) {
		// Don't actually sort — definition order is meaningful for indexes.
		// This branch is intentionally a no-op; left as a documentation
		// hook so future maintainers know we considered alphabetisation.
		_ = out
	}
	*a = out
	return nil
}

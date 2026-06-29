package schema

import (
	"context"
	"crypto/rand"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"fmt"
	mathrand "math/rand"
	"regexp"
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// columnRows builds an *sqlmock.Rows carrying the (table, column, type,
// is_nullable, column_default) shape that loadColumns expects. Helps every
// test below stay table-driven.
func columnRows(rows ...[]driver.Value) *sqlmock.Rows {
	r := sqlmock.NewRows([]string{
		"table_name", "column_name", "data_type", "is_nullable", "column_default",
	})
	for _, row := range rows {
		r.AddRow(row...)
	}
	return r
}

func indexRows(rows ...[]driver.Value) *sqlmock.Rows {
	r := sqlmock.NewRows([]string{
		"tablename", "indexname", "indisunique", "cols",
	})
	for _, row := range rows {
		r.AddRow(row...)
	}
	return r
}

// expectAll wires the two mock queries that BuildManifest issues, in order.
func expectAll(mock sqlmock.Sqlmock, cols, idx *sqlmock.Rows) {
	mock.ExpectQuery(`information_schema.columns`).WillReturnRows(cols)
	mock.ExpectQuery(`pg_indexes`).WillReturnRows(idx)
}

// ---------------------------------------------------------------------------
// 1. BuildManifest returns expected tables when DB has multiple tables
// ---------------------------------------------------------------------------

func TestBuildManifest_PopulatesTables(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	cols := columnRows(
		[]driver.Value{"campaigns", "id", "integer", "NO", "nextval('campaigns_id_seq')"},
		[]driver.Value{"campaigns", "name", "text", "NO", nil},
		[]driver.Value{"contacts", "id", "integer", "NO", nil},
		[]driver.Value{"outreach_mailboxes", "from_address", "text", "NO", nil},
	)
	idx := indexRows(
		[]driver.Value{"campaigns", "campaigns_pkey", true, "{id}"},
		[]driver.Value{"contacts", "contacts_pkey", true, "{id}"},
	)
	expectAll(mock, cols, idx)

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if m == nil {
		t.Fatal("expected non-nil manifest")
	}
	if len(m.Tables) != 3 {
		t.Fatalf("expected 3 tables, got %d (%v)", len(m.Tables), keysOf(m.Tables))
	}
	if got := len(m.Tables["campaigns"].Columns); got != 2 {
		t.Fatalf("campaigns: expected 2 columns, got %d", got)
	}
	if got := len(m.Tables["campaigns"].Indexes); got != 1 {
		t.Fatalf("campaigns: expected 1 index, got %d", got)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// 2. Column order is deterministic (sorted by ordinal_position via SQL ORDER BY)
// ---------------------------------------------------------------------------

func TestBuildManifest_ColumnOrderPreservesOrdinal(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	// Driver returns rows in ordinal order — we verify we don't reorder.
	cols := columnRows(
		[]driver.Value{"users", "id", "integer", "NO", nil},
		[]driver.Value{"users", "email", "text", "NO", nil},
		[]driver.Value{"users", "created_at", "timestamp", "NO", "now()"},
	)
	expectAll(mock, cols, indexRows())

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"id", "email", "created_at"}
	got := make([]string, 0, len(m.Tables["users"].Columns))
	for _, c := range m.Tables["users"].Columns {
		got = append(got, c.Name)
	}
	if !equalSlices(got, want) {
		t.Fatalf("column order: want %v, got %v", want, got)
	}
}

// ---------------------------------------------------------------------------
// 3. Manifest hash is stable across runs (same DB → same hash)
// ---------------------------------------------------------------------------

func TestManifestHash_StableAcrossRuns(t *testing.T) {
	build := func() *Manifest {
		db, mock, _ := sqlmock.New()
		defer db.Close()
		cols := columnRows(
			[]driver.Value{"t", "id", "integer", "NO", nil},
		)
		expectAll(mock, cols, indexRows())
		m, err := BuildManifest(context.Background(), db)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	a := build()
	b := build()
	if a.ManifestHash != b.ManifestHash {
		t.Fatalf("hash drift: %s vs %s", a.ManifestHash, b.ManifestHash)
	}
}

// ---------------------------------------------------------------------------
// 4. Hash changes when a column is added
// ---------------------------------------------------------------------------

func TestManifestHash_ChangesOnColumnAdded(t *testing.T) {
	withDB := func(extra []driver.Value) *Manifest {
		db, mock, _ := sqlmock.New()
		defer db.Close()
		base := [][]driver.Value{
			{"t", "id", "integer", "NO", nil},
		}
		if extra != nil {
			base = append(base, extra)
		}
		expectAll(mock, columnRows(base...), indexRows())
		m, err := BuildManifest(context.Background(), db)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	before := withDB(nil)
	after := withDB([]driver.Value{"t", "name", "text", "YES", nil})
	if before.ManifestHash == after.ManifestHash {
		t.Fatalf("hash should differ after adding a column; got %s", before.ManifestHash)
	}
}

// ---------------------------------------------------------------------------
// 5. Hash changes when a column type changes
// ---------------------------------------------------------------------------

func TestManifestHash_ChangesOnTypeChanged(t *testing.T) {
	build := func(typ string) *Manifest {
		db, mock, _ := sqlmock.New()
		defer db.Close()
		expectAll(mock, columnRows(
			[]driver.Value{"t", "id", typ, "NO", nil},
		), indexRows())
		m, err := BuildManifest(context.Background(), db)
		if err != nil {
			t.Fatal(err)
		}
		return m
	}
	a := build("integer")
	b := build("bigint")
	if a.ManifestHash == b.ManifestHash {
		t.Fatalf("hash should differ when type changes")
	}
}

// ---------------------------------------------------------------------------
// 6. Hash NOT changed when generated_at differs (canonical compare)
// ---------------------------------------------------------------------------

func TestManifestHash_IndependentOfGeneratedAt(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
	), indexRows())

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	original := m.ManifestHash

	// Mutate generated_at and recompute hash — must be identical.
	m.GeneratedAt = m.GeneratedAt.Add(123456789)
	if got := ManifestHash(m); got != original {
		t.Fatalf("hash should be independent of generated_at; orig=%s new=%s", original, got)
	}
}

// ---------------------------------------------------------------------------
// 7. Empty DB → empty (non-nil) tables map
// ---------------------------------------------------------------------------

func TestBuildManifest_EmptyDBReturnsEmptyMap(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(), indexRows())

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if m.Tables == nil {
		t.Fatal("Tables must be non-nil even for an empty DB")
	}
	if len(m.Tables) != 0 {
		t.Fatalf("expected 0 tables, got %d", len(m.Tables))
	}

	// Round-trip through JSON to confirm the map encodes as `{}` not `null`.
	buf, _ := json.Marshal(m)
	if !strings.Contains(string(buf), `"tables":{}`) {
		t.Fatalf("expected `\"tables\":{}` in JSON, got %s", buf)
	}
}

// ---------------------------------------------------------------------------
// 8. Handles tables with no indexes
// ---------------------------------------------------------------------------

func TestBuildManifest_TableWithNoIndexes(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(
		[]driver.Value{"events", "raw", "jsonb", "NO", nil},
	), indexRows())

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	tbl := m.Tables["events"]
	if tbl.Indexes == nil {
		t.Fatal("Indexes slice must be non-nil")
	}
	if len(tbl.Indexes) != 0 {
		t.Fatalf("expected 0 indexes, got %d", len(tbl.Indexes))
	}
}

// ---------------------------------------------------------------------------
// 9. Handles arrays / json / jsonb columns correctly
// ---------------------------------------------------------------------------

func TestBuildManifest_HandlesArrayAndJSONColumns(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(
		[]driver.Value{"t", "tags", "ARRAY", "YES", nil},
		[]driver.Value{"t", "payload", "jsonb", "NO", "'{}'::jsonb"},
		[]driver.Value{"t", "data", "json", "YES", nil},
	), indexRows())

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	cols := m.Tables["t"].Columns
	if len(cols) != 3 {
		t.Fatalf("want 3 cols, got %d", len(cols))
	}
	if cols[0].Type != "ARRAY" || cols[1].Type != "jsonb" || cols[2].Type != "json" {
		t.Fatalf("type fidelity lost: %+v", cols)
	}
	if cols[1].Default == nil || *cols[1].Default != "'{}'::jsonb" {
		t.Fatalf("jsonb default lost: %+v", cols[1].Default)
	}
}

// ---------------------------------------------------------------------------
// 10. Handles tables with composite primary key
// ---------------------------------------------------------------------------

func TestBuildManifest_CompositePrimaryKey(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock,
		columnRows(
			[]driver.Value{"link_table", "left_id", "integer", "NO", nil},
			[]driver.Value{"link_table", "right_id", "integer", "NO", nil},
		),
		indexRows(
			[]driver.Value{"link_table", "link_table_pkey", true, "{left_id,right_id}"},
		),
	)

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	idx := m.Tables["link_table"].Indexes
	if len(idx) != 1 {
		t.Fatalf("want 1 index, got %d", len(idx))
	}
	if !idx[0].Unique {
		t.Fatal("composite PK should be unique")
	}
	if !equalSlices(idx[0].Columns, []string{"left_id", "right_id"}) {
		t.Fatalf("composite key columns wrong: %v", idx[0].Columns)
	}
}

// ---------------------------------------------------------------------------
// 11. Hash format is `sha256:<64hex>`
// ---------------------------------------------------------------------------

func TestManifestHash_Format(t *testing.T) {
	re := regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

	cases := []*Manifest{
		nil,
		{Version: "1", Tables: nil},
		{Version: "1", Tables: map[string]Table{}},
		{Version: "1", Tables: map[string]Table{
			"a": {Columns: []Column{{Name: "id", Type: "int"}}, Indexes: []Index{}},
		}},
	}
	for i, m := range cases {
		got := ManifestHash(m)
		if !re.MatchString(got) {
			t.Fatalf("case %d: hash %q does not match sha256:<64hex>", i, got)
		}
	}
}

// ---------------------------------------------------------------------------
// 12. Property: hash deterministic across 100 random schemas
// ---------------------------------------------------------------------------

func TestManifestHash_Property_Deterministic(t *testing.T) {
	r := mathrand.New(mathrand.NewSource(0xC0FFEE))
	for trial := 0; trial < 100; trial++ {
		m := randomManifest(r)
		// Recompute the hash from the same structure twice — must be equal.
		h1 := ManifestHash(m)
		h2 := ManifestHash(m)
		if h1 != h2 {
			t.Fatalf("trial %d: nondeterministic hash %s vs %s", trial, h1, h2)
		}

		// Encode/decode round-trip — hash of decoded must match original.
		buf, err := json.Marshal(m)
		if err != nil {
			t.Fatalf("trial %d: marshal: %v", trial, err)
		}
		var m2 Manifest
		if err := json.Unmarshal(buf, &m2); err != nil {
			t.Fatalf("trial %d: unmarshal: %v", trial, err)
		}
		if got := ManifestHash(&m2); got != h1 {
			t.Fatalf("trial %d: round-trip hash drift: %s vs %s", trial, h1, got)
		}
	}
}

// ---------------------------------------------------------------------------
// 13. Excluded tables (schema_migrations) never appear in manifest
// ---------------------------------------------------------------------------

func TestBuildManifest_SkipsSchemaMigrations(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock,
		columnRows(
			[]driver.Value{"schema_migrations", "version", "text", "NO", nil},
			[]driver.Value{"campaigns", "id", "integer", "NO", nil},
		),
		indexRows(
			[]driver.Value{"schema_migrations", "schema_migrations_pkey", true, "{version}"},
			[]driver.Value{"campaigns", "campaigns_pkey", true, "{id}"},
		),
	)

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Tables["schema_migrations"]; ok {
		t.Fatal("schema_migrations must be excluded from manifest")
	}
	if _, ok := m.Tables["campaigns"]; !ok {
		t.Fatal("campaigns must be present")
	}
}

// ---------------------------------------------------------------------------
// 14. BuildManifest returns error on nil db (defensive guard)
// ---------------------------------------------------------------------------

func TestBuildManifest_NilDBReturnsError(t *testing.T) {
	if _, err := BuildManifest(context.Background(), nil); err == nil {
		t.Fatal("expected error for nil db")
	}
}

// ---------------------------------------------------------------------------
// 15. BuildManifest propagates DB error from columns query
// ---------------------------------------------------------------------------

func TestBuildManifest_ColumnsQueryError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`information_schema.columns`).WillReturnError(fmt.Errorf("boom"))

	if _, err := BuildManifest(context.Background(), db); err == nil {
		t.Fatal("expected error from columns query")
	}
}

// ---------------------------------------------------------------------------
// 16. BuildManifest propagates DB error from indexes query
// ---------------------------------------------------------------------------

func TestBuildManifest_IndexesQueryError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	mock.ExpectQuery(`information_schema.columns`).WillReturnRows(columnRows(
		[]driver.Value{"t", "id", "integer", "NO", nil},
	))
	mock.ExpectQuery(`pg_indexes`).WillReturnError(fmt.Errorf("boom"))

	if _, err := BuildManifest(context.Background(), db); err == nil {
		t.Fatal("expected error from indexes query")
	}
}

// ---------------------------------------------------------------------------
// 17. Nullable flag round-trips correctly
// ---------------------------------------------------------------------------

func TestBuildManifest_NullableRoundTrip(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()
	expectAll(mock, columnRows(
		[]driver.Value{"t", "required", "text", "NO", nil},
		[]driver.Value{"t", "optional", "text", "YES", nil},
	), indexRows())

	m, err := BuildManifest(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	cols := m.Tables["t"].Columns
	if cols[0].Nullable {
		t.Fatal("first column should be NOT NULL")
	}
	if !cols[1].Nullable {
		t.Fatal("second column should be NULLABLE")
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func keysOf(m map[string]Table) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func equalSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// randomManifest produces a structurally valid manifest from a seeded RNG.
// Used by the determinism property test.
func randomManifest(r *mathrand.Rand) *Manifest {
	tables := make(map[string]Table)
	n := r.Intn(8) + 1
	for i := 0; i < n; i++ {
		tname := fmt.Sprintf("t_%s", randID(r, 6))
		ncols := r.Intn(5) + 1
		cols := make([]Column, ncols)
		for j := range cols {
			c := Column{
				Name:     fmt.Sprintf("c_%s", randID(r, 4)),
				Type:     []string{"integer", "text", "boolean", "timestamp", "jsonb"}[r.Intn(5)],
				Nullable: r.Intn(2) == 0,
			}
			if r.Intn(2) == 0 {
				d := fmt.Sprintf("default_%d", j)
				c.Default = &d
			}
			cols[j] = c
		}
		nidx := r.Intn(3)
		idx := make([]Index, nidx)
		for j := range idx {
			idx[j] = Index{
				Name:    fmt.Sprintf("idx_%s_%d", tname, j),
				Columns: []string{cols[r.Intn(ncols)].Name},
				Unique:  r.Intn(2) == 0,
			}
		}
		tables[tname] = Table{Columns: cols, Indexes: idx}
	}
	return &Manifest{Version: ManifestVersion, Tables: tables}
}

func randID(r *mathrand.Rand, n int) string {
	buf := make([]byte, n/2+1)
	if _, err := rand.Read(buf); err != nil {
		// Fall back to deterministic source if crypto/rand fails (it won't).
		for i := range buf {
			buf[i] = byte(r.Intn(256))
		}
	}
	return hex.EncodeToString(buf)[:n]
}

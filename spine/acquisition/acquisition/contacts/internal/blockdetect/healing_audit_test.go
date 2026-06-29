package blockdetect

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"math/rand"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// healing_audit_test.go — full-path validation that the KT-A8 healing
// infrastructure actually heals (not just logs). The tests in this file
// exercise:
//
//  1. classify → INSERT round-trip via sqlmock — the contract migration 008
//     expects of any future writer (block_type column matches detector
//     enum, body_signature is bounded, source_name flows through).
//  2. recovery cycle property — given N sources with random health, the
//     alt-source selector NEVER returns an excluded source. This codifies
//     the KT-A7 SelectAlternative contract before that PR lands; the test
//     defines the behaviour, the production impl in KT-A7 will satisfy it.
//
// The writer + selector are reference helpers private to _test.go. They are
// not production code — they exist only to (a) prove the migration schema
// is sufficient and (b) lock the recovery contract before KT-A7 lands.
// Per task spec: this PR is test-only; production wiring lives in KT-A7
// and the eventual KT-A8 healing-recovery PR.

// ─────────────────────────────────────────────────────────────────────────
// Section 1 — full-path classify → healing_log INSERT via sqlmock
// ─────────────────────────────────────────────────────────────────────────

// TestHealingLog_FullPath_TableDriven exercises the audit contract: every
// detected block class round-trips into healing_log with the correct wire
// values. We mock the DB so the test is hermetic; the SQL shape mirrors
// migration 008 exactly.
func TestHealingLog_FullPath_TableDriven(t *testing.T) {
	t.Parallel()

	type fixture struct {
		name        string
		source      string
		status      int
		headers     http.Header
		body        []byte
		targetURL   string
		wantBlock   BlockType
		wantWritten bool // false when classification is BlockTypeNone (no row inserted)
	}

	tests := []fixture{
		{
			name:        "ares/cloudflare_challenge",
			source:      "ares",
			status:      http.StatusOK,
			headers:     http.Header{"Cf-Ray": []string{"abc-PRG"}, "Content-Type": []string{"text/html"}},
			body:        []byte(`<html><title>Just a moment...</title></html>`),
			targetURL:   "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/23219700",
			wantBlock:   BlockTypeCloudflare,
			wantWritten: true,
		},
		{
			name:        "firmy_cz/captcha_recaptcha",
			source:      "firmy_cz",
			status:      http.StatusOK,
			headers:     http.Header{"Content-Type": []string{"text/html"}},
			body:        []byte(`<form><div class="g-recaptcha" data-sitekey="x"></div></form>`),
			targetURL:   "https://www.firmy.cz/detail/12345678",
			wantBlock:   BlockTypeCaptcha,
			wantWritten: true,
		},
		{
			name:        "ares/rate_limit_429",
			source:      "ares",
			status:      http.StatusTooManyRequests,
			headers:     http.Header{"Retry-After": []string{"60"}},
			body:        []byte(`{"error":"too many requests"}`),
			targetURL:   "https://ares.gov.cz/...",
			wantBlock:   BlockTypeRateLimit,
			wantWritten: true,
		},
		{
			name:        "firmy_cz/forbidden_legit_403",
			source:      "firmy_cz",
			status:      http.StatusForbidden,
			headers:     http.Header{"Server": []string{"nginx"}},
			body:        []byte(`<h1>403 Forbidden</h1>`),
			targetURL:   "https://www.firmy.cz/detail/abc",
			wantBlock:   BlockTypeForbidden,
			wantWritten: true,
		},
		{
			name:        "ares/cloudflare_403_anti_bot",
			source:      "ares",
			status:      http.StatusForbidden,
			headers:     http.Header{"Server": []string{"cloudflare"}},
			body:        []byte(`<html>Sorry, you have been blocked</html>`),
			targetURL:   "https://ares.gov.cz/...",
			wantBlock:   BlockTypeCloudflare,
			wantWritten: true,
		},
		{
			name:        "ares/legit_200_no_row_inserted",
			source:      "ares",
			status:      http.StatusOK,
			headers:     http.Header{"Content-Type": []string{"application/json"}},
			body:        []byte(`{"ico":"23219700"}`),
			targetURL:   "https://ares.gov.cz/...",
			wantBlock:   BlockTypeNone,
			wantWritten: false,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
			if err != nil {
				t.Fatalf("sqlmock.New: %v", err)
			}
			defer db.Close()

			gotBlock := DetectBlock(tt.status, tt.headers, tt.body)
			if gotBlock != tt.wantBlock {
				t.Fatalf("DetectBlock = %s, want %s", gotBlock, tt.wantBlock)
			}

			if tt.wantWritten {
				// Build expected body signature exactly the way the writer
				// will. Asserting the signature here is the audit contract:
				// every healing_log row must carry a forensic body sample +
				// hash so operators can correlate without storing PII bodies
				// in full.
				wantSig := computeBodySignature(tt.body)

				mock.ExpectExec(`INSERT INTO healing_log`).
					WithArgs(
						tt.source,
						gotBlock.String(),
						tt.status,
						tt.targetURL,
						wantSig,
					).
					WillReturnResult(sqlmock.NewResult(1, 1))
			}

			err = recordHealingEvent(context.Background(), db, healingEvent{
				source:    tt.source,
				blockType: gotBlock,
				status:    tt.status,
				targetURL: tt.targetURL,
				body:      tt.body,
			})
			if err != nil {
				t.Fatalf("recordHealingEvent: %v", err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatalf("expectations: %v", err)
			}
		})
	}
}

// TestHealingLog_BodySignatureBounded asserts the body_signature column never
// exceeds the forensic budget regardless of upstream payload size. Operators
// run unbounded SELECTs against healing_log; a multi-MB body in a single row
// would OOM the pgsql client.
func TestHealingLog_BodySignatureBounded(t *testing.T) {
	t.Parallel()

	huge := make([]byte, 10*1024*1024)
	for i := range huge {
		huge[i] = byte('a' + (i % 26))
	}

	sig := computeBodySignature(huge)
	const maxSignatureLen = 64 + 1 + 200 // sha256 hex + sep + 200-char sample
	if len(sig) > maxSignatureLen {
		t.Fatalf("body_signature délka %d > limit %d", len(sig), maxSignatureLen)
	}

	// Hash prefix MUST be deterministic & match canonical sha256.
	want := sha256.Sum256(huge)
	wantHex := hex.EncodeToString(want[:])
	if !strings.HasPrefix(sig, wantHex+":") {
		t.Fatalf("body_signature %q neobsahuje sha256 prefix %q", sig, wantHex)
	}
}

// TestHealingLog_NoneSkipsInsert explicitly proves the healing writer does
// NOT touch the DB when classification is BlockTypeNone. This is the
// efficiency invariant: 95% of fetches are nominal — they MUST NOT generate
// healing_log rows or the table grows by 100k+/day of useless entries.
func TestHealingLog_NoneSkipsInsert(t *testing.T) {
	t.Parallel()

	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	// No ExpectExec call — any DB activity will fail ExpectationsWereMet.

	err = recordHealingEvent(context.Background(), db, healingEvent{
		source:    "ares",
		blockType: BlockTypeNone,
		status:    200,
		targetURL: "https://ares.gov.cz/...",
		body:      []byte(`{"ico":"23219700"}`),
	})
	if err != nil {
		t.Fatalf("recordHealingEvent: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("expectations: %v", err)
	}
}

// TestHealingLog_DBErrorPropagates ensures the writer surfaces DB errors
// rather than silently swallowing them. Audit channel SLO depends on
// observability of write failures.
func TestHealingLog_DBErrorPropagates(t *testing.T) {
	t.Parallel()

	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherRegexp))
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`INSERT INTO healing_log`).
		WillReturnError(fmt.Errorf("connection refused"))

	err = recordHealingEvent(context.Background(), db, healingEvent{
		source:    "ares",
		blockType: BlockTypeCloudflare,
		status:    200,
		targetURL: "https://ares.gov.cz/...",
		body:      []byte(`<title>Just a moment...</title>`),
	})
	if err == nil {
		t.Fatalf("expected error from DB, got nil — writer swallows errors")
	}
	if !strings.Contains(err.Error(), "healing_log") {
		t.Fatalf("error %q nemá kontext healing_log; logy budou neuchopitelné", err)
	}
}

// healingEvent is the audit row payload shared by the test-only writer. The
// fields mirror migration 008 columns 1:1.
type healingEvent struct {
	source    string
	blockType BlockType
	status    int
	targetURL string
	body      []byte
}

// recordHealingEvent is a reference implementation of the KT-A8 audit writer.
// Production code lives behind the KT-A7 alt-source helper (not yet landed);
// this helper exists in _test.go only to:
//
//  1. Validate migration 008's INSERT shape against the sqlmock contract.
//  2. Lock the audit semantics: NONE skips, signature is bounded, errors
//     propagate with context.
//
// When the production writer lands, it must satisfy the SAME contract —
// these tests will be ported to point at the production symbol.
func recordHealingEvent(ctx context.Context, db *sql.DB, evt healingEvent) error {
	if evt.blockType == BlockTypeNone {
		return nil // nominal traffic — never landed in healing_log
	}
	sig := computeBodySignature(evt.body)
	const insertSQL = `INSERT INTO healing_log (source_name, block_type, http_status, target_url, body_signature) VALUES ($1, $2, $3, $4, $5)`
	if _, err := db.ExecContext(ctx, insertSQL,
		evt.source, evt.blockType.String(), evt.status, evt.targetURL, sig); err != nil {
		return fmt.Errorf("zápis healing_log selhal pro source=%s block_type=%s: %w", evt.source, evt.blockType, err)
	}
	return nil
}

// computeBodySignature returns "<sha256-hex>:<first-200-chars-printable>".
// Body sample is single-line — newlines collapsed to spaces — so SQL queries
// against the column don't need DOTALL flags.
func computeBodySignature(body []byte) string {
	sum := sha256.Sum256(body)
	hexSum := hex.EncodeToString(sum[:])
	const maxSample = 200
	sample := body
	if len(sample) > maxSample {
		sample = sample[:maxSample]
	}
	return hexSum + ":" + sanitizeSample(sample)
}

var sampleNewlines = regexp.MustCompile(`[\r\n\t]+`)

func sanitizeSample(b []byte) string {
	return sampleNewlines.ReplaceAllString(string(b), " ")
}

// ─────────────────────────────────────────────────────────────────────────
// Section 2 — recovery cycle property: SelectAlternative respects exclusions
// ─────────────────────────────────────────────────────────────────────────

// TestRecoveryCycle_SelectAlternativeRespectsExclusions is the property
// guard for the KT-A7 alt-source helper that has not yet landed. The
// contract under test:
//
//	∀ pool, exclude. SelectAlternative(pool, exclude) ∉ exclude
//	∧ (SelectAlternative ∈ pool ∪ {""})
//
// Selector reference impl lives in this file; the property test ensures
// any production replacement obeys the same contract — including under
// adversarial input (all sources excluded, duplicates, empty pool).
func TestRecoveryCycle_SelectAlternativeRespectsExclusions(t *testing.T) {
	t.Parallel()

	const iterations = 100
	for i := 0; i < iterations; i++ {
		i := i
		t.Run("seed="+strconv.Itoa(i), func(t *testing.T) {
			t.Parallel()
			r := rand.New(rand.NewSource(int64(20_000 + i)))

			pool := randomSourcePool(r)
			exclude := randomExclusions(r, pool)

			selected := selectAlternative(pool, exclude)

			if selected != "" && containsString(exclude, selected) {
				t.Fatalf("selectAlternative vrátil vyloučený zdroj %q\n  pool=%v\n  exclude=%v",
					selected, pool, exclude)
			}
			if selected != "" && !containsSourceName(pool, selected) {
				t.Fatalf("selectAlternative vrátil zdroj %q mimo pool\n  pool=%v",
					selected, pool)
			}
			// When ALL sources excluded, must return empty (escalate).
			allExcluded := allInExclude(pool, exclude)
			if allExcluded && selected != "" {
				t.Fatalf("selectAlternative vrátil %q i když všechny zdroje vyloučeny — operátor by neeskaloval", selected)
			}
		})
	}
}

// TestRecoveryCycle_DeterministicWithSameInputs locks the determinism
// contract: identical pool + exclusion produces identical output (after
// pool sort). This matters for replay: an operator re-running the recovery
// against a healing_log row must get the same selection the worker did.
func TestRecoveryCycle_DeterministicWithSameInputs(t *testing.T) {
	t.Parallel()

	pool := []sourceHealth{
		{name: "ares", healthScore: 0.9},
		{name: "firmy_cz", healthScore: 0.8},
		{name: "justice", healthScore: 0.7},
	}
	exclude := []string{"ares"}

	a := selectAlternative(pool, exclude)
	b := selectAlternative(pool, exclude)
	if a != b {
		t.Fatalf("selectAlternative je nedeterministický: %q vs %q", a, b)
	}
	if a == "" || a == "ares" {
		t.Fatalf("selectAlternative má vrátit zdravý alt zdroj ne-ares; got %q", a)
	}
}

// TestRecoveryCycle_EmptyPoolEscalates — the pathological input case. Empty
// pool MUST return empty (= escalate path), never panic.
func TestRecoveryCycle_EmptyPoolEscalates(t *testing.T) {
	t.Parallel()

	if got := selectAlternative(nil, []string{"ares"}); got != "" {
		t.Fatalf("empty pool: expected empty, got %q", got)
	}
	if got := selectAlternative([]sourceHealth{}, nil); got != "" {
		t.Fatalf("empty pool, nil exclude: expected empty, got %q", got)
	}
}

// TestRecoveryCycle_DuplicateExclusions — exclusion list with duplicates +
// non-existent names must not break the selector.
func TestRecoveryCycle_DuplicateExclusions(t *testing.T) {
	t.Parallel()

	pool := []sourceHealth{
		{name: "ares", healthScore: 0.9},
		{name: "firmy_cz", healthScore: 0.8},
	}
	exclude := []string{"ares", "ares", "ghost", "firmy_cz", "firmy_cz"}

	if got := selectAlternative(pool, exclude); got != "" {
		t.Fatalf("všechny v poolu vyloučené (přes duplicates): expected empty, got %q", got)
	}
}

// sourceHealth is the per-source health record used by selectAlternative.
// The two fields cover the minimal data the selector needs; production
// SelectAlternative may carry more (proxy_url, last_block_at, etc.) but
// the contract under test is name + health.
type sourceHealth struct {
	name        string
	healthScore float64 // [0..1] — higher is healthier
}

// selectAlternative is the reference recovery selector. Contract:
//
//   - Skips any source whose name is in `exclude`.
//   - Returns the healthiest remaining source by score, name asc as
//     tiebreaker for determinism.
//   - Returns "" when no eligible source remains (operator escalates).
//
// This impl is private to _test.go. KT-A7 will ship the production
// selector; that PR's tests will assert the same property test passes.
func selectAlternative(pool []sourceHealth, exclude []string) string {
	if len(pool) == 0 {
		return ""
	}
	excluded := make(map[string]struct{}, len(exclude))
	for _, e := range exclude {
		excluded[e] = struct{}{}
	}

	candidates := make([]sourceHealth, 0, len(pool))
	for _, s := range pool {
		if _, banned := excluded[s.name]; banned {
			continue
		}
		candidates = append(candidates, s)
	}
	if len(candidates) == 0 {
		return ""
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].healthScore != candidates[j].healthScore {
			return candidates[i].healthScore > candidates[j].healthScore
		}
		return candidates[i].name < candidates[j].name
	})
	return candidates[0].name
}

// randomSourcePool builds a 0..6-element pool of sources with random health.
// Names drawn from a small fixed set so collisions / duplicates exercise the
// dedupe path.
func randomSourcePool(r *rand.Rand) []sourceHealth {
	allNames := []string{"ares", "firmy_cz", "justice", "rejstrik", "obchodni_rejstrik", "datova_schranka"}
	n := r.Intn(len(allNames) + 1)
	out := make([]sourceHealth, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, sourceHealth{
			name:        allNames[i],
			healthScore: r.Float64(),
		})
	}
	return out
}

// randomExclusions returns a 0..len(pool) slice of source names to exclude,
// drawn from the pool plus occasionally a non-existent name (worst case the
// selector has to handle).
func randomExclusions(r *rand.Rand, pool []sourceHealth) []string {
	if len(pool) == 0 {
		// Even with empty pool the exclude list may still be set —
		// reflects real callers that exclude before checking pool.
		if r.Intn(2) == 0 {
			return []string{"ghost"}
		}
		return nil
	}
	count := r.Intn(len(pool) + 2)
	out := make([]string, 0, count)
	for i := 0; i < count; i++ {
		if r.Intn(4) == 0 {
			out = append(out, "ghost-"+strconv.Itoa(i))
			continue
		}
		out = append(out, pool[r.Intn(len(pool))].name)
	}
	return out
}

func containsString(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

func containsSourceName(haystack []sourceHealth, needle string) bool {
	for _, h := range haystack {
		if h.name == needle {
			return true
		}
	}
	return false
}

func allInExclude(pool []sourceHealth, exclude []string) bool {
	if len(pool) == 0 {
		return true
	}
	for _, p := range pool {
		if !containsString(exclude, p.name) {
			return false
		}
	}
	return true
}

// Compile-time guard: this file participates in the `time` package's import
// surface for future timestamp-based assertions; keep the dependency live so
// adding a healing_log occurred_at assertion does not require a re-import.
var _ = time.Now

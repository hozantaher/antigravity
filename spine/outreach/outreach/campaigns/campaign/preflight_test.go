package campaign

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// KT-A5 — pre-flight tests.
//
// Coverage targets (memory: feedback_extreme_testing — ≥ 10 cases):
//   - mailbox_passwords: happy, none active, missing password, db error
//   - suppression_union: happy, db error
//   - templates: empty list, nil engine
//   - privacy_url: empty (skip), 200, 4xx, malformed, HEAD-405-then-GET-200
//   - dns: empty list, happy, lookup error
//
// HARD RULE (memory feedback_campaign_send): no test calls
// sender.Engine.Send(). All probes are read-only or HEAD/DNS only.

// ── stub helpers ────────────────────────────────────────────────────

type stubResolver struct {
	addrs map[string][]string
	err   error
}

func (s stubResolver) LookupHost(_ context.Context, host string) ([]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	if a, ok := s.addrs[host]; ok {
		return a, nil
	}
	return nil, errors.New("no such host")
}

// ── checkMailboxPasswords ───────────────────────────────────────────

func TestCheckMailboxPasswords_Happy(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`COUNT.*outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"total", "with_pwd"}).AddRow(3, 3))

	got := checkMailboxPasswords(context.Background(), db)
	if !got.OK {
		t.Errorf("OK = false: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "3 aktivních") {
		t.Errorf("detail = %q, want substring '3 aktivních'", got.Detail)
	}
}

func TestCheckMailboxPasswords_NoneActive(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`COUNT.*outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"total", "with_pwd"}).AddRow(0, 0))

	got := checkMailboxPasswords(context.Background(), db)
	if got.OK {
		t.Errorf("OK = true with zero mailboxes; want false")
	}
}

func TestCheckMailboxPasswords_MissingPasswords(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`COUNT.*outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"total", "with_pwd"}).AddRow(5, 3))

	got := checkMailboxPasswords(context.Background(), db)
	if got.OK {
		t.Errorf("OK = true with missing passwords; want false")
	}
	if !strings.Contains(got.Detail, "2/5") {
		t.Errorf("detail = %q, want substring '2/5'", got.Detail)
	}
}

func TestCheckMailboxPasswords_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`COUNT.*outreach_mailboxes`).
		WillReturnError(errors.New("connection refused"))

	got := checkMailboxPasswords(context.Background(), db)
	if got.OK {
		t.Error("OK = true on db error; want false")
	}
}

func TestCheckMailboxPasswords_NilDB(t *testing.T) {
	got := checkMailboxPasswords(context.Background(), nil)
	if !got.OK {
		t.Error("nil db should be tolerated (skip)")
	}
}

// ── checkSuppressionUnion ───────────────────────────────────────────

func TestCheckSuppressionUnion_Happy(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`outreach_suppressions.*UNION.*suppression_list`).
		WillReturnRows(sqlmock.NewRows([]string{"cnt"}).AddRow(42))

	got := checkSuppressionUnion(context.Background(), db)
	if !got.OK {
		t.Errorf("OK = false: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "42 záznamů") {
		t.Errorf("detail = %q, want substring '42 záznamů'", got.Detail)
	}
}

func TestCheckSuppressionUnion_EmptyOK(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`outreach_suppressions.*UNION.*suppression_list`).
		WillReturnRows(sqlmock.NewRows([]string{"cnt"}).AddRow(0))

	got := checkSuppressionUnion(context.Background(), db)
	if !got.OK {
		t.Error("empty UNION should still pass — fresh-db case")
	}
}

func TestCheckSuppressionUnion_DBError(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`outreach_suppressions.*UNION.*suppression_list`).
		WillReturnError(errors.New("relation suppression_list does not exist"))

	got := checkSuppressionUnion(context.Background(), db)
	if got.OK {
		t.Error("OK = true on db error; want false")
	}
}

// ── checkTemplates ──────────────────────────────────────────────────

func TestCheckTemplates_EmptyList(t *testing.T) {
	got := checkTemplates(nil, nil)
	if !got.OK {
		t.Error("empty list should be tolerated (skip)")
	}
}

func TestCheckTemplates_NilEngine(t *testing.T) {
	got := checkTemplates([]string{"initial"}, nil)
	if !got.OK {
		t.Error("nil engine should be tolerated (skip)")
	}
	if !strings.Contains(got.Detail, "nezapojen") {
		t.Errorf("detail = %q, want skip explanation", got.Detail)
	}
}

// ── checkPrivacyURL ─────────────────────────────────────────────────

func TestCheckPrivacyURL_Empty_Skips(t *testing.T) {
	got := checkPrivacyURL(context.Background(), PreflightOptions{})
	if !got.OK {
		t.Error("empty URL should skip with OK=true")
	}
}

func TestCheckPrivacyURL_Happy200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("expected HEAD, got %s", r.Method)
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	got := checkPrivacyURL(context.Background(), PreflightOptions{
		PrivacyURL: srv.URL,
	})
	if !got.OK {
		t.Errorf("OK = false: %s", got.Detail)
	}
}

func TestCheckPrivacyURL_404Fails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(404)
	}))
	defer srv.Close()

	got := checkPrivacyURL(context.Background(), PreflightOptions{
		PrivacyURL: srv.URL,
	})
	if got.OK {
		t.Error("OK = true on 404; want false")
	}
}

func TestCheckPrivacyURL_Malformed(t *testing.T) {
	got := checkPrivacyURL(context.Background(), PreflightOptions{
		PrivacyURL: "::not-a-url::",
	})
	if got.OK {
		t.Error("malformed URL should fail")
	}
}

func TestCheckPrivacyURL_HEAD405_GET200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(405)
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	got := checkPrivacyURL(context.Background(), PreflightOptions{
		PrivacyURL: srv.URL,
	})
	if !got.OK {
		t.Errorf("HEAD 405 → GET 200 should pass: %s", got.Detail)
	}
}

// ── checkDNS ────────────────────────────────────────────────────────

func TestCheckDNS_EmptySkips(t *testing.T) {
	got := checkDNS(context.Background(), PreflightOptions{})
	if !got.OK {
		t.Error("empty domain list should skip with OK=true")
	}
}

func TestCheckDNS_Happy(t *testing.T) {
	got := checkDNS(context.Background(), PreflightOptions{
		SendingDomains: []string{"example.test", "operator@dealer.test"},
		Resolver: stubResolver{
			addrs: map[string][]string{
				"example.test": {"203.0.113.1"},
				"dealer.test":  {"203.0.113.2"},
			},
		},
	})
	if !got.OK {
		t.Errorf("OK = false: %s", got.Detail)
	}
}

func TestCheckDNS_LookupFails(t *testing.T) {
	got := checkDNS(context.Background(), PreflightOptions{
		SendingDomains: []string{"missing.invalid"},
		Resolver:       stubResolver{err: errors.New("NXDOMAIN")},
	})
	if got.OK {
		t.Error("OK = true on NXDOMAIN; want false")
	}
	if !strings.Contains(got.Detail, "NXDOMAIN") {
		t.Errorf("detail = %q, want NXDOMAIN substring", got.Detail)
	}
}

// ── RunPreflight aggregate ──────────────────────────────────────────

func TestRunPreflight_AllOK(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`COUNT.*outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"total", "with_pwd"}).AddRow(2, 2))
	mock.ExpectQuery(`outreach_suppressions.*UNION.*suppression_list`).
		WillReturnRows(sqlmock.NewRows([]string{"cnt"}).AddRow(0))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	rep := RunPreflight(context.Background(), db, PreflightOptions{
		PrivacyURL:     srv.URL,
		SendingDomains: []string{"example.test"},
		Resolver: stubResolver{
			addrs: map[string][]string{"example.test": {"203.0.113.1"}},
		},
		HTTPTimeout: 2 * time.Second,
	})
	if !rep.OK {
		t.Errorf("OK = false; checks: %+v", rep.Checks)
	}
	if len(rep.Checks) != 5 {
		t.Errorf("len(Checks) = %d, want 5", len(rep.Checks))
	}
}

func TestRunPreflight_OneFailureFlipsAggregate(t *testing.T) {
	db, mock, _ := sqlmock.New()
	defer db.Close()

	mock.ExpectQuery(`COUNT.*outreach_mailboxes`).
		WillReturnRows(sqlmock.NewRows([]string{"total", "with_pwd"}).AddRow(2, 1)) // missing
	mock.ExpectQuery(`outreach_suppressions.*UNION.*suppression_list`).
		WillReturnRows(sqlmock.NewRows([]string{"cnt"}).AddRow(0))

	rep := RunPreflight(context.Background(), db, PreflightOptions{})
	if rep.OK {
		t.Error("aggregate OK should flip to false on any sub-failure")
	}
}

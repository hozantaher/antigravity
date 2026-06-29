package intelligence

import (
	"context"
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

// injectDNSResolver replaces the package-level dnsLookupTXT with a mock.
func injectDNSResolver(t *testing.T, fn func(host string) ([]string, error)) {
	t.Helper()
	orig := dnsLookupTXT
	dnsLookupTXT = fn
	t.Cleanup(func() { dnsLookupTXT = orig })
}

// ── lookupSPF ─────────────────────────────────────────────────────────────────

func TestLookupSPF_Found(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		return []string{"v=spf1 include:email.cz ~all"}, nil
	})
	r := lookupSPF("email.cz")
	if !r.Found {
		t.Errorf("expected Found=true, got false")
	}
	if r.Problem != "" {
		t.Errorf("expected no problem, got %q", r.Problem)
	}
}

func TestLookupSPF_NotFound(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		return []string{"some_other_record"}, nil
	})
	r := lookupSPF("example.cz")
	if r.Found {
		t.Errorf("expected Found=false")
	}
	if r.Problem != "no_spf_record" {
		t.Errorf("want problem=no_spf_record, got %q", r.Problem)
	}
}

func TestLookupSPF_DNSError(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		return nil, errors.New("NXDOMAIN")
	})
	r := lookupSPF("ghost.cz")
	if r.Found {
		t.Errorf("expected Found=false on DNS error")
	}
	if r.Problem == "" {
		t.Errorf("expected problem string on DNS error")
	}
}

// ── lookupDKIM ────────────────────────────────────────────────────────────────

func TestLookupDKIM_SeznamSelector(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		if host == "seznam._domainkey.email.cz" {
			return []string{"v=DKIM1; k=rsa; p=MIGf..."}, nil
		}
		return nil, errors.New("NXDOMAIN")
	})
	r := lookupDKIM("email.cz", []string{"seznam", "default"})
	if !r.Found {
		t.Errorf("expected Found=true for seznam selector")
	}
	if r.Selector != "seznam" {
		t.Errorf("expected Selector=seznam, got %q", r.Selector)
	}
}

func TestLookupDKIM_FallbackSelector(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		if host == "default._domainkey.email.cz" {
			return []string{"k=rsa; p=ABC..."}, nil
		}
		return nil, errors.New("NXDOMAIN")
	})
	r := lookupDKIM("email.cz", []string{"seznam", "default"})
	if !r.Found {
		t.Errorf("expected Found=true via default selector fallback")
	}
	if r.Selector != "default" {
		t.Errorf("expected Selector=default, got %q", r.Selector)
	}
}

func TestLookupDKIM_NoSelectors(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		return nil, errors.New("NXDOMAIN")
	})
	r := lookupDKIM("ghost.cz", []string{"seznam", "default", "s1", "s2"})
	if r.Found {
		t.Errorf("expected Found=false when all selectors NXDOMAIN")
	}
	if r.Problem != "no_dkim_record_for_selectors" {
		t.Errorf("want problem=no_dkim_record_for_selectors, got %q", r.Problem)
	}
}

// ── lookupDMARC ───────────────────────────────────────────────────────────────

func TestLookupDMARC_Found(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		if host == "_dmarc.email.cz" {
			return []string{"v=DMARC1; p=quarantine; rua=mailto:dmarc@email.cz"}, nil
		}
		return nil, errors.New("NXDOMAIN")
	})
	r := lookupDMARC("email.cz")
	if !r.Found {
		t.Errorf("expected Found=true")
	}
}

func TestLookupDMARC_Missing(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		return []string{"unrelated record"}, nil
	})
	r := lookupDMARC("example.cz")
	if r.Found {
		t.Errorf("expected Found=false")
	}
	if r.Problem != "no_dmarc_record" {
		t.Errorf("want problem=no_dmarc_record, got %q", r.Problem)
	}
}

// ── CheckSenderAuth (integration of the three lookups) ────────────────────────

func TestCheckSenderAuth_AllPresent(t *testing.T) {
	injectDNSResolver(t, func(host string) ([]string, error) {
		switch host {
		case "email.cz":
			return []string{"v=spf1 include:email.cz ~all"}, nil
		case "seznam._domainkey.email.cz":
			return []string{"v=DKIM1; p=ABC"}, nil
		case "_dmarc.email.cz":
			return []string{"v=DMARC1; p=quarantine"}, nil
		}
		return nil, errors.New("NXDOMAIN")
	})
	r, err := CheckSenderAuth("email.cz")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !r.SPF.Found || !r.DKIM.Found || !r.DMARC.Found {
		t.Errorf("expected all records found: spf=%v dkim=%v dmarc=%v", r.SPF.Found, r.DKIM.Found, r.DMARC.Found)
	}
	if len(collectProblems(r)) != 0 {
		t.Errorf("expected no problems, got %v", collectProblems(r))
	}
}

func TestCheckSenderAuth_MissingRecord_Sentry(t *testing.T) {
	// DMARC missing → collectProblems returns one entry
	injectDNSResolver(t, func(host string) ([]string, error) {
		switch host {
		case "nomarc.cz":
			return []string{"v=spf1 ~all"}, nil
		case "seznam._domainkey.nomarc.cz":
			return []string{"p=ABC"}, nil
		}
		return nil, errors.New("NXDOMAIN")
	})
	r, _ := CheckSenderAuth("nomarc.cz")
	problems := collectProblems(r)
	if len(problems) == 0 {
		t.Errorf("expected problems for missing DMARC, got none")
	}
}

// ── RunSenderAuthenticationCheck (DB integration) ─────────────────────────────

func TestRunSenderAuthenticationCheck_EmptyMailboxes(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}))

	results, err := RunSenderAuthenticationCheck(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Error(err)
	}
}

func TestRunSenderAuthenticationCheck_SingleDomain(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT DISTINCT`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).AddRow("email.cz"))

	// Inject DNS so CheckSenderAuth succeeds for email.cz
	injectDNSResolver(t, func(host string) ([]string, error) {
		switch host {
		case "email.cz":
			return []string{"v=spf1 ~all"}, nil
		case "seznam._domainkey.email.cz":
			return []string{"p=DKIM"}, nil
		case "_dmarc.email.cz":
			return []string{"v=DMARC1; p=none"}, nil
		}
		return nil, errors.New("NXDOMAIN")
	})

	results, err := RunSenderAuthenticationCheck(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
	if results[0].Domain != "email.cz" {
		t.Errorf("expected domain=email.cz, got %q", results[0].Domain)
	}
}

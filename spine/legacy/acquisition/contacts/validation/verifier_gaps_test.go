package validation

import (
	"context"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ── LoadDomainCache: scan error (line 142) ──

func TestLoadDomainCache_ScanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Wrong column count → Scan fails
	mock.ExpectQuery(`SELECT domain, mx_exists`).
		WillReturnRows(sqlmock.NewRows([]string{"domain"}).AddRow("firma.cz"))

	v := NewVerifier(db)
	err = v.LoadDomainCache(context.Background())
	if err == nil {
		t.Error("expected scan error from LoadDomainCache")
	}
}

// ── VerifyEmail: StatusRoleOnly (line 267-268) ──
// Risky role address ("support@...") with valid domain in cache (no SMTP).

func TestVerifyEmail_RiskyRole_StatusRoleOnly(t *testing.T) {
	v := stubMXVerifier()
	// Pre-seed domain cache so checkDomain returns without network calls
	v.cache.Set("firma.cz", &domainEntry{
		mxExists:   true,
		isDisposable: false,
		isSpamtrap:   false,
		checkedAt:  time.Now(),
		// isCatchAll = nil → not catch-all
		// smtpConnectable = nil → SMTP check skipped
	})

	status, result := v.VerifyEmail(context.Background(), "support@firma.cz")
	// "support" is a risky role → IsRole=true, RiskLevel="medium"
	// Domain has MX, not catch-all, SMTP disabled → StatusRoleOnly
	if status != StatusRoleOnly {
		t.Errorf("status = %q, want StatusRoleOnly for risky role address (got result=%+v)", status, result)
	}
	if !result.IsRole {
		t.Error("expected IsRole=true for support@")
	}
}

// ── VerifyEmail: StatusRisky (line 270-271) ──
// Risky role "admin@..." with valid domain → RiskLevel="medium", IsRole=true
// But line 267 returns StatusRoleOnly first, so StatusRisky can't be reached via VerifyEmail
// unless IsRole=false. Since RiskLevel="medium" only sets when IsRole=true (via risky role),
// StatusRisky at 270 requires IsRole=false and RiskLevel="medium" — defensive code path.
// We skip this test as it's unreachable in current logic.

// ── VerifyEmail: SMTP connectable=true but EnableSMTP=false → no probe ──
// This covers reaching line 264 (past SMTP check) with smtpConnectable set.

func TestVerifyEmail_SMTPConnectable_EnableSMTPFalse(t *testing.T) {
	v := stubMXVerifier()
	v.EnableSMTP = false // SMTP probe disabled

	connectable := true
	isCatchAll := false
	v.cache.Set("firma.cz", &domainEntry{
		mxExists:        true,
		isDisposable:    false,
		isSpamtrap:      false,
		smtpConnectable: &connectable, // connectable but probe disabled
		isCatchAll:      &isCatchAll,
		checkedAt:       time.Now(),
	})

	// Normal email — should pass without SMTP probe
	status, _ := v.VerifyEmail(context.Background(), "jan.novak@firma.cz")
	if status == StatusInvalid {
		t.Errorf("status = %q, want non-invalid (SMTP disabled)", status)
	}
}

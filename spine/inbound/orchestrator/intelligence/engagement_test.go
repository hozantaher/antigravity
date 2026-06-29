package intelligence

import (
	"context"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// ── UpdateEngagementClusters ─────────────────────────────────────────────────

func TestUpdateEngagementClusters_Success(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 42))

	n, err := UpdateEngagementClusters(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 42 {
		t.Errorf("n = %d, want 42", n)
	}
}

func TestUpdateEngagementClusters_NoneUpdated(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies c`).
		WillReturnResult(sqlmock.NewResult(0, 0))

	n, err := UpdateEngagementClusters(context.Background(), db)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("n = %d, want 0", n)
	}
}

func TestUpdateEngagementClusters_DBError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectExec(`UPDATE companies c`).
		WillReturnError(errIntel("connection refused"))

	_, err = UpdateEngagementClusters(context.Background(), db)
	if err == nil {
		t.Error("expected error")
	}
}

// ── Cluster label semantics (unit coverage for the CASE logic) ───────────────
// These tests encode the expected cluster label for each engagement state.

func TestEngagementCluster_Labels(t *testing.T) {
	tests := []struct {
		name          string
		totalSent     int
		totalBounced  int
		totalReplied  int
		totalOpened   int
		recentReply   bool // last_replied within 30 days
		wantCluster   string
	}{
		{
			name:        "never_contacted",
			totalSent:   0,
			wantCluster: "never_contacted",
		},
		{
			name:         "bounced",
			totalSent:    3,
			totalBounced: 2,
			wantCluster:  "bounced",
		},
		{
			name:         "champion_recent_reply",
			totalSent:    5,
			totalReplied: 1,
			recentReply:  true,
			wantCluster:  "champion",
		},
		{
			name:         "warm_ghost_old_reply",
			totalSent:    5,
			totalReplied: 1,
			recentReply:  false,
			wantCluster:  "warm_ghost",
		},
		{
			name:        "engaged_no_reply",
			totalSent:   3,
			totalOpened: 2,
			wantCluster: "engaged_no_reply",
		},
		{
			name:        "fallback_never_contacted",
			totalSent:   1,
			wantCluster: "never_contacted",
		},
		{
			// bounced takes precedence over replied — CASE order matters
			name:         "bounced_beats_replied",
			totalSent:    5,
			totalBounced: 1,
			totalReplied: 1,
			recentReply:  true,
			wantCluster:  "bounced",
		},
		{
			// opened but no reply and no bounce — engaged_no_reply
			name:        "opened_only_engaged_no_reply",
			totalSent:   5,
			totalOpened: 3,
			wantCluster: "engaged_no_reply",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clusterLabel(tt.totalSent, tt.totalBounced, tt.totalReplied, tt.totalOpened, tt.recentReply)
			if got != tt.wantCluster {
				t.Errorf("clusterLabel = %q, want %q", got, tt.wantCluster)
			}
		})
	}
}

// clusterLabel is a pure Go re-implementation of the CASE logic in UpdateEngagementClusters.
// It lets us unit-test the business rules independently from the DB.
func clusterLabel(totalSent, totalBounced, totalReplied, totalOpened int, recentReply bool) string {
	switch {
	case totalSent == 0:
		return "never_contacted"
	case totalBounced > 0:
		return "bounced"
	case totalReplied >= 1 && recentReply:
		return "champion"
	case totalReplied >= 1:
		return "warm_ghost"
	case totalOpened >= 1 && totalReplied == 0:
		return "engaged_no_reply"
	default:
		return "never_contacted"
	}
}

type errIntel string

func (e errIntel) Error() string { return string(e) }

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"privacy-gateway/internal/model"
)

func TestIntakeStatusRequiresAuthorization(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	req := httptest.NewRequest(http.MethodGet, "/v1/intake/status", nil)
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, rec.Code)
	}
}

func TestIntakeStatusRejectsNonGET(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	req := httptest.NewRequest(http.MethodPost, "/v1/intake/status", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, rec.Code)
	}
}

func TestIntakeStatusReturnsNotImplementedWithoutSubmissionService(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})
	server.submissions = nil

	req := httptest.NewRequest(http.MethodGet, "/v1/intake/status", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, rec.Code)
	}
}

func TestIntakeStatusAggregatesSubmissionCounts(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	ctx := context.Background()

	// Pending (sanitized) submission
	_, err := server.submissions.CreateFromPublicAPI(ctx, actor, model.CreateSubmissionInput{
		ChannelID: "channel-pending",
		Subject:   "Pending",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() pending error = %v", err)
	}

	// Relayed submission
	relayed, err := server.submissions.CreateFromPublicAPI(ctx, actor, model.CreateSubmissionInput{
		ChannelID: "channel-relayed",
		Subject:   "Relayed",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() relayed error = %v", err)
	}
	relayedAt := time.Date(2026, 4, 10, 9, 0, 0, 0, time.UTC)
	if _, err := server.submissions.MarkRelayed(ctx, relayed.ID, "smtp", "rly_123", "messages_compat", relayedAt); err != nil {
		t.Fatalf("MarkRelayed() error = %v", err)
	}

	// Failed submission
	failed, err := server.submissions.CreateFromPublicAPI(ctx, actor, model.CreateSubmissionInput{
		ChannelID: "channel-failed",
		Subject:   "Failed",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() failed error = %v", err)
	}
	if _, err := server.submissions.MarkRelayFailed(ctx, failed.ID, "rly_failed", "smtp", "messages_compat", "delivery_failed", "terminal", "upstream error", time.Date(2026, 4, 10, 10, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}

	// Blocked submission (strict profile + recipients)
	_, err = server.submissions.CreateFromPublicAPI(ctx, actor, model.CreateSubmissionInput{
		ChannelID:        "channel-blocked",
		SanitizerProfile: "strict",
		Subject:          "Blocked",
		TextBody:         "Body",
		To:               []string{"recipient@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() blocked error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/intake/status", nil)
	req.Header.Set("Authorization", "Bearer intake-token")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}

	var status intakeStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode status response: %v", err)
	}

	if status.TotalSubmissions != 4 {
		t.Fatalf("TotalSubmissions = %d, want 4", status.TotalSubmissions)
	}
	if status.PendingSubmissions != 1 {
		t.Fatalf("PendingSubmissions = %d, want 1", status.PendingSubmissions)
	}
	if status.RelayedSubmissions != 1 {
		t.Fatalf("RelayedSubmissions = %d, want 1", status.RelayedSubmissions)
	}
	if status.FailedSubmissions != 1 {
		t.Fatalf("FailedSubmissions = %d, want 1", status.FailedSubmissions)
	}
	if status.BlockedSubmissions != 1 {
		t.Fatalf("BlockedSubmissions = %d, want 1", status.BlockedSubmissions)
	}
	if status.LatestRelayedAt.IsZero() {
		t.Fatal("LatestRelayedAt is zero")
	}
	if !status.LatestRelayedAt.Equal(relayedAt) {
		t.Fatalf("LatestRelayedAt = %s, want %s", status.LatestRelayedAt, relayedAt)
	}
	if status.LatestSubmissionAt.IsZero() {
		t.Fatal("LatestSubmissionAt is zero")
	}
}

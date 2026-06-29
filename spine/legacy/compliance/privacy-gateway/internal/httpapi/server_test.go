package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"privacy-gateway/internal/alias"
	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/auth"
	"privacy-gateway/internal/identityvault"
	"privacy-gateway/internal/inbox"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/policy"
	"privacy-gateway/internal/relay"
	"privacy-gateway/internal/sanitizer"
	"privacy-gateway/internal/submission"
)

func newTestServer(t *testing.T, actor model.Actor) *Server {
	t.Helper()

	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	relayService := relay.NewServiceWithRepository(gateway, "record-only", relay.NewMemoryRepository())
	identityService := identityvault.NewService(identityvault.NewMemoryRepository())
	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor})
	return NewServer(authenticator, aliasService, submissionPolicy, submissions, auditService, identityService, gateway, inboxStore, nil, 4096).
		WithRelayService(relayService).
		WithIntakeAuthenticator(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"intake-token": actor}))
}

func TestHealthEndpoint(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1"})

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected health status %d, got %d", http.StatusOK, recorder.Code)
	}
}

func TestUIShellReturnsHTML(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1"})

	request := httptest.NewRequest(http.MethodGet, "/ui", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected ui status %d, got %d", http.StatusOK, recorder.Code)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "text/html; charset=utf-8" {
		t.Fatalf("expected html content type, got %q", contentType)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, "Privacy Gateway") || !strings.Contains(body, "/v1/intake/queue") || !strings.Contains(body, "Load First Alias Timeline") || !strings.Contains(body, "Open Intake Timeline") || !strings.Contains(body, "Queue Metadata Profile") {
		t.Fatalf("expected local ui shell body, got %q", body)
	}
}

func TestAliasesRequireAuthorization(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/aliases", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized status %d, got %d", http.StatusUnauthorized, recorder.Code)
	}
}

func TestCreateAliasRejectsInvalidJSON(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString("{"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid json status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestListAliasesReturnsCreatedAlias(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createRequest := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createRequest.Header.Set("Authorization", "Bearer token")
	createRequest.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRecorder, createRequest)

	request := httptest.NewRequest(http.MethodGet, "/v1/aliases", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected list aliases status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Aliases []model.Alias `json:"aliases"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode aliases response: %v", err)
	}
	if len(response.Aliases) != 1 {
		t.Fatalf("expected 1 alias, got %d", len(response.Aliases))
	}
}

func TestAliasTimelineReturnsChannelContext(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createdAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() alias error = %v", err)
	}
	createdSubmission, err := server.submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: createdAlias.ID,
		To:        []string{"sender@example.com"},
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), createdSubmission.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: createdAlias,
		To:    []string{"sender@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if _, err := server.audit.Record(context.Background(), actor.TenantID, actor.ID, "relay_attempt_created", "rly_manual", map[string]string{
		"submission_id": createdSubmission.ID,
		"alias_id":      createdAlias.ID,
	}); err != nil {
		t.Fatalf("Record() relay audit error = %v", err)
	}
	if _, err := server.inboxStore.Save(context.Background(), model.InboxMessage{
		ID:           "imap_1",
		UserID:       actor.ID,
		TenantID:     actor.TenantID,
		AliasEmail:   createdAlias.Email,
		AliasID:      createdAlias.ID,
		SubmissionID: createdSubmission.ID,
		From:         "sender@example.com",
		To:           []string{createdAlias.Email},
		Subject:      "Re: Hello",
		TextBody:     "reply body",
		ReceivedAt:   time.Date(2026, 4, 3, 12, 10, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/aliases/"+createdAlias.ID+"/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected alias timeline status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary       map[string]any       `json:"summary"`
		Alias         model.Alias          `json:"alias"`
		Submissions   []model.Submission   `json:"submissions"`
		InboxMessages []model.InboxMessage `json:"inbox_messages"`
		RelayAttempts []model.RelayAttempt `json:"relay_attempts"`
		AuditEvents   []model.AuditEvent   `json:"audit_events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode alias timeline response: %v", err)
	}
	if response.Alias.ID != createdAlias.ID {
		t.Fatalf("expected alias %s, got %s", createdAlias.ID, response.Alias.ID)
	}
	if len(response.Submissions) != 1 || response.Submissions[0].ID != createdSubmission.ID {
		t.Fatalf("expected linked submission %s, got %+v", createdSubmission.ID, response.Submissions)
	}
	if len(response.InboxMessages) != 1 || response.InboxMessages[0].ID != "imap_1" {
		t.Fatalf("expected linked inbox message, got %+v", response.InboxMessages)
	}
	if len(response.RelayAttempts) != 1 {
		t.Fatalf("expected 1 relay attempt, got %d", len(response.RelayAttempts))
	}
	if len(response.AuditEvents) < 2 {
		t.Fatalf("expected alias-related audit events, got %d", len(response.AuditEvents))
	}
	if response.Summary["submission_count"] != float64(1) {
		t.Fatalf("expected submission_count=1, got %+v", response.Summary)
	}
	if response.Summary["inbox_count"] != float64(1) {
		t.Fatalf("expected inbox_count=1, got %+v", response.Summary)
	}
}

func TestAliasTimelineReturnsNotFoundWhenMissing(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/aliases/al_missing/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestChannelsReturnsAggregatedChannelSummaries(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	firstAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() first alias error = %v", err)
	}
	secondAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "ops"})
	if err != nil {
		t.Fatalf("Create() second alias error = %v", err)
	}
	createdSubmission, err := server.submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: firstAlias.ID,
		To:        []string{"sender@example.com"},
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), createdSubmission.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: firstAlias,
		To:    []string{"sender@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if _, err := server.inboxStore.Save(context.Background(), model.InboxMessage{
		ID:         "imap_1",
		UserID:     actor.ID,
		TenantID:   actor.TenantID,
		AliasEmail: firstAlias.Email,
		AliasID:    firstAlias.ID,
		From:       "sender@example.com",
		To:         []string{firstAlias.Email},
		Subject:    "Re: Hello",
		TextBody:   "reply body",
		ReceivedAt: time.Date(2026, 4, 3, 12, 10, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/channels", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected channels status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Channels []struct {
			Alias                    model.Alias `json:"alias"`
			SubmissionCount          int         `json:"submission_count"`
			InboxCount               int         `json:"inbox_count"`
			RelayAttemptCount        int         `json:"relay_attempt_count"`
			LatestSubmissionStatus   string      `json:"latest_submission_status"`
			LatestFailureClass       string      `json:"latest_failure_class"`
			LatestFailureDisposition string      `json:"latest_failure_disposition"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode channels response: %v", err)
	}
	if len(response.Channels) != 2 {
		t.Fatalf("expected 2 channels, got %d", len(response.Channels))
	}

	var foundFirst, foundSecond bool
	for _, item := range response.Channels {
		switch item.Alias.ID {
		case firstAlias.ID:
			foundFirst = true
			if item.SubmissionCount != 1 || item.InboxCount != 1 || item.RelayAttemptCount != 1 {
				t.Fatalf("expected populated first channel summary, got %+v", item)
			}
			if item.LatestSubmissionStatus != string(createdSubmission.Status) {
				t.Fatalf("expected status %s, got %s", createdSubmission.Status, item.LatestSubmissionStatus)
			}
			if item.LatestFailureClass != "timeout" || item.LatestFailureDisposition != "retryable" {
				t.Fatalf("expected failure summary on first channel, got %+v", item)
			}
		case secondAlias.ID:
			foundSecond = true
			if item.SubmissionCount != 0 || item.InboxCount != 0 || item.RelayAttemptCount != 0 {
				t.Fatalf("expected empty second channel summary, got %+v", item)
			}
		}
	}
	if !foundFirst || !foundSecond {
		t.Fatalf("expected both channel aliases in response, got %+v", response.Channels)
	}
}

func TestChannelsAppliesHasInboxLatestSubmissionStatusHasFailuresAndHasRelayAttemptsFilters(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	firstAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() first alias error = %v", err)
	}
	secondAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "ops"})
	if err != nil {
		t.Fatalf("Create() second alias error = %v", err)
	}
	firstSubmission, err := server.submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: firstAlias.ID,
		Subject:   "Failed one",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() first error = %v", err)
	}
	if _, err := server.submissions.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: secondAlias.ID,
		Subject:   "Accepted one",
		TextBody:  "Body",
	}); err != nil {
		t.Fatalf("Create() second error = %v", err)
	}
	if _, err := server.inboxStore.Save(context.Background(), model.InboxMessage{
		ID:         "imap_1",
		UserID:     actor.ID,
		TenantID:   actor.TenantID,
		AliasEmail: firstAlias.Email,
		AliasID:    firstAlias.ID,
		From:       "sender@example.com",
		To:         []string{firstAlias.Email},
		Subject:    "Re: Failed one",
		TextBody:   "reply body",
		ReceivedAt: time.Date(2026, 4, 3, 12, 10, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), firstSubmission.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: firstAlias,
		To:    []string{"sender@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/channels?has_inbox=true&latest_submission_status=sanitized&has_failures=true&has_relay_attempts=true", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected channels status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Channels []struct {
			Alias                  model.Alias `json:"alias"`
			InboxCount             int         `json:"inbox_count"`
			LatestSubmissionStatus string      `json:"latest_submission_status"`
		} `json:"channels"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode filtered channels response: %v", err)
	}
	if len(response.Channels) != 1 {
		t.Fatalf("expected 1 filtered channel, got %d", len(response.Channels))
	}
	if response.Channels[0].Alias.ID != firstAlias.ID {
		t.Fatalf("expected first alias only, got %+v", response.Channels)
	}
	if response.Channels[0].InboxCount != 1 || response.Channels[0].LatestSubmissionStatus != "sanitized" {
		t.Fatalf("unexpected filtered channel payload %+v", response.Channels[0])
	}
}

func TestChannelsRejectInvalidFilters(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodGet, "/v1/channels?has_inbox=maybe", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid has_inbox status %d, got %d", http.StatusBadRequest, recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/channels?has_failures=maybe", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid has_failures status %d, got %d", http.StatusBadRequest, recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/channels?has_relay_attempts=maybe", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid has_relay_attempts status %d, got %d", http.StatusBadRequest, recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/channels?latest_submission_status=unknown", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder = httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid latest_submission_status status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestDashboardReturnsAggregatedOverview(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	firstAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() first alias error = %v", err)
	}
	secondAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "ops"})
	if err != nil {
		t.Fatalf("Create() second alias error = %v", err)
	}
	firstSubmission, err := server.submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: firstAlias.ID,
		To:        []string{"sender@example.com"},
		Subject:   "Failed one",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}
	secondSubmission, err := server.submissions.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: secondAlias.ID,
		Subject:   "Accepted one",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() second submission error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), firstSubmission.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: firstAlias,
		To:    []string{"sender@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if _, err := server.inboxStore.Save(context.Background(), model.InboxMessage{
		ID:         "imap_1",
		UserID:     actor.ID,
		TenantID:   actor.TenantID,
		AliasEmail: firstAlias.Email,
		AliasID:    firstAlias.ID,
		From:       "sender@example.com",
		To:         []string{firstAlias.Email},
		Subject:    "Re: Failed one",
		TextBody:   "reply body",
		ReceivedAt: time.Date(2026, 4, 3, 12, 10, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if _, err := server.identityVault.CreateLink(context.Background(), actor, firstAlias.ID, "real@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/dashboard", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected dashboard status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary  map[string]any `json:"summary"`
		Channels []struct {
			Alias model.Alias `json:"alias"`
		} `json:"channels"`
		ProblemChannels []struct {
			Alias                  model.Alias `json:"alias"`
			LatestSubmissionStatus string      `json:"latest_submission_status"`
		} `json:"problem_channels"`
		RecentSubmissions []struct {
			ID               string                 `json:"id"`
			Status           model.SubmissionStatus `json:"status"`
			DeliveryBoundary string                 `json:"delivery_boundary"`
		} `json:"recent_submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode dashboard response: %v", err)
	}

	if response.Summary["alias_count"] != float64(2) {
		t.Fatalf("expected alias_count=2, got %+v", response.Summary)
	}
	if response.Summary["channel_count"] != float64(2) {
		t.Fatalf("expected channel_count=2, got %+v", response.Summary)
	}
	if response.Summary["submission_count"] != float64(2) {
		t.Fatalf("expected submission_count=2, got %+v", response.Summary)
	}
	if response.Summary["inbox_count"] != float64(1) {
		t.Fatalf("expected inbox_count=1, got %+v", response.Summary)
	}
	if response.Summary["relay_attempt_count"] != float64(1) {
		t.Fatalf("expected relay_attempt_count=1, got %+v", response.Summary)
	}
	if response.Summary["active_identity_link_count"] != float64(1) {
		t.Fatalf("expected active_identity_link_count=1, got %+v", response.Summary)
	}
	if response.Summary["failed_submission_count"] != float64(0) {
		t.Fatalf("expected failed_submission_count=0, got %+v", response.Summary)
	}
	if response.Summary["failed_relay_attempt_count"] != float64(1) {
		t.Fatalf("expected failed_relay_attempt_count=1, got %+v", response.Summary)
	}
	if response.Summary["audit_event_count"] == nil {
		t.Fatalf("expected audit_event_count in summary, got %+v", response.Summary)
	}
	if len(response.Channels) != 2 {
		t.Fatalf("expected 2 channels, got %d", len(response.Channels))
	}
	if response.Channels[0].Alias.ID != firstAlias.ID {
		t.Fatalf("expected most active alias first, got %+v", response.Channels)
	}
	if len(response.ProblemChannels) != 1 {
		t.Fatalf("expected 1 problem channel, got %+v", response.ProblemChannels)
	}
	if response.ProblemChannels[0].Alias.ID != firstAlias.ID || response.ProblemChannels[0].LatestSubmissionStatus != string(model.SubmissionStatusSanitized) {
		t.Fatalf("unexpected problem channel payload %+v", response.ProblemChannels[0])
	}
	if len(response.RecentSubmissions) != 2 {
		t.Fatalf("expected 2 recent submissions, got %+v", response.RecentSubmissions)
	}
	if response.RecentSubmissions[0].ID != secondSubmission.ID || response.RecentSubmissions[1].ID != firstSubmission.ID {
		t.Fatalf("unexpected recent submission order %+v", response.RecentSubmissions)
	}
	if response.RecentSubmissions[0].Status != model.SubmissionStatusAccepted || response.RecentSubmissions[1].DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected recent submission detail payload, got %+v", response.RecentSubmissions)
	}
}

func TestDashboardSupportsProblemOnlyAndCustomLimits(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	firstAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() first alias error = %v", err)
	}
	secondAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "ops"})
	if err != nil {
		t.Fatalf("Create() second alias error = %v", err)
	}

	firstSubmission, err := server.submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: firstAlias.ID,
		To:        []string{"sender@example.com"},
		Subject:   "Failed one",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), firstSubmission.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: firstAlias,
		To:    []string{"sender@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if _, err := server.submissions.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: secondAlias.ID,
		Subject:   "Accepted one",
		TextBody:  "Body",
	}); err != nil {
		t.Fatalf("Create() second submission error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/dashboard?problem_only=true&problem_limit=1&recent_limit=1", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected dashboard status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary  map[string]any `json:"summary"`
		Channels []struct {
			Alias model.Alias `json:"alias"`
		} `json:"channels"`
		ProblemChannels []struct {
			Alias model.Alias `json:"alias"`
		} `json:"problem_channels"`
		RecentSubmissions []struct {
			ID string `json:"id"`
		} `json:"recent_submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode dashboard response: %v", err)
	}
	if response.Summary["problem_channel_count"] != float64(1) {
		t.Fatalf("expected problem_channel_count=1, got %+v", response.Summary)
	}
	if len(response.Channels) != 1 || response.Channels[0].Alias.ID != firstAlias.ID {
		t.Fatalf("expected only problem channel in channels view, got %+v", response.Channels)
	}
	if len(response.ProblemChannels) != 1 || response.ProblemChannels[0].Alias.ID != firstAlias.ID {
		t.Fatalf("expected limited problem channel view, got %+v", response.ProblemChannels)
	}
	if len(response.RecentSubmissions) != 1 {
		t.Fatalf("expected recent_limit=1, got %+v", response.RecentSubmissions)
	}
}

func TestDashboardRejectsInvalidProblemOnlyFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodGet, "/v1/dashboard?problem_only=maybe", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected dashboard status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestRelayQueueReturnsSanitizedAndRetryableFailedSubmissions(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	if created.IntakeChannel != "secure_web_intake" || created.DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected privacy-first intake defaults, got %+v", created)
	}

	if _, err := server.submissions.MarkRelayFailed(context.Background(), created.ID, "rly_1", "smtp", "messages_compat", "timeout", "retryable", "dial tcp timeout", time.Now().UTC()); err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}
	second, err := server.submissions.Create(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "channel-2",
		Subject:   "Relayed one",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("Create() second error = %v", err)
	}
	if _, err := server.submissions.MarkRelayed(context.Background(), second.ID, "smtp", "rly_2", "messages_compat", time.Now().UTC()); err != nil {
		t.Fatalf("MarkRelayed() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/relay-queue", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected relay queue status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary     map[string]any     `json:"summary"`
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode relay queue response: %v", err)
	}
	if response.Summary["queue_count"] != float64(1) {
		t.Fatalf("expected queue_count=1, got %+v", response.Summary)
	}
	if response.Summary["retryable_failed_count"] != float64(1) {
		t.Fatalf("expected retryable_failed_count=1, got %+v", response.Summary)
	}
	if len(response.Submissions) != 1 || response.Submissions[0].ID != created.ID {
		t.Fatalf("expected retryable failed submission only, got %+v", response.Submissions)
	}
}

func TestIntakeQueueReturnsActorScopedQueueCandidates(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createAccepted := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createAccepted.Header.Set("Authorization", "Bearer intake-token")
	createAccepted.Header.Set("Content-Type", "application/json")
	acceptedRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(acceptedRec, createAccepted)
	if acceptedRec.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, acceptedRec.Code)
	}

	var accepted model.Submission
	if err := json.Unmarshal(acceptedRec.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("failed to decode accepted submission: %v", err)
	}

	if _, err := server.submissions.MarkRelayFailed(context.Background(), accepted.ID, "rly_1", "smtp", "intake_queue", "timeout", "retryable", "dial tcp timeout", time.Now().UTC()); err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}

	createStrict := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-2","sanitizer_profile":"strict","subject":"Hello","text_body":"Body"}`))
	createStrict.Header.Set("Authorization", "Bearer intake-token")
	createStrict.Header.Set("Content-Type", "application/json")
	strictRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(strictRec, createStrict)
	if strictRec.Code != http.StatusCreated {
		t.Fatalf("expected strict intake create status %d, got %d", http.StatusCreated, strictRec.Code)
	}

	var strict model.Submission
	if err := json.Unmarshal(strictRec.Body.Bytes(), &strict); err != nil {
		t.Fatalf("failed to decode strict submission: %v", err)
	}

	queueReq := httptest.NewRequest(http.MethodGet, "/v1/intake/queue", nil)
	queueReq.Header.Set("Authorization", "Bearer intake-token")
	queueRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(queueRec, queueReq)

	if queueRec.Code != http.StatusOK {
		t.Fatalf("expected intake queue status %d, got %d", http.StatusOK, queueRec.Code)
	}

	var response struct {
		Summary struct {
			QueueCount           int `json:"queue_count"`
			RetryableFailedCount int `json:"retryable_failed_count"`
			StrictProfileCount   int `json:"strict_profile_count"`
		} `json:"summary"`
		Submissions []struct {
			ID               string            `json:"id"`
			AvailableActions []string          `json:"available_actions"`
			ActionTargets    map[string]string `json:"action_targets"`
		} `json:"submissions"`
	}
	if err := json.Unmarshal(queueRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode intake queue response: %v", err)
	}
	if response.Summary.QueueCount != 2 || response.Summary.RetryableFailedCount != 1 || response.Summary.StrictProfileCount != 1 {
		t.Fatalf("unexpected intake queue summary %+v", response.Summary)
	}
	if len(response.Submissions) != 2 {
		t.Fatalf("expected 2 intake queue submissions, got %+v", response.Submissions)
	}
	if response.Submissions[0].ActionTargets["view_detail"] == "" || len(response.Submissions[1].AvailableActions) == 0 {
		t.Fatalf("expected action hints in intake queue payload, got %+v", response.Submissions)
	}
}

func TestIntakeQueueSupportsFiltersAndLimit(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createRetryable := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createRetryable.Header.Set("Authorization", "Bearer intake-token")
	createRetryable.Header.Set("Content-Type", "application/json")
	retryableRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(retryableRec, createRetryable)
	if retryableRec.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, retryableRec.Code)
	}

	var retryable model.Submission
	if err := json.Unmarshal(retryableRec.Body.Bytes(), &retryable); err != nil {
		t.Fatalf("failed to decode retryable submission: %v", err)
	}
	if _, err := server.submissions.MarkRelayFailed(context.Background(), retryable.ID, "rly_1", "smtp", "intake_queue", "timeout", "retryable", "dial tcp timeout", time.Now().UTC()); err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}

	createStrict := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-2","sanitizer_profile":"strict","subject":"Hello","text_body":"Body"}`))
	createStrict.Header.Set("Authorization", "Bearer intake-token")
	createStrict.Header.Set("Content-Type", "application/json")
	strictRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(strictRec, createStrict)
	if strictRec.Code != http.StatusCreated {
		t.Fatalf("expected strict intake create status %d, got %d", http.StatusCreated, strictRec.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/queue?metadata_profile=minimized_strict&limit=1", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected intake queue status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary struct {
			QueueCount           int `json:"queue_count"`
			RetryableFailedCount int `json:"retryable_failed_count"`
			StrictProfileCount   int `json:"strict_profile_count"`
		} `json:"summary"`
		Submissions []struct {
			ID string `json:"id"`
		} `json:"submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode intake queue response: %v", err)
	}
	if response.Summary.QueueCount != 1 || response.Summary.RetryableFailedCount != 0 || response.Summary.StrictProfileCount != 1 {
		t.Fatalf("unexpected filtered intake queue summary %+v", response.Summary)
	}
	if len(response.Submissions) != 1 {
		t.Fatalf("expected one filtered queue submission, got %+v", response.Submissions)
	}
}

func TestIntakeQueueRejectsInvalidRetryableOnly(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/queue?retryable_only=maybe", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected intake queue status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestAliasCreateAndSendFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createAliasReq := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createAliasReq.Header.Set("Authorization", "Bearer token")
	createAliasReq.Header.Set("Content-Type", "application/json")
	createAliasRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createAliasRec, createAliasReq)

	if createAliasRec.Code != http.StatusCreated {
		t.Fatalf("expected alias creation status %d, got %d", http.StatusCreated, createAliasRec.Code)
	}

	var created model.Alias
	if err := json.Unmarshal(createAliasRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode alias response: %v", err)
	}

	payload := model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"recipient@example.com"},
		Subject:  "hello",
		TextBody: "safe body",
	}
	body, _ := json.Marshal(payload)

	sendReq := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader(body))
	sendReq.Header.Set("Authorization", "Bearer token")
	sendReq.Header.Set("Content-Type", "application/json")
	sendRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(sendRec, sendReq)

	if sendRec.Code != http.StatusAccepted {
		t.Fatalf("expected send status %d, got %d: %s", http.StatusAccepted, sendRec.Code, sendRec.Body.String())
	}
}

func TestSendRejectsInvalidJSON(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewBufferString("{"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid json status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSendRejectsUnownedAlias(t *testing.T) {
	owner := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, owner)

	createRequest := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createRequest.Header.Set("Authorization", "Bearer token")
	createRequest.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRecorder, createRequest)

	var created model.Alias
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode alias response: %v", err)
	}

	requestBody, _ := json.Marshal(model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"recipient@example.com"},
		Subject:  "hello",
		TextBody: "safe body",
	})

	request := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader(requestBody))
	request.Header.Set("Authorization", "Bearer other-token")
	request.Header.Set("Content-Type", "application/json")
	server.auth = auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		"token":       owner,
		"other-token": {ID: "user-2", TenantID: "tenant-1"},
	})
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected forbidden status %d, got %d", http.StatusForbidden, recorder.Code)
	}
}

func TestOutboxReturnsSentMessages(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, nil, 4096)

	created, err := aliasService.Create(context.Background(), actor, model.CreateAliasInput{Label: "Support"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := submissionPolicy.Submit(context.Background(), actor, model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"recipient@example.com"},
		Subject:  "hello",
		TextBody: "safe body",
	}); err != nil {
		t.Fatalf("Submit() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/messages/outbox", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected outbox status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Messages []model.MessageRecord `json:"messages"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode outbox response: %v", err)
	}
	if len(response.Messages) != 1 {
		t.Fatalf("expected 1 message in outbox, got %d", len(response.Messages))
	}
}

func TestOutboxRejectsMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/messages/outbox", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestSubmissionsCreateAndListFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, recorder.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}
	if created.ChannelID != "channel-1" {
		t.Fatalf("expected channel-1, got %s", created.ChannelID)
	}
	if created.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", created.Status)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/submissions", nil)
	listReq.Header.Set("Authorization", "Bearer token")
	listRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("expected submissions list status %d, got %d", http.StatusOK, listRec.Code)
	}

	var listResponse struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResponse); err != nil {
		t.Fatalf("failed to decode submissions list response: %v", err)
	}
	if len(listResponse.Submissions) != 1 {
		t.Fatalf("expected 1 submission, got %d", len(listResponse.Submissions))
	}
}

func TestSubmissionsListAppliesStatusFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	filteredReq := httptest.NewRequest(http.MethodGet, "/v1/submissions?status=sanitized", nil)
	filteredReq.Header.Set("Authorization", "Bearer token")
	filteredRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(filteredRec, filteredReq)

	if filteredRec.Code != http.StatusOK {
		t.Fatalf("expected submissions list status %d, got %d", http.StatusOK, filteredRec.Code)
	}

	var filteredResponse struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(filteredRec.Body.Bytes(), &filteredResponse); err != nil {
		t.Fatalf("failed to decode submissions list response: %v", err)
	}
	if len(filteredResponse.Submissions) != 1 {
		t.Fatalf("expected 1 filtered submission, got %d", len(filteredResponse.Submissions))
	}
	if filteredResponse.Submissions[0].Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status, got %s", filteredResponse.Submissions[0].Status)
	}

	emptyReq := httptest.NewRequest(http.MethodGet, "/v1/submissions?status=relayed", nil)
	emptyReq.Header.Set("Authorization", "Bearer token")
	emptyRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(emptyRec, emptyReq)

	if emptyRec.Code != http.StatusOK {
		t.Fatalf("expected empty filtered status %d, got %d", http.StatusOK, emptyRec.Code)
	}

	var emptyResponse struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(emptyRec.Body.Bytes(), &emptyResponse); err != nil {
		t.Fatalf("failed to decode empty filtered submissions response: %v", err)
	}
	if len(emptyResponse.Submissions) != 0 {
		t.Fatalf("expected 0 relayed submissions, got %d", len(emptyResponse.Submissions))
	}
}

func TestSubmissionsListAcceptsFailedStatusFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	if _, err := server.submissions.MarkRelayFailed(context.Background(), created.ID, "rly_failed", "smtp", "messages_compat", "delivery_failed", "terminal", "smtp dial failed", time.Date(2026, time.April, 3, 13, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}

	filteredReq := httptest.NewRequest(http.MethodGet, "/v1/submissions?status=failed", nil)
	filteredReq.Header.Set("Authorization", "Bearer token")
	filteredRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(filteredRec, filteredReq)

	if filteredRec.Code != http.StatusOK {
		t.Fatalf("expected submissions list status %d, got %d", http.StatusOK, filteredRec.Code)
	}

	var filteredResponse struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(filteredRec.Body.Bytes(), &filteredResponse); err != nil {
		t.Fatalf("failed to decode submissions list response: %v", err)
	}
	if len(filteredResponse.Submissions) != 1 {
		t.Fatalf("expected 1 failed submission, got %d", len(filteredResponse.Submissions))
	}
	if filteredResponse.Submissions[0].Status != model.SubmissionStatusFailed {
		t.Fatalf("expected failed status, got %s", filteredResponse.Submissions[0].Status)
	}
	if filteredResponse.Submissions[0].RelayFailureDisposition != "terminal" {
		t.Fatalf("expected terminal failure disposition, got %s", filteredResponse.Submissions[0].RelayFailureDisposition)
	}
}

func TestSubmissionsListRejectsInvalidStatusFilter(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions?status=unknown", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestRelayAttemptsListAndGetFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createdAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() alias error = %v", err)
	}

	if _, _, err := server.relay.Relay(context.Background(), "sub_1", model.SanitizedMessage{
		Actor:    actor,
		Alias:    createdAlias,
		To:       []string{"recipient@example.com"},
		Subject:  "Hello",
		TextBody: "Body",
	}); err != nil {
		t.Fatalf("Relay() error = %v", err)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/relay-attempts?status=sent", nil)
	listReq.Header.Set("Authorization", "Bearer token")
	listRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected relay attempts list status %d, got %d", http.StatusOK, listRec.Code)
	}

	var listResponse struct {
		Summary       map[string]any       `json:"summary"`
		RelayAttempts []model.RelayAttempt `json:"relay_attempts"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &listResponse); err != nil {
		t.Fatalf("failed to decode relay attempts response: %v", err)
	}
	if len(listResponse.RelayAttempts) != 1 {
		t.Fatalf("expected 1 relay attempt, got %d", len(listResponse.RelayAttempts))
	}
	if listResponse.RelayAttempts[0].Status != "sent" {
		t.Fatalf("expected sent relay attempt, got %s", listResponse.RelayAttempts[0].Status)
	}
	if listResponse.Summary["attempt_count"] != float64(1) {
		t.Fatalf("expected attempt_count=1, got %+v", listResponse.Summary)
	}
	if listResponse.Summary["failed_count"] != float64(0) {
		t.Fatalf("expected failed_count=0, got %+v", listResponse.Summary)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1/relay-attempts/"+listResponse.RelayAttempts[0].ID, nil)
	getReq.Header.Set("Authorization", "Bearer token")
	getRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected relay attempt detail status %d, got %d", http.StatusOK, getRec.Code)
	}

	var detailed model.RelayAttempt
	if err := json.Unmarshal(getRec.Body.Bytes(), &detailed); err != nil {
		t.Fatalf("failed to decode relay attempt detail: %v", err)
	}
	if detailed.ID != listResponse.RelayAttempts[0].ID {
		t.Fatalf("expected relay attempt %s, got %s", listResponse.RelayAttempts[0].ID, detailed.ID)
	}
}

func TestRelayAttemptsRejectInvalidStatusFilter(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/relay-attempts?status=unknown", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestRelayAttemptsSummaryCountsFailedDispositions(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createdAlias, err := server.aliases.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() alias error = %v", err)
	}

	if _, err := server.relay.RecordFailure(context.Background(), "sub_1", model.SanitizedMessage{
		Actor: actor,
		Alias: createdAlias,
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() first error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), "sub_2", model.SanitizedMessage{
		Actor: actor,
		Alias: createdAlias,
	}, "auth_failed", "terminal", "535 authentication failed"); err != nil {
		t.Fatalf("RecordFailure() second error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/relay-attempts", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected relay attempts status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary       map[string]any       `json:"summary"`
		RelayAttempts []model.RelayAttempt `json:"relay_attempts"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode relay attempts response: %v", err)
	}
	if len(response.RelayAttempts) != 2 {
		t.Fatalf("expected 2 relay attempts, got %d", len(response.RelayAttempts))
	}
	if response.Summary["failed_count"] != float64(2) {
		t.Fatalf("expected failed_count=2, got %+v", response.Summary)
	}
	if response.Summary["retryable_count"] != float64(1) {
		t.Fatalf("expected retryable_count=1, got %+v", response.Summary)
	}
	if response.Summary["terminal_count"] != float64(1) {
		t.Fatalf("expected terminal_count=1, got %+v", response.Summary)
	}
}

func TestAuditEventsApplySubmissionIDFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	if _, err := server.audit.Record(context.Background(), actor.TenantID, actor.ID, "submission_created", "sub_1", nil); err != nil {
		t.Fatalf("Record() first event error = %v", err)
	}
	if _, err := server.audit.Record(context.Background(), actor.TenantID, actor.ID, "relay_attempt_created", "rly_1", map[string]string{
		"submission_id": "sub_1",
	}); err != nil {
		t.Fatalf("Record() second event error = %v", err)
	}
	if _, err := server.audit.Record(context.Background(), actor.TenantID, actor.ID, "relay_attempt_created", "rly_2", map[string]string{
		"submission_id": "sub_2",
	}); err != nil {
		t.Fatalf("Record() third event error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events?submission_id=sub_1", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected audit events status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode audit response: %v", err)
	}
	if len(response.Events) != 2 {
		t.Fatalf("expected 2 submission-filtered events, got %d", len(response.Events))
	}
}

func TestSubmissionsListAppliesChannelIDFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	for _, payload := range []string{
		`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`,
		`{"channel_id":"channel-2","subject":"Hello","text_body":"Body"}`,
	} {
		createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(payload))
		createReq.Header.Set("Authorization", "Bearer token")
		createReq.Header.Set("Content-Type", "application/json")
		createRec := httptest.NewRecorder()
		server.Handler().ServeHTTP(createRec, createReq)

		if createRec.Code != http.StatusCreated {
			t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
		}
	}

	filteredReq := httptest.NewRequest(http.MethodGet, "/v1/submissions?channel_id=channel-2", nil)
	filteredReq.Header.Set("Authorization", "Bearer token")
	filteredRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(filteredRec, filteredReq)

	if filteredRec.Code != http.StatusOK {
		t.Fatalf("expected submissions list status %d, got %d", http.StatusOK, filteredRec.Code)
	}

	var filteredResponse struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(filteredRec.Body.Bytes(), &filteredResponse); err != nil {
		t.Fatalf("failed to decode submissions list response: %v", err)
	}
	if len(filteredResponse.Submissions) != 1 {
		t.Fatalf("expected 1 filtered submission, got %d", len(filteredResponse.Submissions))
	}
	if filteredResponse.Submissions[0].ChannelID != "channel-2" {
		t.Fatalf("expected channel-2, got %s", filteredResponse.Submissions[0].ChannelID)
	}
}

func TestSubmissionsListAppliesLimit(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	for _, payload := range []string{
		`{"channel_id":"channel-1","subject":"Hello 1","text_body":"Body"}`,
		`{"channel_id":"channel-2","subject":"Hello 2","text_body":"Body"}`,
	} {
		createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(payload))
		createReq.Header.Set("Authorization", "Bearer token")
		createReq.Header.Set("Content-Type", "application/json")
		createRec := httptest.NewRecorder()
		server.Handler().ServeHTTP(createRec, createReq)

		if createRec.Code != http.StatusCreated {
			t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions?limit=1", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected submissions list status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode submissions list response: %v", err)
	}
	if len(response.Submissions) != 1 {
		t.Fatalf("expected 1 limited submission, got %d", len(response.Submissions))
	}
}

func TestSubmissionsListRejectsInvalidLimit(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions?limit=0", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionsGetByIDFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1/submissions/"+created.ID, nil)
	getReq.Header.Set("Authorization", "Bearer token")
	getRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("expected submission get status %d, got %d", http.StatusOK, getRec.Code)
	}

	var fetched model.Submission
	if err := json.Unmarshal(getRec.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("failed to decode submission detail response: %v", err)
	}
	if fetched.ID != created.ID {
		t.Fatalf("expected submission id %s, got %s", created.ID, fetched.ID)
	}
}

func TestSubmissionTimelineReturnsSubmissionRelayAttemptsAndAudit(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	if _, err := server.relay.RecordFailure(context.Background(), created.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: model.Alias{ID: "alias-1", Email: "support@relay.example"},
		To:    []string{"recipient@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if _, err := server.audit.Record(context.Background(), actor.TenantID, actor.ID, "relay_attempt_created", "rly_manual", map[string]string{
		"submission_id": created.ID,
	}); err != nil {
		t.Fatalf("Record() relay audit error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions/"+created.ID+"/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected submission timeline status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary       map[string]any       `json:"summary"`
		Submission    model.Submission     `json:"submission"`
		RelayAttempts []model.RelayAttempt `json:"relay_attempts"`
		AuditEvents   []model.AuditEvent   `json:"audit_events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode submission timeline response: %v", err)
	}
	if response.Submission.ID != created.ID {
		t.Fatalf("expected submission id %s, got %s", created.ID, response.Submission.ID)
	}
	if len(response.RelayAttempts) != 1 {
		t.Fatalf("expected 1 relay attempt, got %d", len(response.RelayAttempts))
	}
	if len(response.AuditEvents) != 2 {
		t.Fatalf("expected 2 audit events, got %d", len(response.AuditEvents))
	}
	if response.Summary["latest_status"] != string(created.Status) && response.Summary["latest_status"] != created.Status {
		t.Fatalf("expected latest_status to reflect submission status, got %+v", response.Summary)
	}
	if response.Summary["attempt_count"] != float64(1) {
		t.Fatalf("expected attempt_count=1, got %+v", response.Summary)
	}
	if response.Summary["audit_event_count"] != float64(2) {
		t.Fatalf("expected audit_event_count=2, got %+v", response.Summary)
	}
	if response.Summary["latest_failure_class"] != "timeout" {
		t.Fatalf("expected latest_failure_class=timeout, got %+v", response.Summary)
	}
	if response.Summary["latest_failure_disposition"] != "retryable" {
		t.Fatalf("expected latest_failure_disposition=retryable, got %+v", response.Summary)
	}
}

func TestSubmissionTimelineReturnsNotFoundWhenMissing(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions/sub_missing/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestSubmissionQueueAndReleaseEndpoints(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	queueReq := httptest.NewRequest(http.MethodPost, "/v1/submissions/"+created.ID+"/queue", nil)
	queueReq.Header.Set("Authorization", "Bearer token")
	queueRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(queueRec, queueReq)
	if queueRec.Code != http.StatusOK {
		t.Fatalf("expected queue status %d, got %d", http.StatusOK, queueRec.Code)
	}

	var queued model.Submission
	if err := json.Unmarshal(queueRec.Body.Bytes(), &queued); err != nil {
		t.Fatalf("failed to decode queued submission: %v", err)
	}
	if queued.Status != model.SubmissionStatusQueued {
		t.Fatalf("expected queued status, got %s", queued.Status)
	}

	releaseReq := httptest.NewRequest(http.MethodPost, "/v1/submissions/"+created.ID+"/release", nil)
	releaseReq.Header.Set("Authorization", "Bearer token")
	releaseRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(releaseRec, releaseReq)
	if releaseRec.Code != http.StatusOK {
		t.Fatalf("expected release status %d, got %d", http.StatusOK, releaseRec.Code)
	}

	var released model.Submission
	if err := json.Unmarshal(releaseRec.Body.Bytes(), &released); err != nil {
		t.Fatalf("failed to decode released submission: %v", err)
	}
	if released.Status != model.SubmissionStatusSanitized {
		t.Fatalf("expected sanitized status after release, got %s", released.Status)
	}
}

func TestSubmissionRelayEndpointRelaysAliasBackedSubmission(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	server := newTestServer(t, actor)

	createAliasReq := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createAliasReq.Header.Set("Authorization", "Bearer token")
	createAliasReq.Header.Set("Content-Type", "application/json")
	createAliasRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createAliasRec, createAliasReq)
	if createAliasRec.Code != http.StatusCreated {
		t.Fatalf("expected alias create status %d, got %d", http.StatusCreated, createAliasRec.Code)
	}

	var createdAlias model.Alias
	if err := json.Unmarshal(createAliasRec.Body.Bytes(), &createdAlias); err != nil {
		t.Fatalf("failed to decode alias response: %v", err)
	}

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"`+createdAlias.ID+`","subject":"Hello","text_body":"Body","to":["recipient@example.com"]}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	relayReq := httptest.NewRequest(http.MethodPost, "/v1/submissions/"+created.ID+"/relay", nil)
	relayReq.Header.Set("Authorization", "Bearer token")
	relayRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(relayRec, relayReq)
	if relayRec.Code != http.StatusOK {
		t.Fatalf("expected relay status %d, got %d: %s", http.StatusOK, relayRec.Code, relayRec.Body.String())
	}

	var relayed model.Submission
	if err := json.Unmarshal(relayRec.Body.Bytes(), &relayed); err != nil {
		t.Fatalf("failed to decode relayed submission: %v", err)
	}
	if relayed.Status != model.SubmissionStatusRelayed {
		t.Fatalf("expected relayed submission status, got %+v", relayed)
	}
	if relayed.SourcePath != "submission_native_relay" {
		t.Fatalf("expected native relay source path, got %+v", relayed)
	}
	if relayed.RelayAttemptID == "" || relayed.RelayProvider != "record-only" {
		t.Fatalf("expected relay provenance to be recorded, got %+v", relayed)
	}

	events, err := server.audit.ListByTenant(context.Background(), actor.TenantID)
	if err != nil {
		t.Fatalf("ListByTenant() audit error = %v", err)
	}
	if len(events) < 3 {
		t.Fatalf("expected at least 3 audit events, got %+v", events)
	}
	foundAttemptAudit := false
	for _, event := range events {
		if event.EventType == "relay_attempt_created" && event.Metadata["submission_id"] == created.ID {
			foundAttemptAudit = true
			break
		}
	}
	if !foundAttemptAudit {
		t.Fatalf("expected relay_attempt_created audit for submission %s, got %+v", created.ID, events)
	}
}

func TestSubmissionRelayEndpointReturnsFailedSubmissionOnRelayError(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	failing := relay.NewServiceWithRepository(failingMailGateway{err: errors.New("smtp dial failed")}, "smtp", relay.NewMemoryRepository())
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, mail.NewRecordedGateway(), 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, auditService, identityvault.NewService(identityvault.NewMemoryRepository()), mail.NewRecordedGateway(), inboxStore, nil, 4096).
		WithRelayService(failing).
		WithIntakeAuthenticator(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"intake-token": actor}))

	createdAlias, err := aliasService.Create(context.Background(), actor, model.CreateAliasInput{Label: "support"})
	if err != nil {
		t.Fatalf("Create() alias error = %v", err)
	}
	created, err := submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: createdAlias.ID,
		To:        []string{"recipient@example.com"},
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}

	relayReq := httptest.NewRequest(http.MethodPost, "/v1/submissions/"+created.ID+"/relay", nil)
	relayReq.Header.Set("Authorization", "Bearer token")
	relayRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(relayRec, relayReq)
	if relayRec.Code != http.StatusOK {
		t.Fatalf("expected relay status %d, got %d: %s", http.StatusOK, relayRec.Code, relayRec.Body.String())
	}

	var failed model.Submission
	if err := json.Unmarshal(relayRec.Body.Bytes(), &failed); err != nil {
		t.Fatalf("failed to decode failed submission: %v", err)
	}
	if failed.Status != model.SubmissionStatusFailed {
		t.Fatalf("expected failed submission, got %+v", failed)
	}
	if failed.SourcePath != "submission_native_relay" {
		t.Fatalf("expected native relay source path, got %+v", failed)
	}
	if failed.RelayFailureDisposition != "terminal" {
		t.Fatalf("expected terminal relay failure disposition, got %+v", failed)
	}
}

func TestSubmissionsRejectInvalidJSON(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString("{"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid json status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionsRejectMissingChannelID(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"subject":"Hello","text_body":"Body"}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIntakeSubmissionsCreateSubmissionWithSeparateAuthenticator(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	request.Header.Set("Authorization", "Bearer intake-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, recorder.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}
	if created.SubmittedBy != actor.ID {
		t.Fatalf("expected submitted_by %s, got %s", actor.ID, created.SubmittedBy)
	}
	if created.IntakeChannel != "secure_web_intake" {
		t.Fatalf("expected secure_web_intake, got %s", created.IntakeChannel)
	}
	if created.MetadataProfile != "minimized" {
		t.Fatalf("expected minimized metadata profile, got %s", created.MetadataProfile)
	}
}

func TestIntakeSubmissionsStrictProfileBlocksUnsafeMetadata(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","sanitizer_profile":"strict","subject":"Hello","text_body":"Body","to":["recipient@example.com"],"attachments":[{"filename":"note.txt","content_type":"text/plain","size_bytes":4}]}`))
	request.Header.Set("Authorization", "Bearer intake-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, recorder.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}
	if created.Status != model.SubmissionStatusBlocked {
		t.Fatalf("expected blocked submission, got %s", created.Status)
	}
	if created.MetadataProfile != "minimized_strict" {
		t.Fatalf("expected minimized_strict metadata profile, got %s", created.MetadataProfile)
	}
}

func TestIntakeSubmissionsRejectInvalidSanitizerProfile(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","sanitizer_profile":"paranoid","subject":"Hello","text_body":"Body"}`))
	request.Header.Set("Authorization", "Bearer intake-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d with body %s", http.StatusBadRequest, recorder.Code, recorder.Body.String())
	}
}

func TestIntakeSubmissionsRejectWithoutIntakeAuthenticator(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), audit.NewService(audit.NewMemoryStore()))
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, nil, 4096)

	request := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	request.Header.Set("Authorization", "Bearer intake-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("expected intake not configured status %d, got %d", http.StatusNotImplemented, recorder.Code)
	}
}

func TestIntakeSubmissionDetailReturnsOwnedSubmission(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer intake-token")
	createReq.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRecorder, createReq)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, createRecorder.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/submissions/"+created.ID, nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected intake detail status %d, got %d", http.StatusOK, recorder.Code)
	}

	var stored model.Submission
	if err := json.Unmarshal(recorder.Body.Bytes(), &stored); err != nil {
		t.Fatalf("failed to decode intake detail response: %v", err)
	}
	if stored.ID != created.ID {
		t.Fatalf("expected submission %s, got %s", created.ID, stored.ID)
	}
	if stored.SubmittedBy != actor.ID {
		t.Fatalf("expected submitted_by %s, got %s", actor.ID, stored.SubmittedBy)
	}
}

func TestIntakeSubmissionDetailHidesOtherActorSubmission(t *testing.T) {
	owner := model.Actor{ID: "owner", TenantID: "tenant-1", PrimaryEmail: "owner@example.com"}
	other := model.Actor{ID: "other", TenantID: "tenant-1", PrimaryEmail: "other@example.com"}
	server := newTestServer(t, owner)
	server = server.WithIntakeAuthenticator(auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		"owner-token": owner,
		"other-token": other,
	}))

	createReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer owner-token")
	createReq.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRecorder, createReq)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, createRecorder.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/submissions/"+created.ID, nil)
	request.Header.Set("Authorization", "Bearer other-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected intake detail status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestIntakeSubmissionTimelineReturnsActorScopedView(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer intake-token")
	createReq.Header.Set("Content-Type", "application/json")
	createRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRecorder, createReq)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, createRecorder.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRecorder.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/submissions/"+created.ID+"/timeline", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected intake timeline status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary struct {
			LatestStatus    string `json:"latest_status"`
			AuditEventCount int    `json:"audit_event_count"`
		} `json:"summary"`
		Submission  model.Submission   `json:"submission"`
		AuditEvents []model.AuditEvent `json:"audit_events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode intake timeline response: %v", err)
	}
	if response.Submission.ID != created.ID {
		t.Fatalf("expected submission %s, got %s", created.ID, response.Submission.ID)
	}
	if response.Summary.LatestStatus != string(created.Status) {
		t.Fatalf("expected latest status %s, got %s", created.Status, response.Summary.LatestStatus)
	}
	if response.Summary.AuditEventCount < 1 {
		t.Fatalf("expected at least one audit event, got %d", response.Summary.AuditEventCount)
	}
	for _, event := range response.AuditEvents {
		if event.ActorID != "" && event.ActorID != actor.ID {
			t.Fatalf("expected intake timeline actor scope %s, got event actor %s", actor.ID, event.ActorID)
		}
	}
}

func TestIntakeTimelineFiltersByMetadataProfileAndDeliveryBoundary(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createStandard := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createStandard.Header.Set("Authorization", "Bearer intake-token")
	createStandard.Header.Set("Content-Type", "application/json")
	standardRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(standardRecorder, createStandard)
	if standardRecorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, standardRecorder.Code)
	}

	createStrict := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-2","sanitizer_profile":"strict","subject":"Hello","text_body":"Body","to":["recipient@example.com"]}`))
	createStrict.Header.Set("Authorization", "Bearer intake-token")
	createStrict.Header.Set("Content-Type", "application/json")
	strictRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(strictRecorder, createStrict)
	if strictRecorder.Code != http.StatusCreated {
		t.Fatalf("expected strict intake create status %d, got %d", http.StatusCreated, strictRecorder.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/timeline?metadata_profile=minimized_strict&delivery_boundary=internal_store_and_forward", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected intake timeline status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary struct {
			TotalEntries       int `json:"total_entries"`
			BlockedCount       int `json:"blocked_count"`
			StrictProfileCount int `json:"strict_profile_count"`
		} `json:"summary"`
		Entries []struct {
			ID               string `json:"id"`
			MetadataProfile  string `json:"metadata_profile"`
			DeliveryBoundary string `json:"delivery_boundary"`
			Status           string `json:"status"`
		} `json:"entries"`
		Showing int `json:"showing"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode intake timeline response: %v", err)
	}
	if response.Showing != 1 || len(response.Entries) != 1 {
		t.Fatalf("expected 1 filtered entry, got showing=%d len=%d", response.Showing, len(response.Entries))
	}
	if response.Entries[0].MetadataProfile != "minimized_strict" {
		t.Fatalf("expected minimized_strict profile, got %s", response.Entries[0].MetadataProfile)
	}
	if response.Entries[0].DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected internal_store_and_forward boundary, got %s", response.Entries[0].DeliveryBoundary)
	}
	if response.Entries[0].Status != string(model.SubmissionStatusBlocked) {
		t.Fatalf("expected blocked submission, got %s", response.Entries[0].Status)
	}
	if response.Summary.TotalEntries != 1 || response.Summary.BlockedCount != 1 || response.Summary.StrictProfileCount != 1 {
		t.Fatalf("unexpected intake summary %+v", response.Summary)
	}
}

func TestIntakeSubmissionQueueAndReleaseEndpoints(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer intake-token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected intake submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}

	queueReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions/"+created.ID+"/queue", nil)
	queueReq.Header.Set("Authorization", "Bearer intake-token")
	queueRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(queueRec, queueReq)
	if queueRec.Code != http.StatusOK {
		t.Fatalf("expected intake queue status %d, got %d", http.StatusOK, queueRec.Code)
	}

	var queued model.Submission
	if err := json.Unmarshal(queueRec.Body.Bytes(), &queued); err != nil {
		t.Fatalf("failed to decode queued intake submission: %v", err)
	}
	if queued.Status != model.SubmissionStatusQueued || queued.SourcePath != "intake_manual_queue" {
		t.Fatalf("unexpected queued intake submission %+v", queued)
	}

	releaseReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions/"+created.ID+"/release", nil)
	releaseReq.Header.Set("Authorization", "Bearer intake-token")
	releaseRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(releaseRec, releaseReq)
	if releaseRec.Code != http.StatusOK {
		t.Fatalf("expected intake release status %d, got %d", http.StatusOK, releaseRec.Code)
	}

	var released model.Submission
	if err := json.Unmarshal(releaseRec.Body.Bytes(), &released); err != nil {
		t.Fatalf("failed to decode released intake submission: %v", err)
	}
	if released.Status != model.SubmissionStatusSanitized || released.SourcePath != "intake_manual_release" {
		t.Fatalf("unexpected released intake submission %+v", released)
	}
}

func TestIntakeSubmissionRelayEndpointRelaysOwnedAliasSubmission(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createAliasReq := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createAliasReq.Header.Set("Authorization", "Bearer token")
	createAliasReq.Header.Set("Content-Type", "application/json")
	createAliasRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createAliasRec, createAliasReq)
	if createAliasRec.Code != http.StatusCreated {
		t.Fatalf("expected alias create status %d, got %d", http.StatusCreated, createAliasRec.Code)
	}

	var createdAlias model.Alias
	if err := json.Unmarshal(createAliasRec.Body.Bytes(), &createdAlias); err != nil {
		t.Fatalf("failed to decode alias response: %v", err)
	}

	createReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"`+createdAlias.ID+`","subject":"Hello","text_body":"Body","to":["recipient@example.com"]}`))
	createReq.Header.Set("Authorization", "Bearer intake-token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected intake submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}

	relayReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions/"+created.ID+"/relay", nil)
	relayReq.Header.Set("Authorization", "Bearer intake-token")
	relayRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(relayRec, relayReq)
	if relayRec.Code != http.StatusOK {
		t.Fatalf("expected intake relay status %d, got %d: %s", http.StatusOK, relayRec.Code, relayRec.Body.String())
	}

	var relayed model.Submission
	if err := json.Unmarshal(relayRec.Body.Bytes(), &relayed); err != nil {
		t.Fatalf("failed to decode relayed intake submission: %v", err)
	}
	if relayed.Status != model.SubmissionStatusRelayed || relayed.SourcePath != "intake_submission_relay" {
		t.Fatalf("unexpected relayed intake submission %+v", relayed)
	}
}

func TestIntakeSubmissionQueueRejectsForeignSubmission(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer intake-token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected intake submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode intake submission response: %v", err)
	}

	server = server.WithIntakeAuthenticator(auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		"intake-token": actor,
		"other-token":  {ID: "other-intake-user", TenantID: "tenant-1", PrimaryEmail: "other@example.com"},
	}))

	queueReq := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions/"+created.ID+"/queue", nil)
	queueReq.Header.Set("Authorization", "Bearer other-token")
	queueRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(queueRec, queueReq)

	if queueRec.Code != http.StatusNotFound {
		t.Fatalf("expected intake queue foreign status %d, got %d", http.StatusNotFound, queueRec.Code)
	}
}

func TestIntakeDashboardReturnsSummaryAndRecentProblemViews(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createAccepted := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createAccepted.Header.Set("Authorization", "Bearer intake-token")
	createAccepted.Header.Set("Content-Type", "application/json")
	acceptedRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(acceptedRecorder, createAccepted)
	if acceptedRecorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, acceptedRecorder.Code)
	}

	var accepted model.Submission
	if err := json.Unmarshal(acceptedRecorder.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("failed to decode accepted submission: %v", err)
	}

	if _, err := server.submissions.MarkRelayFailed(context.Background(), accepted.ID, "rly_1", "smtp", "intake_dashboard", "timeout", "retryable", "dial tcp timeout", time.Now().UTC()); err != nil {
		t.Fatalf("MarkRelayFailed() error = %v", err)
	}

	createBlocked := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-2","sanitizer_profile":"strict","subject":"Hello","text_body":"Body","to":["recipient@example.com"]}`))
	createBlocked.Header.Set("Authorization", "Bearer intake-token")
	createBlocked.Header.Set("Content-Type", "application/json")
	blockedRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(blockedRecorder, createBlocked)
	if blockedRecorder.Code != http.StatusCreated {
		t.Fatalf("expected strict intake create status %d, got %d", http.StatusCreated, blockedRecorder.Code)
	}

	var blocked model.Submission
	if err := json.Unmarshal(blockedRecorder.Body.Bytes(), &blocked); err != nil {
		t.Fatalf("failed to decode blocked submission: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/dashboard", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected intake dashboard status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary struct {
			TotalSubmissions   int `json:"total_submissions"`
			PendingSubmissions int `json:"pending_submissions"`
			FailedSubmissions  int `json:"failed_submissions"`
			BlockedSubmissions int `json:"blocked_submissions"`
		} `json:"summary"`
		StrictProfileCount int `json:"strict_profile_count"`
		ProblemSubmissions []struct {
			ID                      string                 `json:"id"`
			Status                  model.SubmissionStatus `json:"status"`
			RelayFailureDisposition string                 `json:"relay_failure_disposition"`
			AvailableActions        []string               `json:"available_actions"`
			ActionTargets           map[string]string      `json:"action_targets"`
		} `json:"problem_submissions"`
		RecentSubmissions []struct {
			ID               string                 `json:"id"`
			Status           model.SubmissionStatus `json:"status"`
			MetadataProfile  string                 `json:"metadata_profile"`
			DeliveryBoundary string                 `json:"delivery_boundary"`
			AvailableActions []string               `json:"available_actions"`
			ActionTargets    map[string]string      `json:"action_targets"`
		} `json:"recent_submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode intake dashboard response: %v", err)
	}
	if response.Summary.TotalSubmissions != 2 || response.Summary.FailedSubmissions != 1 || response.Summary.BlockedSubmissions != 1 || response.Summary.PendingSubmissions != 0 {
		t.Fatalf("unexpected intake dashboard summary %+v", response.Summary)
	}
	if response.StrictProfileCount != 1 {
		t.Fatalf("expected strict_profile_count=1, got %d", response.StrictProfileCount)
	}
	if len(response.ProblemSubmissions) != 2 {
		t.Fatalf("expected 2 problem submissions, got %+v", response.ProblemSubmissions)
	}
	if len(response.ProblemSubmissions[0].AvailableActions) == 0 || len(response.ProblemSubmissions[1].AvailableActions) == 0 {
		t.Fatalf("expected action hints on problem submissions, got %+v", response.ProblemSubmissions)
	}
	if response.ProblemSubmissions[0].ActionTargets["view_detail"] == "" || response.ProblemSubmissions[1].ActionTargets["view_timeline"] == "" {
		t.Fatalf("expected action targets on problem submissions, got %+v", response.ProblemSubmissions)
	}
	if len(response.RecentSubmissions) != 2 {
		t.Fatalf("expected 2 recent submissions, got %+v", response.RecentSubmissions)
	}
	if response.RecentSubmissions[0].ID != blocked.ID || response.RecentSubmissions[0].MetadataProfile != "minimized_strict" {
		t.Fatalf("expected blocked strict submission first in recent view, got %+v", response.RecentSubmissions[0])
	}
	if response.RecentSubmissions[1].ID != accepted.ID || response.RecentSubmissions[1].DeliveryBoundary != "internal_store_and_forward" {
		t.Fatalf("expected failed accepted submission second in recent view, got %+v", response.RecentSubmissions[1])
	}
	if len(response.RecentSubmissions[0].AvailableActions) == 0 || len(response.RecentSubmissions[1].AvailableActions) == 0 {
		t.Fatalf("expected action hints on recent submissions, got %+v", response.RecentSubmissions)
	}
	if response.RecentSubmissions[0].ActionTargets["view_detail"] == "" || response.RecentSubmissions[1].ActionTargets["view_timeline"] == "" {
		t.Fatalf("expected action targets on recent submissions, got %+v", response.RecentSubmissions)
	}
}

func TestIntakeDashboardSupportsMetadataProfileAndLimits(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	createStandard := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createStandard.Header.Set("Authorization", "Bearer intake-token")
	createStandard.Header.Set("Content-Type", "application/json")
	standardRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(standardRecorder, createStandard)
	if standardRecorder.Code != http.StatusCreated {
		t.Fatalf("expected intake create status %d, got %d", http.StatusCreated, standardRecorder.Code)
	}

	createStrict := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"channel-2","sanitizer_profile":"strict","subject":"Hello","text_body":"Body","to":["recipient@example.com"]}`))
	createStrict.Header.Set("Authorization", "Bearer intake-token")
	createStrict.Header.Set("Content-Type", "application/json")
	strictRecorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(strictRecorder, createStrict)
	if strictRecorder.Code != http.StatusCreated {
		t.Fatalf("expected strict intake create status %d, got %d", http.StatusCreated, strictRecorder.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/dashboard?metadata_profile=minimized_strict&problem_limit=1&recent_limit=1", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected intake dashboard status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary struct {
			TotalSubmissions   int `json:"total_submissions"`
			BlockedSubmissions int `json:"blocked_submissions"`
		} `json:"summary"`
		StrictProfileCount int `json:"strict_profile_count"`
		ProblemSubmissions []struct {
			MetadataProfile string `json:"metadata_profile"`
		} `json:"problem_submissions"`
		RecentSubmissions []struct {
			MetadataProfile string `json:"metadata_profile"`
		} `json:"recent_submissions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode intake dashboard response: %v", err)
	}
	if response.Summary.TotalSubmissions != 1 || response.Summary.BlockedSubmissions != 1 {
		t.Fatalf("unexpected filtered intake dashboard summary %+v", response.Summary)
	}
	if response.StrictProfileCount != 1 {
		t.Fatalf("expected strict_profile_count=1, got %d", response.StrictProfileCount)
	}
	if len(response.ProblemSubmissions) != 1 || response.ProblemSubmissions[0].MetadataProfile != "minimized_strict" {
		t.Fatalf("unexpected filtered problem submissions %+v", response.ProblemSubmissions)
	}
	if len(response.RecentSubmissions) != 1 || response.RecentSubmissions[0].MetadataProfile != "minimized_strict" {
		t.Fatalf("unexpected filtered recent submissions %+v", response.RecentSubmissions)
	}
}

func TestIntakeDashboardRejectsInvalidLimits(t *testing.T) {
	actor := model.Actor{ID: "intake-user", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodGet, "/v1/intake/dashboard?problem_limit=0", nil)
	request.Header.Set("Authorization", "Bearer intake-token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected intake dashboard status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionsRejectHTMLBody(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body","html_body":"<p>Body</p>"}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionsRejectInvalidChannelID(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString("{\"channel_id\":\"channel-1\\r\\nnext\",\"subject\":\"Hello\",\"text_body\":\"Body\"}"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionsRejectInvalidAttachmentMetadata(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	request := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body","attachments":[{"filename":"payload.exe","content_type":"application/octet-stream","size_bytes":-1}]}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionsRejectMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodDelete, "/v1/submissions", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestSubmissionsRequireAuthorization(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized status %d, got %d", http.StatusUnauthorized, recorder.Code)
	}
}

func TestSubmissionByIDReturnsNotFoundWhenMissing(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions/sub_missing", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestSubmissionByIDRejectsMethodNotAllowed(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	request := httptest.NewRequest(http.MethodDelete, "/v1/submissions/"+created.ID, nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestSubmissionsReturnNotImplementedWhenServiceMissing(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, nil, nil, nil, gateway, inboxStore, nil, 4096)

	request := httptest.NewRequest(http.MethodGet, "/v1/submissions", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, recorder.Code)
	}
}

func TestAuditEventsListReturnsTenantEvents(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, auditService, nil, gateway, inboxStore, nil, 4096)

	if _, err := auditService.Record(context.Background(), "tenant-1", "user-1", "submission_created", "sub_1", map[string]string{"status": "sanitized"}); err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	if _, err := auditService.Record(context.Background(), "tenant-2", "user-2", "submission_created", "sub_2", map[string]string{"status": "sanitized"}); err != nil {
		t.Fatalf("Record() cross-tenant error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode audit events response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 tenant audit event, got %d", len(response.Events))
	}
	if response.Events[0].TenantID != actor.TenantID {
		t.Fatalf("expected tenant %s, got %s", actor.TenantID, response.Events[0].TenantID)
	}
}

func TestAuditEventsApplyEventTypeAndLimitFilters(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, auditService, nil, gateway, inboxStore, nil, 4096)

	if _, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "submission_created", "sub_1", nil); err != nil {
		t.Fatalf("Record() submission_created error = %v", err)
	}
	if _, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "relay_sent", "rly_1", nil); err != nil {
		t.Fatalf("Record() relay_sent error = %v", err)
	}
	if _, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "submission_created", "sub_2", nil); err != nil {
		t.Fatalf("Record() second submission_created error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events?event_type=submission_created&limit=1", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode filtered audit events response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 filtered audit event, got %d", len(response.Events))
	}
	if response.Events[0].EventType != "submission_created" {
		t.Fatalf("expected submission_created event, got %s", response.Events[0].EventType)
	}
}

func TestAuditEventsApplyResourceIDFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, auditService, nil, gateway, inboxStore, nil, 4096)

	if _, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "submission_created", "sub_1", nil); err != nil {
		t.Fatalf("Record() submission_created error = %v", err)
	}
	if _, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "identity_link_revoked", "idl_1", map[string]string{"alias_id": "alias-1"}); err != nil {
		t.Fatalf("Record() identity_link_revoked error = %v", err)
	}
	if _, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "submission_created", "sub_2", nil); err != nil {
		t.Fatalf("Record() second submission_created error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events?resource_id=idl_1", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode filtered audit events response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 resource-filtered audit event, got %d", len(response.Events))
	}
	if response.Events[0].ResourceID != "idl_1" {
		t.Fatalf("expected resource_id idl_1, got %s", response.Events[0].ResourceID)
	}
}

func TestAuditEventsRejectInvalidLimit(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events?limit=0", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestAuditEventsApplySinceFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	auditService := audit.NewService(audit.NewMemoryStore())
	legacyEvent, err := auditService.Record(context.Background(), actor.TenantID, actor.ID, "submission_created", "sub_legacy", nil)
	if err != nil {
		t.Fatalf("failed to record legacy audit event: %v", err)
	}
	submissions := submission.NewWorkflowService(submission.NewMemoryRepository(), sanitizer.NewService(), auditService)
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, auditService, nil, gateway, inboxStore, nil, 4096)
	marker := legacyEvent.CreatedAt.Add(time.Nanosecond)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.Submission
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission response: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events?event_type=submission_created&since="+marker.Format(time.RFC3339Nano), nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode since-filtered audit events response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 event after since filter, got %d", len(response.Events))
	}
	if response.Events[0].ResourceID != created.ID {
		t.Fatalf("expected audit event for %s, got %s", created.ID, response.Events[0].ResourceID)
	}
}

func TestAuditEventsRejectInvalidSince(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events?since=not-a-timestamp", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestSubmissionCreateIsVisibleInAuditEvents(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected submission create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	auditReq := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	auditReq.Header.Set("Authorization", "Bearer token")
	auditRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(auditRec, auditReq)

	if auditRec.Code != http.StatusOK {
		t.Fatalf("expected audit status %d, got %d", http.StatusOK, auditRec.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(auditRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode audit events response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 audit event, got %d", len(response.Events))
	}
	if response.Events[0].EventType != "submission_created" {
		t.Fatalf("expected submission_created event, got %s", response.Events[0].EventType)
	}
}

func TestAuditEventsRequireAuthorization(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized status %d, got %d", http.StatusUnauthorized, recorder.Code)
	}
}

func TestAuditEventsRejectMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/audit-events", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestAuditEventsReturnNotImplementedWhenServiceMissing(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, nil, 4096)

	request := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, recorder.Code)
	}
}

func TestIdentityLinksListReturnsTenantLinks(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	identityService := identityvault.NewService(identityvault.NewMemoryRepository())
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, identityService, gateway, inboxStore, nil, 4096)

	if _, err := identityService.CreateLink(context.Background(), actor, "alias-1", "user@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() tenant-1 error = %v", err)
	}
	if _, err := identityService.CreateLink(context.Background(), model.Actor{ID: "user-2", TenantID: "tenant-2"}, "alias-2", "other@example.com", "support", time.Time{}); err != nil {
		t.Fatalf("CreateLink() tenant-2 error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/identity-links", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		IdentityLinks []model.IdentityLink `json:"identity_links"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode identity links response: %v", err)
	}
	if len(response.IdentityLinks) != 1 {
		t.Fatalf("expected 1 tenant identity link, got %d", len(response.IdentityLinks))
	}
	if response.IdentityLinks[0].TenantID != actor.TenantID {
		t.Fatalf("expected tenant %s, got %s", actor.TenantID, response.IdentityLinks[0].TenantID)
	}
}

func TestIdentityLinksListAppliesAliasIDFilter(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	for _, payload := range []string{
		`{"alias_id":"alias-1","real_identity_ref":"one@example.com","purpose":"support"}`,
		`{"alias_id":"alias-2","real_identity_ref":"two@example.com","purpose":"support"}`,
	} {
		createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(payload))
		createReq.Header.Set("Authorization", "Bearer token")
		createReq.Header.Set("Content-Type", "application/json")
		createRec := httptest.NewRecorder()
		server.Handler().ServeHTTP(createRec, createReq)

		if createRec.Code != http.StatusCreated {
			t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
		}
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/identity-links?alias_id=alias-2", nil)
	listReq.Header.Set("Authorization", "Bearer token")
	listRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d", http.StatusOK, listRec.Code)
	}

	var response struct {
		IdentityLinks []model.IdentityLink `json:"identity_links"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode identity links response: %v", err)
	}
	if len(response.IdentityLinks) != 1 {
		t.Fatalf("expected 1 filtered identity link, got %d", len(response.IdentityLinks))
	}
	if response.IdentityLinks[0].AliasID != "alias-2" {
		t.Fatalf("expected alias-2, got %s", response.IdentityLinks[0].AliasID)
	}
}

func TestIdentityLinksCreateAndListFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"User@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	var created model.IdentityLink
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode identity link response: %v", err)
	}
	if created.AliasID != "alias-1" {
		t.Fatalf("expected alias-1, got %s", created.AliasID)
	}
	if created.RealIdentityRef != "user@example.com" {
		t.Fatalf("expected normalized identity ref, got %s", created.RealIdentityRef)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/identity-links", nil)
	listReq.Header.Set("Authorization", "Bearer token")
	listRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d", http.StatusOK, listRec.Code)
	}

	var response struct {
		IdentityLinks []model.IdentityLink `json:"identity_links"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode identity links list response: %v", err)
	}
	if len(response.IdentityLinks) != 1 {
		t.Fatalf("expected 1 identity link, got %d", len(response.IdentityLinks))
	}
}

func TestIdentityLinksGetByAliasIDFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1/identity-links/alias-1", nil)
	getReq.Header.Set("Authorization", "Bearer token")
	getRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("expected get status %d, got %d", http.StatusOK, getRec.Code)
	}

	var fetched model.IdentityLink
	if err := json.Unmarshal(getRec.Body.Bytes(), &fetched); err != nil {
		t.Fatalf("failed to decode identity link detail response: %v", err)
	}
	if fetched.AliasID != "alias-1" {
		t.Fatalf("expected alias-1, got %s", fetched.AliasID)
	}
}

func TestIdentityLinksGetByAliasIDReturnsNotFoundWhenMissing(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/identity-links/alias-missing", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestIdentityLinksRevokeFlow(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	revokeReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", nil)
	revokeReq.Header.Set("Authorization", "Bearer token")
	revokeRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(revokeRec, revokeReq)

	if revokeRec.Code != http.StatusOK {
		t.Fatalf("expected revoke status %d, got %d", http.StatusOK, revokeRec.Code)
	}

	var revoked model.IdentityLink
	if err := json.Unmarshal(revokeRec.Body.Bytes(), &revoked); err != nil {
		t.Fatalf("failed to decode revoked identity link response: %v", err)
	}
	if revoked.RevokedAt.IsZero() {
		t.Fatal("expected revoked_at to be set")
	}

	getReq := httptest.NewRequest(http.MethodGet, "/v1/identity-links/alias-1", nil)
	getReq.Header.Set("Authorization", "Bearer token")
	getRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(getRec, getReq)

	if getRec.Code != http.StatusNotFound {
		t.Fatalf("expected get-after-revoke status %d, got %d", http.StatusNotFound, getRec.Code)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/identity-links", nil)
	listReq.Header.Set("Authorization", "Bearer token")
	listRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(listRec, listReq)

	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d", http.StatusOK, listRec.Code)
	}

	var response struct {
		IdentityLinks []model.IdentityLink `json:"identity_links"`
	}
	if err := json.Unmarshal(listRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode identity links response: %v", err)
	}
	if len(response.IdentityLinks) != 0 {
		t.Fatalf("expected 0 active identity links after revoke, got %d", len(response.IdentityLinks))
	}
}

func TestIdentityLinksRevokeWritesAuditEvent(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	revokeReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", nil)
	revokeReq.Header.Set("Authorization", "Bearer token")
	revokeRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(revokeRec, revokeReq)

	if revokeRec.Code != http.StatusOK {
		t.Fatalf("expected revoke status %d, got %d", http.StatusOK, revokeRec.Code)
	}

	auditReq := httptest.NewRequest(http.MethodGet, "/v1/audit-events?event_type=identity_link_revoked", nil)
	auditReq.Header.Set("Authorization", "Bearer token")
	auditRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(auditRec, auditReq)

	if auditRec.Code != http.StatusOK {
		t.Fatalf("expected audit status %d, got %d", http.StatusOK, auditRec.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(auditRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode audit response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 revoke audit event, got %d", len(response.Events))
	}
	if response.Events[0].EventType != "identity_link_revoked" {
		t.Fatalf("expected identity_link_revoked, got %s", response.Events[0].EventType)
	}
}

func TestIdentityLinksRevokeWritesAuditReason(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	revokeReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", bytes.NewBufferString(`{"reason":"operator_request"}`))
	revokeReq.Header.Set("Authorization", "Bearer token")
	revokeReq.Header.Set("Content-Type", "application/json")
	revokeRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(revokeRec, revokeReq)

	if revokeRec.Code != http.StatusOK {
		t.Fatalf("expected revoke status %d, got %d", http.StatusOK, revokeRec.Code)
	}

	auditReq := httptest.NewRequest(http.MethodGet, "/v1/audit-events?event_type=identity_link_revoked", nil)
	auditReq.Header.Set("Authorization", "Bearer token")
	auditRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(auditRec, auditReq)

	if auditRec.Code != http.StatusOK {
		t.Fatalf("expected audit status %d, got %d", http.StatusOK, auditRec.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(auditRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode audit response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 revoke audit event, got %d", len(response.Events))
	}
	if response.Events[0].Metadata["reason"] != "operator_request" {
		t.Fatalf("expected revoke reason to be recorded, got %q", response.Events[0].Metadata["reason"])
	}
}

func TestIdentityLinksRevokeReturnsNotFoundWhenMissing(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-missing/revoke", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestIdentityLinksRevokeReturnsConflictWhenAlreadyRevoked(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	firstRevokeReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", nil)
	firstRevokeReq.Header.Set("Authorization", "Bearer token")
	firstRevokeRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(firstRevokeRec, firstRevokeReq)

	if firstRevokeRec.Code != http.StatusOK {
		t.Fatalf("expected first revoke status %d, got %d", http.StatusOK, firstRevokeRec.Code)
	}

	secondRevokeReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", nil)
	secondRevokeReq.Header.Set("Authorization", "Bearer token")
	secondRevokeRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(secondRevokeRec, secondRevokeReq)

	if secondRevokeRec.Code != http.StatusConflict {
		t.Fatalf("expected second revoke status %d, got %d", http.StatusConflict, secondRevokeRec.Code)
	}
}

func TestIdentityLinksRevokeRejectsInvalidJSON(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", bytes.NewBufferString("{"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid json status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIdentityLinksRevokeRejectsInvalidReason(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/identity-links/alias-1/revoke", bytes.NewBufferString("{\"reason\":\"bad\\nreason\"}"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIdentityLinksCreateWritesAuditEvent(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createReq := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","purpose":"support"}`))
	createReq.Header.Set("Authorization", "Bearer token")
	createReq.Header.Set("Content-Type", "application/json")
	createRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(createRec, createReq)

	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d", http.StatusCreated, createRec.Code)
	}

	auditReq := httptest.NewRequest(http.MethodGet, "/v1/audit-events?event_type=identity_link_created", nil)
	auditReq.Header.Set("Authorization", "Bearer token")
	auditRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(auditRec, auditReq)

	if auditRec.Code != http.StatusOK {
		t.Fatalf("expected audit status %d, got %d", http.StatusOK, auditRec.Code)
	}

	var response struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(auditRec.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode audit response: %v", err)
	}
	if len(response.Events) != 1 {
		t.Fatalf("expected 1 identity-link audit event, got %d", len(response.Events))
	}
	if response.Events[0].EventType != "identity_link_created" {
		t.Fatalf("expected identity_link_created, got %s", response.Events[0].EventType)
	}
}

func TestIdentityLinksCreateRejectsInvalidJSON(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString("{"))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid json status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIdentityLinksCreateRejectsMissingAliasID(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"real_identity_ref":"user@example.com"}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIdentityLinksCreateRejectsInvalidIdentityRef(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/identity-links", bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"not-an-email"}`))
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIdentityLinksCreateRejectsPastExpiry(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/identity-links",
		bytes.NewBufferString(`{"alias_id":"alias-1","real_identity_ref":"user@example.com","expires_at":"2000-01-01T00:00:00Z"}`),
	)
	request.Header.Set("Authorization", "Bearer token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status %d, got %d", http.StatusBadRequest, recorder.Code)
	}
}

func TestIdentityLinksRequireAuthorization(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/identity-links", nil)
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized status %d, got %d", http.StatusUnauthorized, recorder.Code)
	}
}

func TestIdentityLinksRejectMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodDelete, "/v1/identity-links", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestIdentityLinkByAliasIDRejectsMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodDelete, "/v1/identity-links/alias-1", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestIdentityLinkRevokeRejectsMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodDelete, "/v1/identity-links/alias-1/revoke", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

func TestIdentityLinksReturnNotImplementedWhenServiceMissing(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, _ := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, nil, 4096)

	request := httptest.NewRequest(http.MethodGet, "/v1/identity-links", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("expected status %d, got %d", http.StatusNotImplemented, recorder.Code)
	}
}

func TestInboxReturnsMessagesForActor(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, err := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := inboxStore.Save(context.Background(), model.InboxMessage{
		ID:         "in_1",
		UserID:     actor.ID,
		TenantID:   actor.TenantID,
		AliasEmail: "support@relay.example",
		From:       "sender@example.com",
		To:         []string{"support@relay.example"},
		Subject:    "hello",
		TextBody:   "body",
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, nil, 4096)

	request := httptest.NewRequest(http.MethodGet, "/v1/messages/inbox", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected inbox status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Messages []model.InboxMessage `json:"messages"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode inbox response: %v", err)
	}
	if len(response.Messages) != 1 {
		t.Fatalf("expected 1 inbox message, got %d", len(response.Messages))
	}
}

func TestInboxTimelineReturnsLinkedSubmissionContext(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	createdSubmission, err := server.submissions.CreateFromPublicAPI(context.Background(), actor, model.CreateSubmissionInput{
		ChannelID: "al_1",
		To:        []string{"sender@example.com"},
		Subject:   "Hello",
		TextBody:  "Body",
	})
	if err != nil {
		t.Fatalf("CreateFromPublicAPI() error = %v", err)
	}
	if _, err := server.relay.RecordFailure(context.Background(), createdSubmission.ID, model.SanitizedMessage{
		Actor: actor,
		Alias: model.Alias{ID: "al_1", Email: "support@relay.example"},
		To:    []string{"sender@example.com"},
	}, "timeout", "retryable", "dial tcp timeout"); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}
	if _, err := server.audit.Record(context.Background(), actor.TenantID, actor.ID, "relay_attempt_created", "rly_manual", map[string]string{
		"submission_id": createdSubmission.ID,
	}); err != nil {
		t.Fatalf("Record() relay audit error = %v", err)
	}
	if _, err := server.inboxStore.Save(context.Background(), model.InboxMessage{
		ID:           "imap_1",
		UserID:       actor.ID,
		TenantID:     actor.TenantID,
		AliasEmail:   "support@relay.example",
		AliasID:      "al_1",
		SubmissionID: createdSubmission.ID,
		From:         "sender@example.com",
		To:           []string{"support@relay.example"},
		Subject:      "Re: Hello",
		TextBody:     "reply body",
		ReceivedAt:   time.Date(2026, 4, 3, 12, 10, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/messages/inbox/imap_1/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected inbox timeline status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary       map[string]any       `json:"summary"`
		Message       model.InboxMessage   `json:"message"`
		Submission    *model.Submission    `json:"submission"`
		RelayAttempts []model.RelayAttempt `json:"relay_attempts"`
		AuditEvents   []model.AuditEvent   `json:"audit_events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode inbox timeline response: %v", err)
	}
	if response.Message.ID != "imap_1" {
		t.Fatalf("expected message imap_1, got %s", response.Message.ID)
	}
	if response.Submission == nil || response.Submission.ID != createdSubmission.ID {
		t.Fatalf("expected linked submission %s, got %+v", createdSubmission.ID, response.Submission)
	}
	if len(response.RelayAttempts) != 1 {
		t.Fatalf("expected 1 relay attempt, got %d", len(response.RelayAttempts))
	}
	if len(response.AuditEvents) != 2 {
		t.Fatalf("expected 2 audit events, got %d", len(response.AuditEvents))
	}
	if response.Summary["has_submission_link"] != true {
		t.Fatalf("expected has_submission_link=true, got %+v", response.Summary)
	}
	if response.Summary["latest_status"] != string(createdSubmission.Status) && response.Summary["latest_status"] != createdSubmission.Status {
		t.Fatalf("expected latest_status to reflect linked submission status, got %+v", response.Summary)
	}
}

func TestInboxTimelineReturnsMessageOnlyWhenUnlinked(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	server := newTestServer(t, actor)

	if _, err := server.inboxStore.Save(context.Background(), model.InboxMessage{
		ID:         "imap_2",
		UserID:     actor.ID,
		TenantID:   actor.TenantID,
		AliasEmail: "support@relay.example",
		From:       "sender@example.com",
		To:         []string{"support@relay.example"},
		Subject:    "hello",
		TextBody:   "body",
		ReceivedAt: time.Date(2026, 4, 3, 12, 10, 0, 0, time.UTC),
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/messages/inbox/imap_2/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected inbox timeline status %d, got %d", http.StatusOK, recorder.Code)
	}

	var response struct {
		Summary       map[string]any       `json:"summary"`
		Message       model.InboxMessage   `json:"message"`
		Submission    *model.Submission    `json:"submission"`
		RelayAttempts []model.RelayAttempt `json:"relay_attempts"`
		AuditEvents   []model.AuditEvent   `json:"audit_events"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode inbox timeline response: %v", err)
	}
	if response.Submission != nil {
		t.Fatalf("expected nil submission, got %+v", response.Submission)
	}
	if len(response.RelayAttempts) != 0 || len(response.AuditEvents) != 0 {
		t.Fatalf("expected no linked records, got relay=%d audit=%d", len(response.RelayAttempts), len(response.AuditEvents))
	}
	if response.Summary["has_submission_link"] != false {
		t.Fatalf("expected has_submission_link=false, got %+v", response.Summary)
	}
}

func TestInboxTimelineReturnsNotFoundWhenMissing(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodGet, "/v1/messages/inbox/imap_missing/timeline", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, recorder.Code)
	}
}

func TestInboxSyncReturnsNotImplementedWhenAdapterMissing(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, err := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, nil, 4096)

	request := httptest.NewRequest(http.MethodPost, "/v1/messages/inbox/sync", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("expected sync status %d, got %d", http.StatusNotImplemented, recorder.Code)
	}
}

func TestInboxReturnsEmptyListWhenStoreMissing(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, nil, nil, 4096)

	request := httptest.NewRequest(http.MethodGet, "/v1/messages/inbox", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected inbox status %d, got %d", http.StatusOK, recorder.Code)
	}
}

type stubSyncer struct {
	count int
	err   error
}

func (s stubSyncer) Sync(_ context.Context, _ model.Actor) (int, error) {
	return s.count, s.err
}

func TestInboxSyncReturnsAcceptedWhenSyncerPresent(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, err := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, stubSyncer{count: 3}, 4096)

	request := httptest.NewRequest(http.MethodPost, "/v1/messages/inbox/sync", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusAccepted {
		t.Fatalf("expected sync status %d, got %d", http.StatusAccepted, recorder.Code)
	}
}

func TestInboxSyncReturnsServerErrorWhenSyncerFails(t *testing.T) {
	actor := model.Actor{ID: "user-1", TenantID: "tenant-1"}
	aliasService := alias.NewService(alias.NewMemoryRepository(), "relay.example")
	gateway := mail.NewRecordedGateway()
	inboxStore, err := inbox.NewStore(filepath.Join(t.TempDir(), "inbox.json"))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	submissionPolicy := policy.NewService(aliasService, gateway, 10, 4096)
	submissions := submission.NewService(submission.NewMemoryRepository())
	server := NewServer(auth.NewStaticTokenAuthenticator(map[string]model.Actor{"token": actor}), aliasService, submissionPolicy, submissions, nil, nil, gateway, inboxStore, stubSyncer{err: errors.New("sync failed")}, 4096)

	request := httptest.NewRequest(http.MethodPost, "/v1/messages/inbox/sync", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("expected sync status %d, got %d", http.StatusInternalServerError, recorder.Code)
	}

	var response map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to decode error response: %v", err)
	}
	if response["error"] != "internal server error" {
		t.Fatalf("expected generic internal error body, got %+v", response)
	}
}

func TestInboxRejectsMethodNotAllowed(t *testing.T) {
	server := newTestServer(t, model.Actor{ID: "user-1", TenantID: "tenant-1"})

	request := httptest.NewRequest(http.MethodPost, "/v1/messages/inbox", nil)
	request.Header.Set("Authorization", "Bearer token")
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, recorder.Code)
	}
}

type failingMailGateway struct {
	err error
}

func (g failingMailGateway) Send(_ context.Context, _ model.SanitizedMessage) (model.MessageRecord, error) {
	return model.MessageRecord{}, g.err
}

func (g failingMailGateway) ListByActor(_ context.Context, _ model.Actor) ([]model.MessageRecord, error) {
	return nil, nil
}

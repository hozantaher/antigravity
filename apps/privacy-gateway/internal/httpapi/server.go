package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"privacy-gateway/internal/alias"
	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/auth"
	"privacy-gateway/internal/compat"
	"privacy-gateway/internal/identityvault"
	"privacy-gateway/internal/inbox"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/policy"
	"privacy-gateway/internal/relay"
	"privacy-gateway/internal/submission"
)

type Server struct {
	auth             auth.Authenticator
	intakeAuth       auth.Authenticator
	aliases          *alias.Service
	submission       *policy.Service
	submissions      *submission.Service
	relay            *relay.Service
	audit            *audit.Service
	identityVault    *identityvault.Service
	gateway          mail.Gateway
	inboxStore       *inbox.Store
	inboxSyncer      inbox.Syncer
	maxJSONBodyBytes int64
}

type revokeIdentityLinkInput struct {
	Reason string `json:"reason,omitempty"`
}

func NewServer(authenticator auth.Authenticator, aliases *alias.Service, submissionPolicy *policy.Service, submissions *submission.Service, auditService *audit.Service, identityVaultService *identityvault.Service, gateway mail.Gateway, inboxStore *inbox.Store, inboxSyncer inbox.Syncer, maxJSONBodyBytes int64) *Server {
	if maxJSONBodyBytes <= 0 {
		maxJSONBodyBytes = 256 * 1024
	}

	return &Server{
		auth:             authenticator,
		aliases:          aliases,
		submission:       submissionPolicy,
		submissions:      submissions,
		audit:            auditService,
		identityVault:    identityVaultService,
		gateway:          gateway,
		inboxStore:       inboxStore,
		inboxSyncer:      inboxSyncer,
		maxJSONBodyBytes: maxJSONBodyBytes,
	}
}

func (s *Server) WithRelayService(relayService *relay.Service) *Server {
	s.relay = relayService
	return s
}

func (s *Server) WithIntakeAuthenticator(authenticator auth.Authenticator) *Server {
	s.intakeAuth = authenticator
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/ui", s.handleUI)
	mux.HandleFunc("/v1/intake/submissions", s.handleIntakeSubmissions)
	mux.HandleFunc("/v1/intake/submissions/", s.handleIntakeSubmissionByID)
	mux.HandleFunc("/v1/intake/dashboard", s.handleIntakeDashboard)
	mux.HandleFunc("/v1/intake/queue", s.handleIntakeQueue)
	mux.HandleFunc("/v1/intake/status", s.handleIntakeStatus)
	mux.HandleFunc("/v1/intake/timeline", s.handleIntakeTimeline)
	mux.HandleFunc("/v1/dashboard", s.handleDashboard)
	mux.HandleFunc("/v1/aliases", s.handleAliases)
	mux.HandleFunc("/v1/aliases/", s.handleAliasByID)
	mux.HandleFunc("/v1/channels", s.handleChannels)
	mux.HandleFunc("/v1/relay-queue", s.handleRelayQueue)
	mux.HandleFunc("/v1/audit-events", s.handleAuditEvents)
	mux.HandleFunc("/v1/identity-links", s.handleIdentityLinks)
	mux.HandleFunc("/v1/identity-links/", s.handleIdentityLinkByAliasID)
	mux.HandleFunc("/v1/submissions", s.handleSubmissions)
	mux.HandleFunc("/v1/submissions/", s.handleSubmissionByID)
	mux.HandleFunc("/v1/relay-attempts", s.handleRelayAttempts)
	mux.HandleFunc("/v1/relay-attempts/", s.handleRelayAttemptByID)
	mux.HandleFunc("/v1/messages", s.handleMessages)
	mux.HandleFunc("/v1/messages/outbox", s.handleOutbox)
	mux.HandleFunc("/v1/messages/inbox", s.handleInbox)
	mux.HandleFunc("/v1/messages/inbox/", s.handleInboxByID)
	mux.HandleFunc("/v1/messages/inbox/sync", s.handleInboxSync)
	return mux
}

func (s *Server) handleRelayAttempts(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.relay == nil {
		writeError(w, http.StatusNotImplemented, "relay service is not configured")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	if statusFilter != "" && statusFilter != "sent" && statusFilter != "failed" {
		writeError(w, http.StatusBadRequest, "status must be one of sent or failed")
		return
	}
	submissionIDFilter := strings.TrimSpace(r.URL.Query().Get("submission_id"))
	limit := 0
	if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}

	filtered := make([]model.RelayAttempt, 0, len(attempts))
	for _, attempt := range attempts {
		if statusFilter != "" && attempt.Status != statusFilter {
			continue
		}
		if submissionIDFilter != "" && attempt.SubmissionID != submissionIDFilter {
			continue
		}
		filtered = append(filtered, attempt)
	}
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary":        buildRelayAttemptSummary(filtered),
		"relay_attempts": filtered,
	})
}

func (s *Server) handleRelayAttemptByID(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.relay == nil {
		writeError(w, http.StatusNotImplemented, "relay service is not configured")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/v1/relay-attempts/"))
	if id == "" {
		writeError(w, http.StatusNotFound, "relay attempt not found")
		return
	}
	attempt, err := s.relay.GetAttemptByID(r.Context(), actor, id)
	if err != nil {
		if errors.Is(err, relay.ErrRelayAttemptNotFound) {
			writeError(w, http.StatusNotFound, "relay attempt not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, attempt)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleIntakeSubmissions(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireIntakeActor(w, r)
	if !ok {
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var input model.CreateSubmissionInput
	if !s.decodeJSONBody(w, r, &input) {
		return
	}
	created, err := s.submissions.CreateFromPublicAPI(r.Context(), actor, input)
	if err != nil {
		switch {
		case errors.Is(err, submission.ErrChannelRequired),
			errors.Is(err, submission.ErrInvalidChannelID),
			errors.Is(err, submission.ErrEmptyBody),
			errors.Is(err, submission.ErrHTMLNotSupported),
			errors.Is(err, submission.ErrInvalidSanitizerProfile),
			errors.Is(err, submission.ErrInvalidRecipient),
			errors.Is(err, submission.ErrTooManyRecipients),
			errors.Is(err, submission.ErrInvalidSubject),
			errors.Is(err, submission.ErrTooManyAttachments),
			errors.Is(err, submission.ErrInvalidAttachment):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	writeJSON(w, http.StatusCreated, created)
}

type intakeStatusResponse struct {
	TotalSubmissions   int       `json:"total_submissions"`
	PendingSubmissions int       `json:"pending_submissions"`
	RelayedSubmissions int       `json:"relayed_submissions"`
	FailedSubmissions  int       `json:"failed_submissions"`
	BlockedSubmissions int       `json:"blocked_submissions"`
	LatestSubmissionAt time.Time `json:"latest_submission_at,omitempty"`
	LatestRelayedAt    time.Time `json:"latest_relayed_at,omitempty"`
}

type intakeDashboardSubmission struct {
	ID                      string                 `json:"id"`
	Status                  model.SubmissionStatus `json:"status"`
	ChannelID               string                 `json:"channel_id"`
	MetadataProfile         string                 `json:"metadata_profile,omitempty"`
	DeliveryBoundary        string                 `json:"delivery_boundary,omitempty"`
	RelayFailureClass       string                 `json:"relay_failure_class,omitempty"`
	RelayFailureDisposition string                 `json:"relay_failure_disposition,omitempty"`
	AvailableActions        []string               `json:"available_actions,omitempty"`
	ActionTargets           map[string]string      `json:"action_targets,omitempty"`
	CreatedAt               time.Time              `json:"created_at"`
}

func (s *Server) handleIntakeDashboard(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireIntakeActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}
	metadataProfileFilter := strings.TrimSpace(r.URL.Query().Get("metadata_profile"))
	problemLimit := 5
	if raw := strings.TrimSpace(r.URL.Query().Get("problem_limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "problem_limit must be a positive integer")
			return
		}
		problemLimit = parsed
	}
	recentLimit := 5
	if raw := strings.TrimSpace(r.URL.Query().Get("recent_limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "recent_limit must be a positive integer")
			return
		}
		recentLimit = parsed
	}

	subs, err := s.submissions.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	status := intakeStatusResponse{}
	strictProfileCount := 0
	records := make([]model.Submission, 0, len(subs))
	for _, sub := range subs {
		if metadataProfileFilter != "" && sub.MetadataProfile != metadataProfileFilter {
			continue
		}
		status.TotalSubmissions++
		records = append(records, sub)
		if sub.MetadataProfile == "minimized_strict" {
			strictProfileCount++
		}
		switch sub.Status {
		case model.SubmissionStatusRelayed:
			status.RelayedSubmissions++
			if sub.RelayedAt.After(status.LatestRelayedAt) {
				status.LatestRelayedAt = sub.RelayedAt
			}
		case model.SubmissionStatusFailed:
			status.FailedSubmissions++
		case model.SubmissionStatusBlocked:
			status.BlockedSubmissions++
		default:
			status.PendingSubmissions++
		}
		if sub.CreatedAt.After(status.LatestSubmissionAt) {
			status.LatestSubmissionAt = sub.CreatedAt
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary":              status,
		"strict_profile_count": strictProfileCount,
		"problem_submissions":  buildIntakeProblemSubmissions(records, problemLimit),
		"recent_submissions":   buildIntakeRecentSubmissions(records, recentLimit),
	})
}

func (s *Server) handleIntakeQueue(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireIntakeActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.submissions == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"summary": map[string]any{
				"queue_count":            0,
				"retryable_failed_count": 0,
				"strict_profile_count":   0,
			},
			"submissions": []intakeDashboardSubmission{},
		})
		return
	}
	metadataProfileFilter := strings.TrimSpace(r.URL.Query().Get("metadata_profile"))
	var retryableOnly *bool
	if raw := strings.TrimSpace(r.URL.Query().Get("retryable_only")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "retryable_only must be a boolean")
			return
		}
		retryableOnly = &parsed
	}
	limit := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}

	records, err := s.submissions.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	queued := make([]model.Submission, 0, len(records))
	retryableFailedCount := 0
	strictProfileCount := 0
	for _, item := range records {
		if !isRelayQueueCandidate(item) {
			continue
		}
		if metadataProfileFilter != "" && item.MetadataProfile != metadataProfileFilter {
			continue
		}
		isRetryableFailed := item.Status == model.SubmissionStatusFailed && item.RelayFailureDisposition == "retryable"
		if retryableOnly != nil && *retryableOnly && !isRetryableFailed {
			continue
		}
		if item.Status == model.SubmissionStatusFailed && item.RelayFailureDisposition == "retryable" {
			retryableFailedCount++
		}
		if item.MetadataProfile == "minimized_strict" {
			strictProfileCount++
		}
		queued = append(queued, item)
	}
	if limit > 0 && len(queued) > limit {
		queued = queued[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary": map[string]any{
			"queue_count":            len(queued),
			"retryable_failed_count": retryableFailedCount,
			"strict_profile_count":   strictProfileCount,
		},
		"submissions": toIntakeDashboardSubmissions(queued),
	})
}

func (s *Server) handleIntakeStatus(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireIntakeActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}

	subs, err := s.submissions.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	status := intakeStatusResponse{}
	for _, sub := range subs {
		status.TotalSubmissions++
		switch sub.Status {
		case model.SubmissionStatusRelayed:
			status.RelayedSubmissions++
			if sub.RelayedAt.After(status.LatestRelayedAt) {
				status.LatestRelayedAt = sub.RelayedAt
			}
		case model.SubmissionStatusFailed:
			status.FailedSubmissions++
		case model.SubmissionStatusBlocked:
			status.BlockedSubmissions++
		default:
			status.PendingSubmissions++
		}
		if sub.CreatedAt.After(status.LatestSubmissionAt) {
			status.LatestSubmissionAt = sub.CreatedAt
		}
	}

	writeJSON(w, http.StatusOK, status)
}

type intakeTimelineEntry struct {
	ID                string    `json:"id"`
	Status            string    `json:"status"`
	IntakeChannel     string    `json:"intake_channel,omitempty"`
	MetadataProfile   string    `json:"metadata_profile,omitempty"`
	ContentProtection string    `json:"content_protection,omitempty"`
	DeliveryBoundary  string    `json:"delivery_boundary,omitempty"`
	To                []string  `json:"to,omitempty"`
	Subject           string    `json:"subject,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	RelayedAt         time.Time `json:"relayed_at,omitempty"`
	FailedAt          time.Time `json:"failed_at,omitempty"`
	RelayProvider     string    `json:"relay_provider,omitempty"`
	FailureClass      string    `json:"failure_class,omitempty"`
}

func (s *Server) handleIntakeTimeline(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireIntakeActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}

	subs, err := s.submissions.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Apply optional filters
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	channelFilter := strings.TrimSpace(r.URL.Query().Get("channel"))
	metadataProfileFilter := strings.TrimSpace(r.URL.Query().Get("metadata_profile"))
	deliveryBoundaryFilter := strings.TrimSpace(r.URL.Query().Get("delivery_boundary"))
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}

	entries := make([]intakeTimelineEntry, 0, len(subs))
	summary := map[string]any{
		"total_entries":        0,
		"blocked_count":        0,
		"failed_count":         0,
		"relayed_count":        0,
		"strict_profile_count": 0,
	}
	for _, sub := range subs {
		if statusFilter != "" && sub.Status != model.SubmissionStatus(statusFilter) {
			continue
		}
		if channelFilter != "" && sub.IntakeChannel != channelFilter {
			continue
		}
		if metadataProfileFilter != "" && sub.MetadataProfile != metadataProfileFilter {
			continue
		}
		if deliveryBoundaryFilter != "" && sub.DeliveryBoundary != deliveryBoundaryFilter {
			continue
		}
		summary["total_entries"] = summary["total_entries"].(int) + 1
		switch sub.Status {
		case model.SubmissionStatusBlocked:
			summary["blocked_count"] = summary["blocked_count"].(int) + 1
		case model.SubmissionStatusFailed:
			summary["failed_count"] = summary["failed_count"].(int) + 1
		case model.SubmissionStatusRelayed:
			summary["relayed_count"] = summary["relayed_count"].(int) + 1
		}
		if sub.MetadataProfile == "minimized_strict" {
			summary["strict_profile_count"] = summary["strict_profile_count"].(int) + 1
		}
		entries = append(entries, intakeTimelineEntry{
			ID:                sub.ID,
			Status:            string(sub.Status),
			IntakeChannel:     sub.IntakeChannel,
			MetadataProfile:   sub.MetadataProfile,
			ContentProtection: sub.ContentProtection,
			DeliveryBoundary:  sub.DeliveryBoundary,
			To:                sub.To,
			Subject:           sub.Subject,
			CreatedAt:         sub.CreatedAt,
			RelayedAt:         sub.RelayedAt,
			FailedAt:          sub.FailedAt,
			RelayProvider:     sub.RelayProvider,
			FailureClass:      sub.RelayFailureClass,
		})
		if len(entries) >= limit {
			break
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary": summary,
		"entries": entries,
		"total":   len(subs),
		"showing": len(entries),
	})
}

func buildIntakeProblemSubmissions(records []model.Submission, limit int) []intakeDashboardSubmission {
	items := make([]model.Submission, 0, len(records))
	for _, record := range records {
		if record.Status != model.SubmissionStatusFailed && record.Status != model.SubmissionStatusBlocked {
			continue
		}
		items = append(items, record)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return toIntakeDashboardSubmissions(items)
}

func buildIntakeRecentSubmissions(records []model.Submission, limit int) []intakeDashboardSubmission {
	items := append([]model.Submission(nil), records...)
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return toIntakeDashboardSubmissions(items)
}

func toIntakeDashboardSubmissions(records []model.Submission) []intakeDashboardSubmission {
	items := make([]intakeDashboardSubmission, 0, len(records))
	for _, record := range records {
		items = append(items, intakeDashboardSubmission{
			ID:                      record.ID,
			Status:                  record.Status,
			ChannelID:               record.ChannelID,
			MetadataProfile:         record.MetadataProfile,
			DeliveryBoundary:        record.DeliveryBoundary,
			RelayFailureClass:       record.RelayFailureClass,
			RelayFailureDisposition: record.RelayFailureDisposition,
			AvailableActions:        intakeAvailableActions(record),
			ActionTargets:           intakeActionTargets(record),
			CreatedAt:               record.CreatedAt,
		})
	}
	return items
}

func intakeAvailableActions(record model.Submission) []string {
	actions := []string{"view_detail", "view_timeline"}
	switch record.Status {
	case model.SubmissionStatusAccepted, model.SubmissionStatusSanitized:
		actions = append(actions, "queue_for_relay", "relay_now")
	case model.SubmissionStatusQueued:
		actions = append(actions, "release_to_relay", "relay_now")
	case model.SubmissionStatusFailed:
		if record.RelayFailureDisposition == "retryable" {
			actions = append(actions, "queue_for_relay", "relay_now")
		}
	case model.SubmissionStatusBlocked:
		actions = append(actions, "review_policy_block")
	}
	return actions
}

func intakeActionTargets(record model.Submission) map[string]string {
	base := "/v1/intake/submissions/" + record.ID
	targets := map[string]string{
		"view_detail":   base,
		"view_timeline": base + "/timeline",
	}
	switch record.Status {
	case model.SubmissionStatusAccepted, model.SubmissionStatusSanitized:
		targets["queue_for_relay"] = base + "/queue"
		targets["relay_now"] = base + "/relay"
	case model.SubmissionStatusQueued:
		targets["release_to_relay"] = base + "/release"
		targets["relay_now"] = base + "/relay"
	case model.SubmissionStatusFailed:
		if record.RelayFailureDisposition == "retryable" {
			targets["queue_for_relay"] = base + "/queue"
			targets["relay_now"] = base + "/relay"
		}
	}
	return targets
}

func (s *Server) handleIntakeSubmissionByID(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireIntakeActor(w, r)
	if !ok {
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/v1/intake/submissions/")
	if path == "" {
		writeError(w, http.StatusNotFound, "submission not found")
		return
	}
	if strings.HasSuffix(path, "/queue") {
		id := strings.TrimSuffix(path, "/queue")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if _, ok := s.getAccessibleIntakeSubmission(w, r, actor, id); !ok {
			return
		}
		record, err := s.submissions.QueueForRelay(r.Context(), id, "intake_manual_queue")
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrSubmissionNotFound):
				writeError(w, http.StatusNotFound, "submission not found")
			case errors.Is(err, submission.ErrCannotQueue):
				writeError(w, http.StatusConflict, "submission cannot be queued")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if strings.HasSuffix(path, "/release") {
		id := strings.TrimSuffix(path, "/release")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if _, ok := s.getAccessibleIntakeSubmission(w, r, actor, id); !ok {
			return
		}
		record, err := s.submissions.ReleaseToRelay(r.Context(), id, "intake_manual_release")
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrSubmissionNotFound):
				writeError(w, http.StatusNotFound, "submission not found")
			case errors.Is(err, submission.ErrCannotRelease):
				writeError(w, http.StatusConflict, "submission cannot be released")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if strings.HasSuffix(path, "/relay") {
		id := strings.TrimSuffix(path, "/relay")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if _, ok := s.getAccessibleIntakeSubmission(w, r, actor, id); !ok {
			return
		}
		record, err := s.relaySubmission(r.Context(), actor, id, "intake_submission_relay")
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrSubmissionNotFound):
				writeError(w, http.StatusNotFound, "submission not found")
			case errors.Is(err, alias.ErrAliasForbidden), errors.Is(err, alias.ErrAliasNotFound):
				writeError(w, http.StatusConflict, "submission channel is not relay-capable")
			case errors.Is(err, errSubmissionCannotRelay):
				writeError(w, http.StatusConflict, "submission cannot be relayed")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}

	if strings.HasSuffix(path, "/timeline") {
		id := strings.TrimSuffix(path, "/timeline")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleIntakeSubmissionTimeline(w, r, actor, id)
		return
	}

	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	record, ok := s.getAccessibleIntakeSubmission(w, r, actor, path)
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, record)
}

type channelSummary struct {
	Alias                    model.Alias `json:"alias"`
	SubmissionCount          int         `json:"submission_count"`
	InboxCount               int         `json:"inbox_count"`
	RelayAttemptCount        int         `json:"relay_attempt_count"`
	LatestSubmissionStatus   string      `json:"latest_submission_status,omitempty"`
	LatestInboundAt          time.Time   `json:"latest_inbound_at,omitempty"`
	LatestActivityAt         time.Time   `json:"latest_activity_at,omitempty"`
	LatestFailureClass       string      `json:"latest_failure_class,omitempty"`
	LatestFailureDisposition string      `json:"latest_failure_disposition,omitempty"`
}

type dashboardProblemChannel struct {
	Alias                    model.Alias `json:"alias"`
	LatestSubmissionStatus   string      `json:"latest_submission_status,omitempty"`
	LatestFailureClass       string      `json:"latest_failure_class,omitempty"`
	LatestFailureDisposition string      `json:"latest_failure_disposition,omitempty"`
	LatestActivityAt         time.Time   `json:"latest_activity_at,omitempty"`
}

type dashboardRecentSubmission struct {
	ID                      string                 `json:"id"`
	ChannelID               string                 `json:"channel_id"`
	SubmittedBy             string                 `json:"submitted_by,omitempty"`
	Status                  model.SubmissionStatus `json:"status"`
	MetadataProfile         string                 `json:"metadata_profile,omitempty"`
	DeliveryBoundary        string                 `json:"delivery_boundary,omitempty"`
	RelayFailureClass       string                 `json:"relay_failure_class,omitempty"`
	RelayFailureDisposition string                 `json:"relay_failure_disposition,omitempty"`
	CreatedAt               time.Time              `json:"created_at"`
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	problemOnly := false
	if raw := strings.TrimSpace(r.URL.Query().Get("problem_only")); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "problem_only must be a boolean")
			return
		}
		problemOnly = parsed
	}
	problemLimit := 5
	if raw := strings.TrimSpace(r.URL.Query().Get("problem_limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "problem_limit must be a positive integer")
			return
		}
		problemLimit = parsed
	}
	recentLimit := 5
	if raw := strings.TrimSpace(r.URL.Query().Get("recent_limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "recent_limit must be a positive integer")
			return
		}
		recentLimit = parsed
	}

	aliases, err := s.aliases.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	submissionsByAlias := map[string][]model.Submission{}
	submissionCount := 0
	failedSubmissionCount := 0
	submissionIDsByAlias := map[string]map[string]struct{}{}
	if s.submissions != nil {
		records, err := s.submissions.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		submissionCount = len(records)
		for _, item := range records {
			submissionsByAlias[item.ChannelID] = append(submissionsByAlias[item.ChannelID], item)
			if _, ok := submissionIDsByAlias[item.ChannelID]; !ok {
				submissionIDsByAlias[item.ChannelID] = map[string]struct{}{}
			}
			submissionIDsByAlias[item.ChannelID][item.ID] = struct{}{}
			if item.Status == model.SubmissionStatusFailed {
				failedSubmissionCount++
			}
		}
	}

	relayByAlias := map[string][]model.RelayAttempt{}
	relayAttemptCount := 0
	failedRelayAttemptCount := 0
	if s.relay != nil {
		attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		relayAttemptCount = len(attempts)
		for _, attempt := range attempts {
			if attempt.Status == "failed" {
				failedRelayAttemptCount++
			}
			if attempt.AliasID != "" {
				relayByAlias[attempt.AliasID] = append(relayByAlias[attempt.AliasID], attempt)
				continue
			}
			for aliasID, submissionIDs := range submissionIDsByAlias {
				if _, ok := submissionIDs[attempt.SubmissionID]; ok {
					relayByAlias[aliasID] = append(relayByAlias[aliasID], attempt)
				}
			}
		}
	}

	inboxByAlias := map[string][]model.InboxMessage{}
	inboxCount := 0
	if s.inboxStore != nil {
		messages, err := s.inboxStore.ListByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		inboxCount = len(messages)
		for _, item := range messages {
			key := item.AliasID
			if key == "" {
				key = strings.ToLower(strings.TrimSpace(item.AliasEmail))
			}
			inboxByAlias[key] = append(inboxByAlias[key], item)
		}
	}

	activeIdentityLinkCount := 0
	if s.identityVault != nil {
		links, err := s.identityVault.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		activeIdentityLinkCount = len(links)
	}

	auditEventCount := 0
	auditEvents := []model.AuditEvent(nil)
	if s.audit != nil {
		events, err := s.audit.ListByTenantFiltered(r.Context(), actor.TenantID, audit.ListOptions{})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		auditEvents = events
		auditEventCount = len(events)
	}

	channels := buildChannelSummaries(aliases, submissionsByAlias, relayByAlias, inboxByAlias)
	problemChannels := buildDashboardProblemChannels(channels, problemLimit)
	recentSubmissions := buildDashboardRecentSubmissions(submissionsByAlias, recentLimit)
	if problemOnly {
		channels = buildProblemOnlyChannelSummaries(channels)
	}
	summary := map[string]any{
		"alias_count":                len(aliases),
		"channel_count":              len(channels),
		"submission_count":           submissionCount,
		"failed_submission_count":    failedSubmissionCount,
		"inbox_count":                inboxCount,
		"relay_attempt_count":        relayAttemptCount,
		"failed_relay_attempt_count": failedRelayAttemptCount,
		"active_identity_link_count": activeIdentityLinkCount,
		"audit_event_count":          auditEventCount,
		"problem_channel_count":      len(problemChannels),
	}
	if latestActivityAt, ok := latestDashboardActivityAt(aliases, channels, auditEvents); ok {
		summary["latest_activity_at"] = latestActivityAt.UTC()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary":            summary,
		"channels":           channels,
		"problem_channels":   problemChannels,
		"recent_submissions": recentSubmissions,
	})
}

func buildDashboardProblemChannels(channels []channelSummary, limit int) []dashboardProblemChannel {
	items := make([]dashboardProblemChannel, 0, len(channels))
	for _, channel := range channels {
		if channel.LatestSubmissionStatus != string(model.SubmissionStatusFailed) &&
			channel.LatestSubmissionStatus != string(model.SubmissionStatusBlocked) &&
			channel.LatestFailureDisposition != "retryable" &&
			channel.LatestFailureDisposition != "terminal" {
			continue
		}
		items = append(items, dashboardProblemChannel{
			Alias:                    channel.Alias,
			LatestSubmissionStatus:   channel.LatestSubmissionStatus,
			LatestFailureClass:       channel.LatestFailureClass,
			LatestFailureDisposition: channel.LatestFailureDisposition,
			LatestActivityAt:         channel.LatestActivityAt,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].LatestActivityAt.Equal(items[j].LatestActivityAt) {
			return items[i].Alias.ID < items[j].Alias.ID
		}
		return items[i].LatestActivityAt.After(items[j].LatestActivityAt)
	})

	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items
}

func buildProblemOnlyChannelSummaries(channels []channelSummary) []channelSummary {
	items := make([]channelSummary, 0, len(channels))
	for _, channel := range channels {
		if channel.LatestSubmissionStatus != string(model.SubmissionStatusFailed) &&
			channel.LatestSubmissionStatus != string(model.SubmissionStatusBlocked) &&
			channel.LatestFailureDisposition != "retryable" &&
			channel.LatestFailureDisposition != "terminal" {
			continue
		}
		items = append(items, channel)
	}
	return items
}

func buildDashboardRecentSubmissions(submissionsByAlias map[string][]model.Submission, limit int) []dashboardRecentSubmission {
	records := make([]model.Submission, 0)
	for _, submissions := range submissionsByAlias {
		records = append(records, submissions...)
	}

	sort.Slice(records, func(i, j int) bool {
		if records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].ID < records[j].ID
		}
		return records[i].CreatedAt.After(records[j].CreatedAt)
	})

	if limit > 0 && len(records) > limit {
		records = records[:limit]
	}

	items := make([]dashboardRecentSubmission, 0, len(records))
	for _, record := range records {
		items = append(items, dashboardRecentSubmission{
			ID:                      record.ID,
			ChannelID:               record.ChannelID,
			SubmittedBy:             record.SubmittedBy,
			Status:                  record.Status,
			MetadataProfile:         record.MetadataProfile,
			DeliveryBoundary:        record.DeliveryBoundary,
			RelayFailureClass:       record.RelayFailureClass,
			RelayFailureDisposition: record.RelayFailureDisposition,
			CreatedAt:               record.CreatedAt,
		})
	}
	return items
}

func (s *Server) handleAliases(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}

	switch r.Method {
	case http.MethodGet:
		aliases, err := s.aliases.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"aliases": aliases})
	case http.MethodPost:
		var input model.CreateAliasInput
		if !s.decodeJSONBody(w, r, &input) {
			return
		}
		created, err := s.aliases.Create(r.Context(), actor, input)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, created)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleAliasByID(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/aliases/")
	if path == "" {
		writeError(w, http.StatusNotFound, "alias not found")
		return
	}
	if strings.HasSuffix(path, "/timeline") {
		id := strings.TrimSuffix(path, "/timeline")
		if id == "" {
			writeError(w, http.StatusNotFound, "alias not found")
			return
		}
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleAliasTimeline(w, r, actor, id)
		return
	}
	writeError(w, http.StatusNotFound, "alias not found")
}

func (s *Server) handleAliasTimeline(w http.ResponseWriter, r *http.Request, actor model.Actor, id string) {
	aliasRecord, err := s.aliases.GetOwned(r.Context(), actor, id)
	if err != nil {
		if errors.Is(err, alias.ErrAliasNotFound) || errors.Is(err, alias.ErrAliasForbidden) {
			writeError(w, http.StatusNotFound, "alias not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var submissionsForAlias []model.Submission
	var relayAttempts []model.RelayAttempt
	var inboxMessages []model.InboxMessage
	var auditEvents []model.AuditEvent

	submissionIDs := map[string]struct{}{}
	if s.submissions != nil {
		records, err := s.submissions.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, item := range records {
			if item.ChannelID == aliasRecord.ID {
				submissionsForAlias = append(submissionsForAlias, item)
				submissionIDs[item.ID] = struct{}{}
			}
		}
	}

	if s.relay != nil {
		attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, attempt := range attempts {
			if attempt.AliasID == aliasRecord.ID {
				relayAttempts = append(relayAttempts, attempt)
				continue
			}
			if _, ok := submissionIDs[attempt.SubmissionID]; ok {
				relayAttempts = append(relayAttempts, attempt)
			}
		}
	}

	if s.inboxStore != nil {
		messages, err := s.inboxStore.ListByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, item := range messages {
			if item.AliasID == aliasRecord.ID || strings.EqualFold(strings.TrimSpace(item.AliasEmail), strings.TrimSpace(aliasRecord.Email)) {
				inboxMessages = append(inboxMessages, item)
			}
		}
	}

	if s.audit != nil {
		events, err := s.audit.ListByTenant(r.Context(), actor.TenantID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, event := range events {
			if auditEventMatchesAlias(event, aliasRecord.ID, submissionIDs) {
				auditEvents = append(auditEvents, event)
			}
		}
	}

	summary := map[string]any{
		"submission_count":    len(submissionsForAlias),
		"inbox_count":         len(inboxMessages),
		"relay_attempt_count": len(relayAttempts),
		"audit_event_count":   len(auditEvents),
	}
	if latestActivityAt, ok := latestAliasActivityAt(aliasRecord, submissionsForAlias, inboxMessages, relayAttempts, auditEvents); ok {
		summary["latest_activity_at"] = latestActivityAt.UTC()
	}
	if latestFailedAttempt, ok := latestFailedRelayAttempt(relayAttempts); ok {
		summary["latest_failure_class"] = latestFailedAttempt.FailureClass
		summary["latest_failure_disposition"] = latestFailedAttempt.FailureDisposition
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary":        summary,
		"alias":          aliasRecord,
		"submissions":    submissionsForAlias,
		"inbox_messages": inboxMessages,
		"relay_attempts": relayAttempts,
		"audit_events":   auditEvents,
	})
}

func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var hasInboxFilter *bool
	if rawHasInbox := strings.TrimSpace(r.URL.Query().Get("has_inbox")); rawHasInbox != "" {
		parsed, err := strconv.ParseBool(rawHasInbox)
		if err != nil {
			writeError(w, http.StatusBadRequest, "has_inbox must be a boolean")
			return
		}
		hasInboxFilter = &parsed
	}
	var hasFailuresFilter *bool
	if rawHasFailures := strings.TrimSpace(r.URL.Query().Get("has_failures")); rawHasFailures != "" {
		parsed, err := strconv.ParseBool(rawHasFailures)
		if err != nil {
			writeError(w, http.StatusBadRequest, "has_failures must be a boolean")
			return
		}
		hasFailuresFilter = &parsed
	}
	var hasRelayAttemptsFilter *bool
	if rawHasRelayAttempts := strings.TrimSpace(r.URL.Query().Get("has_relay_attempts")); rawHasRelayAttempts != "" {
		parsed, err := strconv.ParseBool(rawHasRelayAttempts)
		if err != nil {
			writeError(w, http.StatusBadRequest, "has_relay_attempts must be a boolean")
			return
		}
		hasRelayAttemptsFilter = &parsed
	}
	latestSubmissionStatusFilter := strings.TrimSpace(r.URL.Query().Get("latest_submission_status"))
	if latestSubmissionStatusFilter != "" && !isValidSubmissionStatusFilter(latestSubmissionStatusFilter) {
		writeError(w, http.StatusBadRequest, "latest_submission_status must be one of accepted, queued, sanitized, relayed, failed, blocked")
		return
	}

	aliases, err := s.aliases.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	submissionsByAlias := map[string][]model.Submission{}
	submissionIDsByAlias := map[string]map[string]struct{}{}
	if s.submissions != nil {
		records, err := s.submissions.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, item := range records {
			submissionsByAlias[item.ChannelID] = append(submissionsByAlias[item.ChannelID], item)
			if _, ok := submissionIDsByAlias[item.ChannelID]; !ok {
				submissionIDsByAlias[item.ChannelID] = map[string]struct{}{}
			}
			submissionIDsByAlias[item.ChannelID][item.ID] = struct{}{}
		}
	}

	relayByAlias := map[string][]model.RelayAttempt{}
	if s.relay != nil {
		attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, attempt := range attempts {
			if attempt.AliasID != "" {
				relayByAlias[attempt.AliasID] = append(relayByAlias[attempt.AliasID], attempt)
				continue
			}
			for aliasID, submissionIDs := range submissionIDsByAlias {
				if _, ok := submissionIDs[attempt.SubmissionID]; ok {
					relayByAlias[aliasID] = append(relayByAlias[aliasID], attempt)
				}
			}
		}
	}

	inboxByAlias := map[string][]model.InboxMessage{}
	if s.inboxStore != nil {
		messages, err := s.inboxStore.ListByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		for _, item := range messages {
			key := item.AliasID
			if key == "" {
				key = strings.ToLower(strings.TrimSpace(item.AliasEmail))
			}
			inboxByAlias[key] = append(inboxByAlias[key], item)
		}
	}

	allChannels := buildChannelSummaries(aliases, submissionsByAlias, relayByAlias, inboxByAlias)
	channels := make([]channelSummary, 0, len(allChannels))
	for _, item := range allChannels {
		if hasInboxFilter != nil && (item.InboxCount > 0) != *hasInboxFilter {
			continue
		}
		if hasFailuresFilter != nil && (item.LatestFailureClass != "") != *hasFailuresFilter {
			continue
		}
		if hasRelayAttemptsFilter != nil && (item.RelayAttemptCount > 0) != *hasRelayAttemptsFilter {
			continue
		}
		if latestSubmissionStatusFilter != "" && item.LatestSubmissionStatus != latestSubmissionStatusFilter {
			continue
		}
		channels = append(channels, item)
	}

	writeJSON(w, http.StatusOK, map[string]any{"channels": channels})
}

func (s *Server) handleRelayQueue(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.submissions == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"summary": map[string]any{
				"queue_count":            0,
				"retryable_failed_count": 0,
			},
			"submissions": []model.Submission{},
		})
		return
	}

	records, err := s.submissions.ListForActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	queued := make([]model.Submission, 0, len(records))
	retryableFailedCount := 0
	for _, item := range records {
		if !isRelayQueueCandidate(item) {
			continue
		}
		if item.Status == model.SubmissionStatusFailed && item.RelayFailureDisposition == "retryable" {
			retryableFailedCount++
		}
		queued = append(queued, item)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary": map[string]any{
			"queue_count":            len(queued),
			"retryable_failed_count": retryableFailedCount,
		},
		"submissions": queued,
	})
}

func isRelayQueueCandidate(item model.Submission) bool {
	switch item.Status {
	case model.SubmissionStatusAccepted,
		model.SubmissionStatusQueued,
		model.SubmissionStatusSanitized:
		return true
	case model.SubmissionStatusFailed:
		return item.RelayFailureDisposition == "retryable"
	default:
		return false
	}
}

func buildChannelSummaries(aliases []model.Alias, submissionsByAlias map[string][]model.Submission, relayByAlias map[string][]model.RelayAttempt, inboxByAlias map[string][]model.InboxMessage) []channelSummary {
	channels := make([]channelSummary, 0, len(aliases))
	for _, aliasRecord := range aliases {
		submissionsForAlias := submissionsByAlias[aliasRecord.ID]
		relayAttempts := relayByAlias[aliasRecord.ID]
		inboxMessages := append([]model.InboxMessage(nil), inboxByAlias[aliasRecord.ID]...)
		inboxMessages = append(inboxMessages, inboxByAlias[strings.ToLower(strings.TrimSpace(aliasRecord.Email))]...)

		item := channelSummary{
			Alias:             aliasRecord,
			SubmissionCount:   len(submissionsForAlias),
			InboxCount:        len(inboxMessages),
			RelayAttemptCount: len(relayAttempts),
		}
		if latestSubmission, ok := latestSubmissionForAlias(submissionsForAlias); ok {
			item.LatestSubmissionStatus = string(latestSubmission.Status)
		}
		if latestInboundAt, ok := latestInboundAtForAlias(inboxMessages); ok {
			item.LatestInboundAt = latestInboundAt.UTC()
		}
		if latestActivityAt, ok := latestAliasActivityAt(aliasRecord, submissionsForAlias, inboxMessages, relayAttempts, nil); ok {
			item.LatestActivityAt = latestActivityAt.UTC()
		}
		if latestFailedAttempt, ok := latestFailedRelayAttempt(relayAttempts); ok {
			item.LatestFailureClass = latestFailedAttempt.FailureClass
			item.LatestFailureDisposition = latestFailedAttempt.FailureDisposition
		}
		channels = append(channels, item)
	}
	return channels
}

func latestDashboardActivityAt(aliases []model.Alias, channels []channelSummary, auditEvents []model.AuditEvent) (time.Time, bool) {
	var latest time.Time
	found := false

	for _, aliasRecord := range aliases {
		if !found || aliasRecord.CreatedAt.After(latest) {
			latest = aliasRecord.CreatedAt
			found = true
		}
	}
	for _, channel := range channels {
		if channel.LatestActivityAt.IsZero() {
			continue
		}
		if !found || channel.LatestActivityAt.After(latest) {
			latest = channel.LatestActivityAt
			found = true
		}
	}
	for _, event := range auditEvents {
		if !found || event.CreatedAt.After(latest) {
			latest = event.CreatedAt
			found = true
		}
	}

	return latest, found
}

func auditEventMatchesAlias(event model.AuditEvent, aliasID string, submissionIDs map[string]struct{}) bool {
	if event.ResourceID == aliasID {
		return true
	}
	if event.Metadata["alias_id"] == aliasID || event.Metadata["channel_id"] == aliasID {
		return true
	}
	if submissionID, ok := event.Metadata["submission_id"]; ok {
		_, matched := submissionIDs[submissionID]
		return matched
	}
	_, matched := submissionIDs[event.ResourceID]
	return matched
}

func latestSubmissionForAlias(items []model.Submission) (model.Submission, bool) {
	var latest model.Submission
	found := false
	for _, item := range items {
		if !found || item.CreatedAt.After(latest.CreatedAt) {
			latest = item
			found = true
		}
	}
	return latest, found
}

func isValidSubmissionStatusFilter(value string) bool {
	switch model.SubmissionStatus(value) {
	case model.SubmissionStatusAccepted,
		model.SubmissionStatusQueued,
		model.SubmissionStatusSanitized,
		model.SubmissionStatusRelayed,
		model.SubmissionStatusFailed,
		model.SubmissionStatusBlocked:
		return true
	default:
		return false
	}
}

func latestInboundAtForAlias(items []model.InboxMessage) (time.Time, bool) {
	var latest time.Time
	found := false
	for _, item := range items {
		if !found || item.ReceivedAt.After(latest) {
			latest = item.ReceivedAt
			found = true
		}
	}
	return latest, found
}

func (s *Server) handleAuditEvents(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.audit == nil {
		writeError(w, http.StatusNotImplemented, "audit service is not configured")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	limit := 0
	if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}

	var since time.Time
	if rawSince := r.URL.Query().Get("since"); rawSince != "" {
		parsed, err := time.Parse(time.RFC3339Nano, rawSince)
		if err != nil {
			writeError(w, http.StatusBadRequest, "since must be a valid RFC3339 timestamp")
			return
		}
		since = parsed
	}

	events, err := s.audit.ListByTenantFiltered(r.Context(), actor.TenantID, audit.ListOptions{
		EventType:    r.URL.Query().Get("event_type"),
		ResourceID:   r.URL.Query().Get("resource_id"),
		SubmissionID: r.URL.Query().Get("submission_id"),
		Limit:        limit,
		Since:        since,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *Server) handleIdentityLinks(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.identityVault == nil {
		writeError(w, http.StatusNotImplemented, "identity vault is not configured")
		return
	}
	switch r.Method {
	case http.MethodGet:
		links, err := s.identityVault.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if aliasID := strings.TrimSpace(r.URL.Query().Get("alias_id")); aliasID != "" {
			filtered := make([]model.IdentityLink, 0, len(links))
			for _, link := range links {
				if link.AliasID == aliasID {
					filtered = append(filtered, link)
				}
			}
			links = filtered
		}

		writeJSON(w, http.StatusOK, map[string]any{"identity_links": links})
	case http.MethodPost:
		var input model.CreateIdentityLinkInput
		if !s.decodeJSONBody(w, r, &input) {
			return
		}

		created, err := s.identityVault.CreateLink(r.Context(), actor, input.AliasID, input.RealIdentityRef, input.Purpose, input.ExpiresAt)
		if err != nil {
			switch {
			case errors.Is(err, identityvault.ErrAliasIDRequired),
				errors.Is(err, identityvault.ErrRealIdentityRefRequired),
				errors.Is(err, identityvault.ErrInvalidRealIdentityRef),
				errors.Is(err, identityvault.ErrInvalidPurpose),
				errors.Is(err, identityvault.ErrExpiresAtInPast):
				writeError(w, http.StatusBadRequest, err.Error())
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}

		if s.audit != nil {
			_, err = s.audit.Record(r.Context(), actor.TenantID, actor.ID, "identity_link_created", created.ID, map[string]string{
				"alias_id": created.AliasID,
				"purpose":  created.Purpose,
			})
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}

		writeJSON(w, http.StatusCreated, created)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleIdentityLinkByAliasID(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.identityVault == nil {
		writeError(w, http.StatusNotImplemented, "identity vault is not configured")
		return
	}
	path := r.URL.Path[len("/v1/identity-links/"):]
	if path == "" {
		writeError(w, http.StatusNotFound, "identity link not found")
		return
	}

	if r.Method == http.MethodPost && len(path) > len("/revoke") && path[len(path)-len("/revoke"):] == "/revoke" {
		aliasID := path[:len(path)-len("/revoke")]
		if aliasID == "" {
			writeError(w, http.StatusNotFound, "identity link not found")
			return
		}

		var input revokeIdentityLinkInput
		if !s.decodeOptionalJSONBody(w, r, &input) {
			return
		}
		reason := strings.TrimSpace(input.Reason)
		if !utf8.ValidString(reason) || strings.ContainsAny(reason, "\r\n") {
			writeError(w, http.StatusBadRequest, "reason contains invalid UTF-8")
			return
		}

		revoked, err := s.identityVault.RevokeByAliasID(r.Context(), actor, aliasID)
		if err != nil {
			switch {
			case errors.Is(err, identityvault.ErrIdentityLinkNotFound):
				writeError(w, http.StatusNotFound, "identity link not found")
			case errors.Is(err, identityvault.ErrIdentityLinkRevoked):
				writeError(w, http.StatusConflict, "identity link is already revoked")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}

		if s.audit != nil {
			metadata := map[string]string{
				"alias_id": revoked.AliasID,
			}
			if reason != "" {
				metadata["reason"] = reason
			}
			_, err = s.audit.Record(r.Context(), actor.TenantID, actor.ID, "identity_link_revoked", revoked.ID, metadata)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}

		writeJSON(w, http.StatusOK, revoked)
		return
	}

	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	aliasID := path
	if aliasID == "" {
		writeError(w, http.StatusNotFound, "identity link not found")
		return
	}

	link, err := s.identityVault.GetByAliasID(r.Context(), actor, aliasID)
	if err != nil {
		if errors.Is(err, identityvault.ErrIdentityLinkNotFound) {
			writeError(w, http.StatusNotFound, "identity link not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, link)
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var input model.SendMessageInput
	if !s.decodeJSONBody(w, r, &input) {
		return
	}

	record, err := s.submission.Submit(r.Context(), actor, input)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrUnauthorized):
			writeError(w, http.StatusUnauthorized, err.Error())
		case errors.Is(err, alias.ErrAliasForbidden), errors.Is(err, alias.ErrAliasNotFound):
			writeError(w, http.StatusForbidden, err.Error())
		case errors.Is(err, policy.ErrNoRecipients),
			errors.Is(err, policy.ErrTooManyRecipients),
			errors.Is(err, policy.ErrEmptyBody),
			errors.Is(err, policy.ErrHTMLNotSupported),
			errors.Is(err, policy.ErrMessageTooLarge),
			errors.Is(err, policy.ErrInvalidRecipient),
			errors.Is(err, policy.ErrInvalidSubject):
			writeError(w, http.StatusBadRequest, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	writeJSON(w, http.StatusAccepted, record)
}

func (s *Server) handleSubmissions(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}

	switch r.Method {
	case http.MethodGet:
		submissions, err := s.submissions.ListForActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		limit := 0
		if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
			parsed, err := strconv.Atoi(rawLimit)
			if err != nil || parsed <= 0 {
				writeError(w, http.StatusBadRequest, "limit must be a positive integer")
				return
			}
			limit = parsed
		}
		if channelID := strings.TrimSpace(r.URL.Query().Get("channel_id")); channelID != "" {
			filtered := make([]model.Submission, 0, len(submissions))
			for _, item := range submissions {
				if item.ChannelID == channelID {
					filtered = append(filtered, item)
				}
			}
			submissions = filtered
		}
		if status := strings.TrimSpace(r.URL.Query().Get("status")); status != "" {
			submissionStatus := model.SubmissionStatus(status)
			if !isValidSubmissionStatus(submissionStatus) {
				writeError(w, http.StatusBadRequest, "status must be a valid submission status")
				return
			}
			filtered := make([]model.Submission, 0, len(submissions))
			for _, item := range submissions {
				if item.Status == submissionStatus {
					filtered = append(filtered, item)
				}
			}
			submissions = filtered
		}
		if limit > 0 && len(submissions) > limit {
			submissions = submissions[:limit]
		}
		writeJSON(w, http.StatusOK, map[string]any{"submissions": submissions})
	case http.MethodPost:
		var input model.CreateSubmissionInput
		if !s.decodeJSONBody(w, r, &input) {
			return
		}
		created, err := s.submissions.CreateFromPublicAPI(r.Context(), actor, input)
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrChannelRequired),
				errors.Is(err, submission.ErrInvalidChannelID),
				errors.Is(err, submission.ErrEmptyBody),
				errors.Is(err, submission.ErrHTMLNotSupported),
				errors.Is(err, submission.ErrInvalidSanitizerProfile),
				errors.Is(err, submission.ErrInvalidRecipient),
				errors.Is(err, submission.ErrTooManyRecipients),
				errors.Is(err, submission.ErrInvalidSubject),
				errors.Is(err, submission.ErrTooManyAttachments),
				errors.Is(err, submission.ErrInvalidAttachment):
				writeError(w, http.StatusBadRequest, err.Error())
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusCreated, created)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleSubmissionByID(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if s.submissions == nil {
		writeError(w, http.StatusNotImplemented, "submission service is not configured")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/submissions/")
	if path == "" {
		writeError(w, http.StatusNotFound, "submission not found")
		return
	}
	if strings.HasSuffix(path, "/timeline") {
		id := strings.TrimSuffix(path, "/timeline")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleSubmissionTimeline(w, r, actor, id)
		return
	}
	if strings.HasSuffix(path, "/queue") {
		id := strings.TrimSuffix(path, "/queue")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		record, err := s.submissions.QueueForRelay(r.Context(), id, "manual_queue")
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrSubmissionNotFound):
				writeError(w, http.StatusNotFound, "submission not found")
			case errors.Is(err, submission.ErrCannotQueue):
				writeError(w, http.StatusConflict, "submission cannot be queued")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if strings.HasSuffix(path, "/release") {
		id := strings.TrimSuffix(path, "/release")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		record, err := s.submissions.ReleaseToRelay(r.Context(), id, "manual_release")
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrSubmissionNotFound):
				writeError(w, http.StatusNotFound, "submission not found")
			case errors.Is(err, submission.ErrCannotRelease):
				writeError(w, http.StatusConflict, "submission cannot be released")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if strings.HasSuffix(path, "/relay") {
		id := strings.TrimSuffix(path, "/relay")
		if id == "" {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		record, err := s.relaySubmission(r.Context(), actor, id, "submission_native_relay")
		if err != nil {
			switch {
			case errors.Is(err, submission.ErrSubmissionNotFound):
				writeError(w, http.StatusNotFound, "submission not found")
			case errors.Is(err, alias.ErrAliasForbidden), errors.Is(err, alias.ErrAliasNotFound):
				writeError(w, http.StatusConflict, "submission channel is not relay-capable")
			case errors.Is(err, errSubmissionCannotRelay):
				writeError(w, http.StatusConflict, "submission cannot be relayed")
			default:
				writeError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusOK, record)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	id := path

	submissionRecord, err := s.submissions.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, submission.ErrSubmissionNotFound) {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if submissionRecord.TenantID != actor.TenantID {
		writeError(w, http.StatusNotFound, "submission not found")
		return
	}

	writeJSON(w, http.StatusOK, submissionRecord)
}

var errSubmissionCannotRelay = errors.New("submission cannot be relayed")

func canRelaySubmission(record model.Submission) bool {
	switch record.Status {
	case model.SubmissionStatusAccepted, model.SubmissionStatusSanitized, model.SubmissionStatusQueued:
		return true
	case model.SubmissionStatusFailed:
		return record.RelayFailureDisposition == "retryable"
	default:
		return false
	}
}

func (s *Server) relaySubmission(ctx context.Context, actor model.Actor, id, sourcePath string) (model.Submission, error) {
	if s.submissions == nil || s.relay == nil || s.aliases == nil {
		return model.Submission{}, errors.New("relay workflow is not configured")
	}

	record, err := s.submissions.GetByID(ctx, id)
	if err != nil {
		return model.Submission{}, err
	}
	if record.TenantID != actor.TenantID {
		return model.Submission{}, submission.ErrSubmissionNotFound
	}
	if !canRelaySubmission(record) || len(record.To) == 0 {
		return model.Submission{}, errSubmissionCannotRelay
	}

	senderAlias, err := s.aliases.GetOwned(ctx, actor, record.ChannelID)
	if err != nil {
		return model.Submission{}, err
	}

	msg := model.SanitizedMessage{
		Actor:     actor,
		Alias:     senderAlias,
		To:        append([]string(nil), record.To...),
		Subject:   record.Subject,
		TextBody:  record.TextBody,
		CreatedAt: record.CreatedAt,
	}

	attempt, _, err := s.relay.Relay(ctx, record.ID, msg)
	if err != nil {
		failureClass, failureDisposition := compat.ClassifyRelayFailure(err)
		failedAttempt, attemptErr := s.relay.RecordFailure(ctx, record.ID, msg, failureClass, failureDisposition, err.Error())
		if attemptErr != nil {
			return model.Submission{}, attemptErr
		}
		if auditErr := s.recordRelayAttemptAudit(ctx, actor, failedAttempt); auditErr != nil {
			return model.Submission{}, auditErr
		}
		return s.submissions.MarkRelayFailed(ctx, record.ID, failedAttempt.ID, s.relay.Provider(), sourcePath, failureClass, failureDisposition, err.Error(), time.Now().UTC())
	}
	if err := s.recordRelayAttemptAudit(ctx, actor, attempt); err != nil {
		return model.Submission{}, err
	}
	return s.submissions.MarkRelayed(ctx, record.ID, attempt.Provider, attempt.ID, sourcePath, time.Now().UTC())
}

func (s *Server) recordRelayAttemptAudit(ctx context.Context, actor model.Actor, attempt model.RelayAttempt) error {
	if s.audit == nil {
		return nil
	}
	metadata := map[string]string{
		"submission_id":       attempt.SubmissionID,
		"alias_id":            attempt.AliasID,
		"provider":            attempt.Provider,
		"status":              attempt.Status,
		"failure_class":       attempt.FailureClass,
		"failure_disposition": attempt.FailureDisposition,
	}
	if attempt.FailureReason != "" {
		metadata["failure_reason"] = attempt.FailureReason
	}
	_, err := s.audit.Record(ctx, actor.TenantID, actor.ID, "relay_attempt_created", attempt.ID, metadata)
	return err
}

func (s *Server) handleSubmissionTimeline(w http.ResponseWriter, r *http.Request, actor model.Actor, id string) {
	submissionRecord, err := s.submissions.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, submission.ErrSubmissionNotFound) {
			writeError(w, http.StatusNotFound, "submission not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if submissionRecord.TenantID != actor.TenantID {
		writeError(w, http.StatusNotFound, "submission not found")
		return
	}

	var relayAttempts []model.RelayAttempt
	if s.relay != nil {
		attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		relayAttempts = make([]model.RelayAttempt, 0, len(attempts))
		for _, attempt := range attempts {
			if attempt.SubmissionID == submissionRecord.ID {
				relayAttempts = append(relayAttempts, attempt)
			}
		}
	}

	var auditEvents []model.AuditEvent
	if s.audit != nil {
		events, err := s.audit.ListByTenantFiltered(r.Context(), actor.TenantID, audit.ListOptions{
			SubmissionID: submissionRecord.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		auditEvents = events
	}

	writeJSON(w, http.StatusOK, buildSubmissionTimelineResponse(submissionRecord, relayAttempts, auditEvents))
}

func (s *Server) handleIntakeSubmissionTimeline(w http.ResponseWriter, r *http.Request, actor model.Actor, id string) {
	submissionRecord, ok := s.getAccessibleIntakeSubmission(w, r, actor, id)
	if !ok {
		return
	}

	var relayAttempts []model.RelayAttempt
	if s.relay != nil {
		attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		relayAttempts = make([]model.RelayAttempt, 0, len(attempts))
		for _, attempt := range attempts {
			if attempt.SubmissionID == submissionRecord.ID {
				relayAttempts = append(relayAttempts, attempt)
			}
		}
	}

	var auditEvents []model.AuditEvent
	if s.audit != nil {
		events, err := s.audit.ListByTenantFiltered(r.Context(), actor.TenantID, audit.ListOptions{
			SubmissionID: submissionRecord.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		auditEvents = make([]model.AuditEvent, 0, len(events))
		for _, event := range events {
			if event.ActorID == "" || event.ActorID == actor.ID {
				auditEvents = append(auditEvents, event)
			}
		}
	}

	writeJSON(w, http.StatusOK, buildSubmissionTimelineResponse(submissionRecord, relayAttempts, auditEvents))
}

func (s *Server) getAccessibleIntakeSubmission(w http.ResponseWriter, r *http.Request, actor model.Actor, id string) (model.Submission, bool) {
	record, err := s.submissions.GetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, submission.ErrSubmissionNotFound) {
			writeError(w, http.StatusNotFound, "submission not found")
			return model.Submission{}, false
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return model.Submission{}, false
	}
	if record.TenantID != actor.TenantID || record.SubmittedBy != actor.ID {
		writeError(w, http.StatusNotFound, "submission not found")
		return model.Submission{}, false
	}
	return record, true
}

func buildSubmissionTimelineResponse(submissionRecord model.Submission, relayAttempts []model.RelayAttempt, auditEvents []model.AuditEvent) map[string]any {
	summary := map[string]any{
		"latest_status":     submissionRecord.Status,
		"attempt_count":     len(relayAttempts),
		"audit_event_count": len(auditEvents),
	}
	if latestFailedAttempt, ok := latestFailedRelayAttempt(relayAttempts); ok {
		summary["latest_failure_class"] = latestFailedAttempt.FailureClass
		summary["latest_failure_disposition"] = latestFailedAttempt.FailureDisposition
	}
	if latestActivityAt, ok := latestSubmissionActivityAt(submissionRecord, relayAttempts, auditEvents); ok {
		summary["latest_activity_at"] = latestActivityAt.UTC()
	}

	return map[string]any{
		"summary":        summary,
		"submission":     submissionRecord,
		"relay_attempts": relayAttempts,
		"audit_events":   auditEvents,
	}
}

func latestFailedRelayAttempt(attempts []model.RelayAttempt) (model.RelayAttempt, bool) {
	var latest model.RelayAttempt
	found := false
	for _, attempt := range attempts {
		if attempt.Status != "failed" {
			continue
		}
		if !found || attempt.CreatedAt.After(latest.CreatedAt) {
			latest = attempt
			found = true
		}
	}
	return latest, found
}

func latestSubmissionActivityAt(submissionRecord model.Submission, relayAttempts []model.RelayAttempt, auditEvents []model.AuditEvent) (time.Time, bool) {
	latest := submissionRecord.CreatedAt
	found := !submissionRecord.CreatedAt.IsZero()

	for _, attempt := range relayAttempts {
		if !found || attempt.CreatedAt.After(latest) {
			latest = attempt.CreatedAt
			found = true
		}
	}
	for _, event := range auditEvents {
		if !found || event.CreatedAt.After(latest) {
			latest = event.CreatedAt
			found = true
		}
	}

	return latest, found
}

func latestInboxActivityAt(message model.InboxMessage, submissionRecord *model.Submission, relayAttempts []model.RelayAttempt, auditEvents []model.AuditEvent) (time.Time, bool) {
	latest := message.ReceivedAt
	found := !message.ReceivedAt.IsZero()

	if submissionRecord != nil && (!found || submissionRecord.CreatedAt.After(latest)) {
		latest = submissionRecord.CreatedAt
		found = true
	}
	for _, attempt := range relayAttempts {
		if !found || attempt.CreatedAt.After(latest) {
			latest = attempt.CreatedAt
			found = true
		}
	}
	for _, event := range auditEvents {
		if !found || event.CreatedAt.After(latest) {
			latest = event.CreatedAt
			found = true
		}
	}

	return latest, found
}

func latestAliasActivityAt(aliasRecord model.Alias, submissionsForAlias []model.Submission, inboxMessages []model.InboxMessage, relayAttempts []model.RelayAttempt, auditEvents []model.AuditEvent) (time.Time, bool) {
	latest := aliasRecord.CreatedAt
	found := !aliasRecord.CreatedAt.IsZero()

	for _, item := range submissionsForAlias {
		if !found || item.CreatedAt.After(latest) {
			latest = item.CreatedAt
			found = true
		}
	}
	for _, item := range inboxMessages {
		if !found || item.ReceivedAt.After(latest) {
			latest = item.ReceivedAt
			found = true
		}
	}
	for _, item := range relayAttempts {
		if !found || item.CreatedAt.After(latest) {
			latest = item.CreatedAt
			found = true
		}
	}
	for _, item := range auditEvents {
		if !found || item.CreatedAt.After(latest) {
			latest = item.CreatedAt
			found = true
		}
	}

	return latest, found
}

func buildRelayAttemptSummary(attempts []model.RelayAttempt) map[string]any {
	summary := map[string]any{
		"attempt_count":   len(attempts),
		"failed_count":    0,
		"retryable_count": 0,
		"terminal_count":  0,
	}

	var latestFailedAt time.Time
	for _, attempt := range attempts {
		if attempt.Status != "failed" {
			continue
		}
		summary["failed_count"] = summary["failed_count"].(int) + 1
		switch attempt.FailureDisposition {
		case "retryable":
			summary["retryable_count"] = summary["retryable_count"].(int) + 1
		case "terminal":
			summary["terminal_count"] = summary["terminal_count"].(int) + 1
		}
		if latestFailedAt.IsZero() || attempt.CreatedAt.After(latestFailedAt) {
			latestFailedAt = attempt.CreatedAt
		}
	}
	if !latestFailedAt.IsZero() {
		summary["latest_failed_at"] = latestFailedAt.UTC()
	}

	return summary
}

func (s *Server) handleOutbox(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	records, err := s.gateway.ListByActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"messages": records})
}

func (s *Server) handleInbox(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.inboxStore == nil {
		writeJSON(w, http.StatusOK, map[string]any{"messages": []model.InboxMessage{}})
		return
	}

	messages, err := s.inboxStore.ListByActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"messages": messages})
}

func (s *Server) handleInboxByID(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/messages/inbox/")
	if path == "" {
		writeError(w, http.StatusNotFound, "inbox message not found")
		return
	}
	if strings.HasSuffix(path, "/timeline") {
		id := strings.TrimSuffix(path, "/timeline")
		if id == "" {
			writeError(w, http.StatusNotFound, "inbox message not found")
			return
		}
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleInboxTimeline(w, r, actor, id)
		return
	}

	writeError(w, http.StatusNotFound, "inbox message not found")
}

func (s *Server) handleInboxTimeline(w http.ResponseWriter, r *http.Request, actor model.Actor, id string) {
	if s.inboxStore == nil {
		writeError(w, http.StatusNotFound, "inbox message not found")
		return
	}

	messages, err := s.inboxStore.ListByActor(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var message model.InboxMessage
	found := false
	for _, item := range messages {
		if item.ID == id {
			message = item
			found = true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "inbox message not found")
		return
	}

	var submissionRecord *model.Submission
	var relayAttempts []model.RelayAttempt
	var auditEvents []model.AuditEvent

	if s.submissions != nil && message.SubmissionID != "" {
		record, err := s.submissions.GetByID(r.Context(), message.SubmissionID)
		if err != nil && !errors.Is(err, submission.ErrSubmissionNotFound) {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err == nil && record.TenantID == actor.TenantID {
			submissionRecord = &record
		}
	}

	if submissionRecord != nil && s.relay != nil {
		attempts, err := s.relay.ListAttemptsByActor(r.Context(), actor)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		relayAttempts = make([]model.RelayAttempt, 0, len(attempts))
		for _, attempt := range attempts {
			if attempt.SubmissionID == submissionRecord.ID {
				relayAttempts = append(relayAttempts, attempt)
			}
		}
	}

	if submissionRecord != nil && s.audit != nil {
		events, err := s.audit.ListByTenantFiltered(r.Context(), actor.TenantID, audit.ListOptions{
			SubmissionID: submissionRecord.ID,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		auditEvents = events
	}

	summary := map[string]any{
		"has_submission_link": submissionRecord != nil,
		"attempt_count":       len(relayAttempts),
		"audit_event_count":   len(auditEvents),
	}
	if submissionRecord != nil {
		summary["latest_status"] = submissionRecord.Status
	}
	if latestFailedAttempt, ok := latestFailedRelayAttempt(relayAttempts); ok {
		summary["latest_failure_class"] = latestFailedAttempt.FailureClass
		summary["latest_failure_disposition"] = latestFailedAttempt.FailureDisposition
	}
	if latestActivityAt, ok := latestInboxActivityAt(message, submissionRecord, relayAttempts, auditEvents); ok {
		summary["latest_activity_at"] = latestActivityAt.UTC()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary":        summary,
		"message":        message,
		"submission":     submissionRecord,
		"relay_attempts": relayAttempts,
		"audit_events":   auditEvents,
	})
}

func (s *Server) handleInboxSync(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireActor(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.inboxSyncer == nil {
		writeError(w, http.StatusNotImplemented, "imap sync is not configured")
		return
	}

	count, err := s.inboxSyncer.Sync(r.Context(), actor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{"synced": count})
}

func (s *Server) requireActor(w http.ResponseWriter, r *http.Request) (model.Actor, bool) {
	actor, err := s.auth.Authenticate(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return model.Actor{}, false
	}
	return actor, true
}

func (s *Server) requireIntakeActor(w http.ResponseWriter, r *http.Request) (model.Actor, bool) {
	if s.intakeAuth == nil {
		writeError(w, http.StatusNotImplemented, "intake auth is not configured")
		return model.Actor{}, false
	}
	actor, err := s.intakeAuth.Authenticate(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return model.Actor{}, false
	}
	return actor, true
}

func (s *Server) decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxJSONBodyBytes)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		var maxBytesErr *http.MaxBytesError
		switch {
		case errors.As(err, &maxBytesErr):
			writeError(w, http.StatusRequestEntityTooLarge, "request body exceeds limit")
		default:
			writeError(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}

	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}

	return true
}

func (s *Server) decodeOptionalJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxJSONBodyBytes)

	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		switch {
		case errors.As(err, &maxBytesErr):
			writeError(w, http.StatusRequestEntityTooLarge, "request body exceeds limit")
		default:
			writeError(w, http.StatusBadRequest, "invalid JSON body")
		}
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return true
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}

	return true
}

func isValidSubmissionStatus(status model.SubmissionStatus) bool {
	switch status {
	case model.SubmissionStatusAccepted,
		model.SubmissionStatusQueued,
		model.SubmissionStatusSanitized,
		model.SubmissionStatusRelayed,
		model.SubmissionStatusFailed,
		model.SubmissionStatusBlocked:
		return true
	default:
		return false
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	if status == http.StatusInternalServerError {
		slog.Error("http internal error", "op", "httpapi.writeError/500", "status", status)
		message = "internal server error"
	}
	writeJSON(w, status, map[string]string{"error": message})
}

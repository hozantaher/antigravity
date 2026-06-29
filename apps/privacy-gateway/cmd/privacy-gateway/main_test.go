package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"privacy-gateway/internal/config"
	"privacy-gateway/internal/inbox"
	"privacy-gateway/internal/model"
)

func TestNewHTTPServerUsesConfigAndServesHealth(t *testing.T) {
	cfg := config.Config{
		ListenAddr:      ":9090",
		DataDir:         t.TempDir(),
		AliasDomain:     "relay.example",
		MaxRecipients:   5,
		MaxMessageBytes: 1024,
		DevToken:        "token-1",
		DevActor:        model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	server, err := newHTTPServer(cfg)
	if err != nil {
		t.Fatalf("newHTTPServer() error = %v", err)
	}

	if server.Addr != ":9090" {
		t.Fatalf("expected listen addr :9090, got %s", server.Addr)
	}
	if server.ReadHeaderTimeout != 5*time.Second {
		t.Fatalf("expected 5s read header timeout, got %v", server.ReadHeaderTimeout)
	}

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	server.Handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected health status %d, got %d", http.StatusOK, recorder.Code)
	}
}

func TestNewRuntimeDependenciesBuildsPivotServices(t *testing.T) {
	cfg := config.Config{
		ListenAddr:      ":9090",
		DataDir:         filepath.Join(t.TempDir(), "data"),
		AliasDomain:     "relay.example",
		MaxRecipients:   5,
		MaxMessageBytes: 1024,
		DevToken:        "token-1",
		DevActor:        model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	deps, err := newRuntimeDependencies(cfg)
	if err != nil {
		t.Fatalf("newRuntimeDependencies() error = %v", err)
	}
	if deps.aliasService == nil {
		t.Fatal("expected alias service")
	}
	if deps.submissionService == nil {
		t.Fatal("expected submission service")
	}
	if deps.identityVault == nil {
		t.Fatal("expected identity vault service")
	}
	if deps.sanitizerService == nil {
		t.Fatal("expected sanitizer service")
	}
	if deps.relayService == nil {
		t.Fatal("expected relay service")
	}
	if deps.auditService == nil {
		t.Fatal("expected audit service")
	}
	if deps.intakeAuthenticator != nil {
		t.Fatal("expected intake authenticator to be absent by default")
	}
}

func TestNewRuntimeDependenciesBuildsIntakeAuthenticatorWhenConfigured(t *testing.T) {
	cfg := config.Config{
		ListenAddr:      ":9090",
		DataDir:         filepath.Join(t.TempDir(), "data"),
		AliasDomain:     "relay.example",
		MaxRecipients:   5,
		MaxMessageBytes: 1024,
		DevToken:        "token-1",
		DevActor:        model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
		IntakeToken:     "intake-token",
		IntakeActor:     model.Actor{ID: "intake-1", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"},
	}

	deps, err := newRuntimeDependencies(cfg)
	if err != nil {
		t.Fatalf("newRuntimeDependencies() error = %v", err)
	}
	if deps.intakeAuthenticator == nil {
		t.Fatal("expected intake authenticator")
	}
}

func TestNewHandlerPersistsAliasesAndOutboxAcrossRebuild(t *testing.T) {
	cfg := config.Config{
		ListenAddr:      ":9090",
		DataDir:         filepath.Join(t.TempDir(), "data"),
		AliasDomain:     "relay.example",
		MaxRecipients:   5,
		MaxMessageBytes: 1024,
		DevToken:        "token-1",
		DevActor:        model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	handler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("first newHandler() error = %v", err)
	}

	createAliasReq := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createAliasReq.Header.Set("Authorization", "Bearer token-1")
	createAliasReq.Header.Set("Content-Type", "application/json")
	createAliasRec := httptest.NewRecorder()
	handler.ServeHTTP(createAliasRec, createAliasReq)
	if createAliasRec.Code != http.StatusCreated {
		t.Fatalf("expected created alias status %d, got %d", http.StatusCreated, createAliasRec.Code)
	}

	var created model.Alias
	if err := json.Unmarshal(createAliasRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode alias: %v", err)
	}

	body, err := json.Marshal(model.SendMessageInput{
		AliasID:  created.ID,
		To:       []string{"recipient@example.com"},
		Subject:  "hello",
		TextBody: "safe body",
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	sendReq := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader(body))
	sendReq.Header.Set("Authorization", "Bearer token-1")
	sendReq.Header.Set("Content-Type", "application/json")
	sendRec := httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusAccepted {
		t.Fatalf("expected accepted send status %d, got %d", http.StatusAccepted, sendRec.Code)
	}

	reloadedHandler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("second newHandler() error = %v", err)
	}

	listAliasesReq := httptest.NewRequest(http.MethodGet, "/v1/aliases", nil)
	listAliasesReq.Header.Set("Authorization", "Bearer token-1")
	listAliasesRec := httptest.NewRecorder()
	reloadedHandler.ServeHTTP(listAliasesRec, listAliasesReq)
	if listAliasesRec.Code != http.StatusOK {
		t.Fatalf("expected list aliases status %d, got %d", http.StatusOK, listAliasesRec.Code)
	}

	var aliasesResponse struct {
		Aliases []model.Alias `json:"aliases"`
	}
	if err := json.Unmarshal(listAliasesRec.Body.Bytes(), &aliasesResponse); err != nil {
		t.Fatalf("failed to decode aliases response: %v", err)
	}
	if len(aliasesResponse.Aliases) != 1 {
		t.Fatalf("expected 1 persisted alias, got %d", len(aliasesResponse.Aliases))
	}

	outboxReq := httptest.NewRequest(http.MethodGet, "/v1/messages/outbox", nil)
	outboxReq.Header.Set("Authorization", "Bearer token-1")
	outboxRec := httptest.NewRecorder()
	reloadedHandler.ServeHTTP(outboxRec, outboxReq)
	if outboxRec.Code != http.StatusOK {
		t.Fatalf("expected outbox status %d, got %d", http.StatusOK, outboxRec.Code)
	}

	var outboxResponse struct {
		Messages []model.MessageRecord `json:"messages"`
	}
	if err := json.Unmarshal(outboxRec.Body.Bytes(), &outboxResponse); err != nil {
		t.Fatalf("failed to decode outbox response: %v", err)
	}
	if len(outboxResponse.Messages) != 1 {
		t.Fatalf("expected 1 persisted outbox message, got %d", len(outboxResponse.Messages))
	}
}

func TestNewHandlerPersistsSubmissionsAndAuditAcrossRebuild(t *testing.T) {
	cfg := config.Config{
		ListenAddr:          ":9090",
		DataDir:             filepath.Join(t.TempDir(), "data"),
		AliasDomain:         "relay.example",
		AuditRetentionHours: 24 * 7,
		MaxRecipients:       5,
		MaxMessageBytes:     1024,
		DevToken:            "token-1",
		DevActor:            model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	handler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("first newHandler() error = %v", err)
	}

	createSubmissionReq := httptest.NewRequest(http.MethodPost, "/v1/submissions", bytes.NewBufferString(`{"channel_id":"channel-1","subject":"Hello","text_body":"Body"}`))
	createSubmissionReq.Header.Set("Authorization", "Bearer token-1")
	createSubmissionReq.Header.Set("Content-Type", "application/json")
	createSubmissionRec := httptest.NewRecorder()
	handler.ServeHTTP(createSubmissionRec, createSubmissionReq)
	if createSubmissionRec.Code != http.StatusCreated {
		t.Fatalf("expected submission created status %d, got %d", http.StatusCreated, createSubmissionRec.Code)
	}

	reloadedHandler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("second newHandler() error = %v", err)
	}

	listSubmissionsReq := httptest.NewRequest(http.MethodGet, "/v1/submissions", nil)
	listSubmissionsReq.Header.Set("Authorization", "Bearer token-1")
	listSubmissionsRec := httptest.NewRecorder()
	reloadedHandler.ServeHTTP(listSubmissionsRec, listSubmissionsReq)
	if listSubmissionsRec.Code != http.StatusOK {
		t.Fatalf("expected submissions status %d, got %d", http.StatusOK, listSubmissionsRec.Code)
	}

	var submissionsResponse struct {
		Submissions []model.Submission `json:"submissions"`
	}
	if err := json.Unmarshal(listSubmissionsRec.Body.Bytes(), &submissionsResponse); err != nil {
		t.Fatalf("failed to decode submissions response: %v", err)
	}
	if len(submissionsResponse.Submissions) != 1 {
		t.Fatalf("expected 1 persisted submission, got %d", len(submissionsResponse.Submissions))
	}

	auditReq := httptest.NewRequest(http.MethodGet, "/v1/audit-events", nil)
	auditReq.Header.Set("Authorization", "Bearer token-1")
	auditRec := httptest.NewRecorder()
	reloadedHandler.ServeHTTP(auditRec, auditReq)
	if auditRec.Code != http.StatusOK {
		t.Fatalf("expected audit status %d, got %d", http.StatusOK, auditRec.Code)
	}

	var auditResponse struct {
		Events []model.AuditEvent `json:"events"`
	}
	if err := json.Unmarshal(auditRec.Body.Bytes(), &auditResponse); err != nil {
		t.Fatalf("failed to decode audit response: %v", err)
	}
	if len(auditResponse.Events) != 1 {
		t.Fatalf("expected 1 persisted audit event, got %d", len(auditResponse.Events))
	}
}

func TestNewHandlerSupportsConfiguredSecureIntake(t *testing.T) {
	cfg := config.Config{
		ListenAddr:          ":9090",
		DataDir:             filepath.Join(t.TempDir(), "data"),
		AliasDomain:         "relay.example",
		AuditRetentionHours: 24 * 7,
		MaxRecipients:       5,
		MaxMessageBytes:     1024,
		DevToken:            "token-1",
		DevActor:            model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
		IntakeToken:         "intake-token",
		IntakeActor:         model.Actor{ID: "intake-1", TenantID: "tenant-1", PrimaryEmail: "intake@example.com"},
	}

	handler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("newHandler() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/intake/submissions", bytes.NewBufferString(`{"channel_id":"secure-web","subject":"Hello","text_body":"Body"}`))
	req.Header.Set("Authorization", "Bearer intake-token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected intake submission created status %d, got %d with body %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var created model.Submission
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode submission: %v", err)
	}
	if created.IntakeChannel != "secure_web_intake" {
		t.Fatalf("expected secure intake channel, got %s", created.IntakeChannel)
	}
	if created.TenantID != "tenant-1" {
		t.Fatalf("expected intake tenant scoping, got %s", created.TenantID)
	}
}

func TestNewRuntimeDependenciesPersistsIdentityLinksAcrossRebuild(t *testing.T) {
	cfg := config.Config{
		ListenAddr:          ":9090",
		DataDir:             filepath.Join(t.TempDir(), "data"),
		AliasDomain:         "relay.example",
		AuditRetentionHours: 24 * 7,
		MaxRecipients:       5,
		MaxMessageBytes:     1024,
		DevToken:            "token-1",
		DevActor:            model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	deps, err := newRuntimeDependencies(cfg)
	if err != nil {
		t.Fatalf("first newRuntimeDependencies() error = %v", err)
	}

	created, err := deps.identityVault.CreateLink(context.Background(), cfg.DevActor, "alias-1", "user@example.com", "support", time.Time{})
	if err != nil {
		t.Fatalf("CreateLink() error = %v", err)
	}

	reloadedDeps, err := newRuntimeDependencies(cfg)
	if err != nil {
		t.Fatalf("second newRuntimeDependencies() error = %v", err)
	}

	stored, err := reloadedDeps.identityVault.GetByAliasID(context.Background(), cfg.DevActor, "alias-1")
	if err != nil {
		t.Fatalf("GetByAliasID() error = %v", err)
	}
	if stored.ID != created.ID {
		t.Fatalf("expected persisted identity link %s, got %s", created.ID, stored.ID)
	}
}

func TestNewHandlerPersistsIMAPCursorStateWhenConfigured(t *testing.T) {
	cfg := config.Config{
		ListenAddr:         ":9090",
		DataDir:            filepath.Join(t.TempDir(), "data"),
		AliasDomain:        "relay.example",
		MaxRecipients:      5,
		MaxMessageBytes:    1024,
		IMAPHost:           "imap.example.com",
		IMAPPort:           993,
		IMAPUsername:       "imap-user",
		IMAPPassword:       "imap-pass",
		IMAPTimeoutSeconds: 10,
		DevToken:           "token-1",
		DevActor:           model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	if _, err := newHandler(cfg); err != nil {
		t.Fatalf("first newHandler() error = %v", err)
	}

	cursorFile := filepath.Join(cfg.DataDir, "imap-sync-state.json")
	cursorStore, err := inbox.NewCursorStore(cursorFile)
	if err != nil {
		t.Fatalf("NewCursorStore() error = %v", err)
	}
	if err := cursorStore.Save(context.Background(), cfg.DevActor, "42"); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	if _, err := newHandler(cfg); err != nil {
		t.Fatalf("second newHandler() error = %v", err)
	}

	reloadedCursorStore, err := inbox.NewCursorStore(cursorFile)
	if err != nil {
		t.Fatalf("reloaded NewCursorStore() error = %v", err)
	}
	cursor, err := reloadedCursorStore.Load(context.Background(), cfg.DevActor)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cursor != "42" {
		t.Fatalf("expected persisted cursor 42, got %q", cursor)
	}
}

func TestNewHandlerBuildsSMTPModeWithoutConnecting(t *testing.T) {
	cfg := config.Config{
		ListenAddr:                ":9090",
		DataDir:                   filepath.Join(t.TempDir(), "data"),
		DeliveryMode:              "smtp",
		AliasDomain:               "relay.example",
		MaxRecipients:             5,
		MaxMessageBytes:           1024,
		SMTPHost:                  "smtp.example.com",
		SMTPPort:                  587,
		SMTPUsername:              "mailer",
		SMTPPassword:              "topsecret",
		SMTPHelloDomain:           "gateway.example.com",
		SMTPRequireSTARTTLS:       true,
		SMTPConnectTimeoutSeconds: 10,
		DevToken:                  "token-1",
		DevActor:                  model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	if _, err := newHandler(cfg); err != nil {
		t.Fatalf("newHandler() error = %v", err)
	}
}

func TestNewHandlerRejectsInvalidSMTPConfig(t *testing.T) {
	cfg := config.Config{
		ListenAddr:                ":9090",
		DataDir:                   filepath.Join(t.TempDir(), "data"),
		DeliveryMode:              "smtp",
		AliasDomain:               "relay.example",
		MaxRecipients:             5,
		MaxMessageBytes:           1024,
		SMTPPort:                  587,
		SMTPRequireSTARTTLS:       true,
		SMTPConnectTimeoutSeconds: 10,
		DevToken:                  "token-1",
		DevActor:                  model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	if _, err := newHandler(cfg); err == nil {
		t.Fatal("expected invalid SMTP config error")
	}
}

func TestNewHandlerRejectsUnsupportedDeliveryMode(t *testing.T) {
	cfg := config.Config{
		ListenAddr:      ":9090",
		DataDir:         filepath.Join(t.TempDir(), "data"),
		DeliveryMode:    "carrier-pigeon",
		AliasDomain:     "relay.example",
		MaxRecipients:   5,
		MaxMessageBytes: 1024,
		DevToken:        "token-1",
		DevActor:        model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	if _, err := newHandler(cfg); err == nil {
		t.Fatal("expected unsupported delivery mode error")
	}
}

func TestNewHandlerRejectsPartialIMAPConfig(t *testing.T) {
	cfg := config.Config{
		ListenAddr:      ":9090",
		DataDir:         filepath.Join(t.TempDir(), "data"),
		DeliveryMode:    "record-only",
		AliasDomain:     "relay.example",
		MaxRecipients:   5,
		MaxMessageBytes: 1024,
		IMAPHost:        "imap.example.com",
		IMAPUsername:    "imap-user",
		DevToken:        "token-1",
		DevActor:        model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	if _, err := newHandler(cfg); !errors.Is(err, inbox.ErrIMAPIncompleteConfig) {
		t.Fatalf("expected ErrIMAPIncompleteConfig, got %v", err)
	}
}

func TestNewHandlerPersistsEncryptedStateWhenKeyConfigured(t *testing.T) {
	cfg := config.Config{
		ListenAddr:           ":9090",
		DataDir:              filepath.Join(t.TempDir(), "data"),
		DataEncryptionKeyB64: base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		DeliveryMode:         "record-only",
		AliasDomain:          "relay.example",
		MaxRecipients:        5,
		MaxMessageBytes:      1024,
		DevToken:             "token-1",
		DevActor:             model.Actor{ID: "user-1", TenantID: "tenant-1", PrimaryEmail: "user@example.com"},
	}

	handler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("newHandler() error = %v", err)
	}

	createAliasReq := httptest.NewRequest(http.MethodPost, "/v1/aliases", bytes.NewBufferString(`{"label":"support"}`))
	createAliasReq.Header.Set("Authorization", "Bearer token-1")
	createAliasReq.Header.Set("Content-Type", "application/json")
	createAliasRec := httptest.NewRecorder()
	handler.ServeHTTP(createAliasRec, createAliasReq)
	if createAliasRec.Code != http.StatusCreated {
		t.Fatalf("expected alias creation status %d, got %d", http.StatusCreated, createAliasRec.Code)
	}

	aliasFile := filepath.Join(cfg.DataDir, "aliases.json")
	raw, err := os.ReadFile(aliasFile)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if bytes.Contains(raw, []byte("support")) {
		t.Fatalf("expected encrypted alias file, got plaintext %q", string(raw))
	}

	reloadedHandler, err := newHandler(cfg)
	if err != nil {
		t.Fatalf("reloaded newHandler() error = %v", err)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/v1/aliases", nil)
	listReq.Header.Set("Authorization", "Bearer token-1")
	listRec := httptest.NewRecorder()
	reloadedHandler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list aliases status %d, got %d", http.StatusOK, listRec.Code)
	}
}

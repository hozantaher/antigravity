package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"privacy-gateway/internal/alias"
	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/auth"
	"privacy-gateway/internal/compat"
	"privacy-gateway/internal/config"
	"privacy-gateway/internal/filestore"
	"privacy-gateway/internal/httpapi"
	"privacy-gateway/internal/identityvault"
	"privacy-gateway/internal/inbox"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/policy"
	"privacy-gateway/internal/relay"
	"privacy-gateway/internal/sanitizer"
	"privacy-gateway/internal/submission"
)

type runtimeDependencies struct {
	authenticator       auth.Authenticator
	intakeAuthenticator auth.Authenticator
	aliasService        *alias.Service
	submissionPolicy    *policy.Service
	gateway             mail.Gateway
	inboxStore          *inbox.Store
	inboxSyncer         inbox.Syncer
	identityVault       *identityvault.Service
	submissionService   *submission.Service
	sanitizerService    *sanitizer.Service
	relayService        *relay.Service
	auditService        *audit.Service
}

func newHandler(cfg config.Config) (http.Handler, error) {
	deps, err := newRuntimeDependencies(cfg)
	if err != nil {
		return nil, err
	}

	server := httpapi.NewServer(
		deps.authenticator,
		deps.aliasService,
		deps.submissionPolicy,
		deps.submissionService,
		deps.auditService,
		deps.identityVault,
		deps.gateway,
		deps.inboxStore,
		deps.inboxSyncer,
		int64(cfg.MaxMessageBytes+32*1024),
	).WithRelayService(deps.relayService).
		WithIntakeAuthenticator(deps.intakeAuthenticator)
	return server.Handler(), nil
}

func newRuntimeDependencies(cfg config.Config) (*runtimeDependencies, error) {
	codec, err := newStorageCodec(cfg)
	if err != nil {
		return nil, err
	}

	repo, err := alias.NewFileRepositoryWithCodec(filepath.Join(cfg.DataDir, "aliases.json"), codec)
	if err != nil {
		return nil, err
	}
	inboxStore, err := inbox.NewStoreWithCodecAndRetention(
		filepath.Join(cfg.DataDir, "inbox.json"),
		codec,
		time.Duration(cfg.InboxRetentionHours)*time.Hour,
	)
	if err != nil {
		return nil, err
	}
	cursorStore, err := inbox.NewCursorStoreWithCodecAndRetention(
		filepath.Join(cfg.DataDir, "imap-sync-state.json"),
		codec,
		time.Duration(cfg.IMAPCursorRetentionHours)*time.Hour,
	)
	if err != nil {
		return nil, err
	}
	aliasService := alias.NewServiceWithRetention(repo, cfg.AliasDomain, time.Duration(cfg.AliasRetentionHours)*time.Hour)
	baseGateway, err := newGateway(cfg)
	if err != nil {
		return nil, err
	}
	submissionRepo, err := submission.NewFileRepositoryWithCodec(filepath.Join(cfg.DataDir, "submissions.json"), codec)
	if err != nil {
		return nil, err
	}
	identityVaultRepo, err := identityvault.NewFileRepositoryWithCodec(filepath.Join(cfg.DataDir, "identity-links.json"), codec)
	if err != nil {
		return nil, err
	}
	auditStore, err := audit.NewFileStoreWithCodec(filepath.Join(cfg.DataDir, "audit-events.json"), codec)
	if err != nil {
		return nil, err
	}
	relayRepo, err := relay.NewFileRepositoryWithCodec(filepath.Join(cfg.DataDir, "relay-attempts.json"), codec)
	if err != nil {
		return nil, err
	}
	sanitizerService := sanitizer.NewService()
	relayService := relay.NewServiceWithRetention(baseGateway, strings.ToLower(strings.TrimSpace(cfg.DeliveryMode)), relayRepo, time.Duration(cfg.RelayAttemptRetentionHours)*time.Hour)
	auditService := audit.NewServiceWithRetention(auditStore, time.Duration(cfg.AuditRetentionHours)*time.Hour)
	identityVaultService := identityvault.NewServiceWithRetention(identityVaultRepo, time.Duration(cfg.IdentityLinkRetentionHours)*time.Hour)
	submissionService := submission.NewWorkflowServiceWithRetention(
		submissionRepo,
		sanitizerService,
		auditService,
		time.Duration(cfg.SubmissionRetentionHours)*time.Hour,
	)
	inboxSyncer, err := newInboxSyncerWithResolver(cfg, inboxStore, cursorStore, aliasService, submissionService)
	if err != nil && !errors.Is(err, inbox.ErrIMAPNotConfigured) {
		return nil, err
	}
	if errors.Is(err, inbox.ErrIMAPNotConfigured) {
		inboxSyncer = nil
	}
	gateway := compat.NewMessagesGateway(submissionService, sanitizerService, relayService, auditService)
	submission := policy.NewService(aliasService, gateway, cfg.MaxRecipients, cfg.MaxMessageBytes)
	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		cfg.DevToken: cfg.DevActor,
	})
	var intakeAuthenticator auth.Authenticator
	if strings.TrimSpace(cfg.IntakeToken) != "" {
		intakeAuthenticator = auth.NewStaticTokenAuthenticator(map[string]model.Actor{
			cfg.IntakeToken: cfg.IntakeActor,
		})
	}

	return &runtimeDependencies{
		authenticator:       authenticator,
		intakeAuthenticator: intakeAuthenticator,
		aliasService:        aliasService,
		submissionPolicy:    submission,
		gateway:             gateway,
		inboxStore:          inboxStore,
		inboxSyncer:         inboxSyncer,
		identityVault:       identityVaultService,
		submissionService:   submissionService,
		sanitizerService:    sanitizerService,
		relayService:        relayService,
		auditService:        auditService,
	}, nil
}

func newGateway(cfg config.Config) (mail.Gateway, error) {
	codec, err := newStorageCodec(cfg)
	if err != nil {
		return nil, err
	}

	recordStore, err := mail.NewPersistentRecordedGatewayWithCodecAndRetention(
		filepath.Join(cfg.DataDir, "outbox.json"),
		codec,
		time.Duration(cfg.OutboxRetentionHours)*time.Hour,
	)
	if err != nil {
		return nil, err
	}

	switch strings.ToLower(strings.TrimSpace(cfg.DeliveryMode)) {
	case "", "record-only":
		return recordStore, nil
	case "smtp":
		return mail.NewSMTPGateway(recordStore, mail.SMTPSettings{
			Host:            cfg.SMTPHost,
			Port:            cfg.SMTPPort,
			Username:        cfg.SMTPUsername,
			Password:        cfg.SMTPPassword,
			HelloDomain:     cfg.SMTPHelloDomain,
			RequireSTARTTLS: cfg.SMTPRequireSTARTTLS,
			ConnectTimeout:  time.Duration(cfg.SMTPConnectTimeoutSeconds) * time.Second,
		})
	default:
		return nil, errors.New("unsupported delivery mode: " + cfg.DeliveryMode)
	}
}

func newStorageCodec(cfg config.Config) (filestore.Codec, error) {
	return filestore.NewCodecFromBase64(strings.TrimSpace(cfg.DataEncryptionKeyB64))
}

func newInboxSyncer(cfg config.Config, store *inbox.Store, cursors *inbox.CursorStore) (inbox.Syncer, error) {
	syncer, err := inbox.NewIMAPSyncer(inbox.IMAPSyncConfig{
		Port:     cfg.IMAPPort,
		Host:     cfg.IMAPHost,
		Username: cfg.IMAPUsername,
		Password: cfg.IMAPPassword,
		Timeout:  time.Duration(cfg.IMAPTimeoutSeconds) * time.Second,
	}, store, cursors)
	if err != nil {
		return nil, err
	}
	return syncer, nil
}

func newInboxSyncerWithResolver(cfg config.Config, store *inbox.Store, cursors *inbox.CursorStore, aliases *alias.Service, submissions *submission.Service) (inbox.Syncer, error) {
	syncer, err := newInboxSyncer(cfg, store, cursors)
	if err != nil {
		return nil, err
	}
	imapSyncer, ok := syncer.(*inbox.IMAPSyncer)
	if !ok {
		return syncer, nil
	}
	return imapSyncer.WithResolver(inbox.NewContextResolver(aliases, submissions)), nil
}

func newHTTPServer(cfg config.Config) (*http.Server, error) {
	handler, err := newHandler(cfg)
	if err != nil {
		return nil, err
	}

	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}, nil
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg := config.Load()
	httpServer, err := newHTTPServer(cfg)
	if err != nil {
		slog.Error("failed to create server", "error", err)
		os.Exit(1)
	}

	go func() {
		<-ctx.Done()
		slog.Info("shutting down gracefully")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown error", "error", err)
		}
	}()

	slog.Info("privacy gateway started",
		"addr", cfg.ListenAddr,
		"alias_domain", cfg.AliasDomain,
		"data_dir", cfg.DataDir,
		"delivery_mode", cfg.DeliveryMode,
	)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
	slog.Info("server stopped")
}

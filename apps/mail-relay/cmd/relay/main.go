package main

import (
	"common/envconfig"
	"common/telemetry"

	"relay/internal/abuse"
	"relay/internal/audit"
	"relay/internal/intake/auth"
	"relay/internal/boundary"
	"relay/internal/transport/bridge"
	"relay/internal/config"
	"relay/internal/transport/constrate"
	"relay/internal/delivery/contentenc"
	"relay/internal/deaddrop"
	"relay/internal/transport/decoy"
	"relay/internal/delivery"
	"relay/internal/filestore"
	"relay/web"
	"relay/internal/identity"
	"relay/internal/intake"
	"relay/internal/transport/metamin"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/msgbus"
	"relay/internal/transport/onion"
	"relay/internal/transport/pool"
	"relay/internal/relay"
	"relay/internal/delivery/sanitizer"
	"relay/internal/transport/traffic"
	"relay/internal/transport"
	"relay/internal/transport/wgpool"
	"relay/internal/vault"
	"relay/internal/transport/vpn"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"
)

func main() {
	// Load secrets file before config (env vars take precedence)
	if secretsFile := envconfig.GetOr("SECRETS_FILE", ""); secretsFile != "" {
		if err := config.LoadAndApplySecretsFile(secretsFile); err != nil {
			log.Fatalf("failed to load secrets file: %v", err)
		}
	}

	// Initialise Sentry — no-op when SENTRY_DSN_GO is unset.
	if err := telemetry.Init("relay"); err != nil {
		log.Printf("sentry init failed: %v", err)
	}
	defer telemetry.Flush()

	cfg := loadConfig()
	logger := minlog.New("anti-trace-relay")

	// --- SECURITY: Disable core dumps to prevent key leakage ---
	disableCoreDumps(logger)

	// --- SECURITY: Require encryption keys ---
	if strings.TrimSpace(cfg.dataEncryptionKey) == "" {
		logger.Error("DATA_ENCRYPTION_KEY_B64 is required. Generate with: head -c 32 /dev/urandom | base64")
		os.Exit(1)
	}
	if strings.TrimSpace(cfg.vaultEncryptionKey) == "" {
		logger.Error("VAULT_ENCRYPTION_KEY_B64 is required. Generate with: head -c 32 /dev/urandom | base64")
		os.Exit(1)
	}

	// --- SECURITY: Require explicit API token ---
	if strings.TrimSpace(cfg.devToken) == "" {
		logger.Error("DEV_API_TOKEN is required. Do not use a guessable value.")
		os.Exit(1)
	}

	// --- SECURITY: Require TLS unless behind a reverse proxy (Railway, Fly.io, etc.) ---
	if !cfg.plainHTTP && (cfg.tlsCertFile == "" || cfg.tlsKeyFile == "") {
		logger.Error("TLS_CERT_FILE and TLS_KEY_FILE are required. Set PLAIN_HTTP=true if behind a TLS-terminating proxy.")
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.dataDir, 0700); err != nil {
		logger.Error("failed to create data directory", minlog.F("error", err.Error()))
		os.Exit(1)
	}

	dataCodec, err := filestore.NewCodecFromBase64(cfg.dataEncryptionKey)
	if err != nil {
		logger.Error("invalid data encryption key", minlog.F("error", err.Error()))
		os.Exit(1)
	}

	vaultService, err := vault.NewFileVault(
		filepath.Join(cfg.dataDir, "vault-mappings.json"),
		cfg.vaultEncryptionKey,
		time.Duration(cfg.vaultRetentionHours)*time.Hour,
	)
	if err != nil {
		logger.Error("failed to initialize vault", minlog.F("error", err.Error()))
		os.Exit(1)
	}

	identityService := identity.NewService(vaultService)
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup

	sanitizerService := sanitizer.NewService()
	minimizer := metamin.NewMinimizer()
	sealer := contentenc.NewSealer()
	bus := msgbus.NewChannelBus(128)
	limiter := abuse.NewLimiter(cfg.rateLimitPerMinute)

	auditService, err := audit.NewService(
		filepath.Join(cfg.dataDir, "audit-events.json"),
		dataCodec,
		time.Duration(cfg.auditRetentionHours)*time.Hour,
	)
	if err != nil {
		logger.Error("failed to initialize audit", minlog.F("error", err.Error()))
		os.Exit(1)
	}

	scheduler, err := relay.NewScheduler(
		filepath.Join(cfg.dataDir, "relay-queue.json"),
		dataCodec,
		time.Duration(cfg.relayMinDelay)*time.Second,
		time.Duration(cfg.relayMaxDelay)*time.Second,
		time.Duration(cfg.relayRetentionHours)*time.Hour,
	)
	if err != nil {
		logger.Error("failed to initialize relay scheduler", minlog.F("error", err.Error()))
		os.Exit(1)
	}

	exitVerifier, err := boundary.NewExitVerifier(
		filepath.Join(cfg.dataDir, "exit-channels.json"),
		dataCodec,
	)
	if err != nil {
		logger.Error("failed to initialize exit verifier", minlog.F("error", err.Error()))
		os.Exit(1)
	}

	// --- Tor hidden service manager ---
	var torManager *onion.Manager
	torSocksAddr := cfg.socksProxyAddr
	if cfg.torEnabled {
		torCfg := onion.Config{
			DataDir:    filepath.Join(cfg.dataDir, "tor"),
			SocksPort:  cfg.torSocksPort,
			HiddenPort: cfg.torHiddenPort,
			TargetAddr: cfg.onionListenAddr,
			TorBinary:  cfg.torBinary,
		}
		var err error
		torManager, err = onion.NewManager(torCfg, logger)
		if err != nil {
			logger.Error("failed to initialize tor", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		if err := torManager.Start(ctx); err != nil {
			logger.Error("failed to start tor", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		readyCtx, readyCancel := context.WithTimeout(ctx, 120*time.Second)
		if err := torManager.WaitReady(readyCtx); err != nil {
			readyCancel()
			logger.Error("tor failed to become ready", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		readyCancel()
		// Only override torSocksAddr when SOCKS_PROXY_ADDR env wasn't explicitly
		// set. With wireproxy mounted on 127.0.0.1:1080 (TRANSPORT_MODE=tor +
		// SOCKS_PROXY_ADDR=127.0.0.1:1080), the operator wants outbound to
		// route through wireproxy, not the embedded Tor SOCKS — even though
		// the hidden service still uses Tor for inbound.
		if cfg.socksProxyAddr == "" {
			torSocksAddr = torManager.SocksAddr()
		}
		logger.Info("tor_hidden_service",
			minlog.F("onion", torManager.OnionAddress()),
		)
	}

	// --- VPN manager ---
	var vpnManager *vpn.Manager
	var vpnTransport transport.AnonymousTransport
	if cfg.vpnEnabled {
		vpnCfg := vpn.WireGuardConfig{
			PrivateKey:          cfg.vpnPrivateKey,
			Address:             cfg.vpnAddress,
			DNS:                 cfg.vpnDNS,
			PeerPublicKey:       cfg.vpnPeerPublicKey,
			PeerEndpoint:        cfg.vpnPeerEndpoint,
			AllowedIPs:          cfg.vpnAllowedIPs,
			PresharedKey:        cfg.vpnPresharedKey,
			PersistentKeepalive: cfg.vpnKeepalive,
			InterfaceName:       "wg-atr0",
			DataDir:             filepath.Join(cfg.dataDir, "vpn"),
		}
		var err error
		vpnManager, err = vpn.NewManager(vpnCfg, logger)
		if err != nil {
			logger.Error("failed to initialize vpn", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		if err := vpnManager.Start(ctx); err != nil {
			logger.Error("failed to start vpn", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		vpnTransport = vpnManager.Transport()
	}

	// --- WireGuard endpoint pool (multi-Mullvad rotation) ---
	// When WIREPROXY_POOL_CONFIG is set the entrypoint script has already
	// spawned N userspace WG-SOCKS bridges on 127.0.0.1:108x. Construct
	// the in-process Pool that picks one per envelope and let BuildChain
	// see "wgpool" mode so the resulting AnonymousTransport routes via it.
	var wgPool *wgpool.Pool
	if cfg.wireproxyPoolConfig != "" {
		eps, parseErr := wgpool.ParseConfig(cfg.wireproxyPoolConfig)
		if parseErr != nil {
			logger.Error("wgpool_parse_failed", minlog.F("error", parseErr.Error()))
			os.Exit(1)
		}
		// Auto-fill socks_addr from index using the same 127.0.0.1:108${i}
		// pattern entrypoint.sh emits — keeps the JSON payload compact.
		for i := range eps {
			if eps[i].SocksAddr == "" {
				if i > 9 {
					logger.Error("wgpool_index_overflow", minlog.F("index", fmt.Sprintf("%d", i)))
					os.Exit(1)
				}
				eps[i].SocksAddr = fmt.Sprintf("127.0.0.1:%d", 1080+i)
			}
		}
		var poolErr error
		wgPool, poolErr = wgpool.New(eps, wgpool.Config{
			AffinityEnabled: cfg.wireproxyAffinity,
		})
		if poolErr != nil {
			logger.Error("wgpool_init_failed", minlog.F("error", poolErr.Error()))
			os.Exit(1)
		}
		logger.Info("wgpool_initialized",
			minlog.F("size", fmt.Sprintf("%d", wgPool.Size())),
			minlog.F("affinity", fmt.Sprintf("%t", cfg.wireproxyAffinity)),
		)
	}

	// --- Transport chain (supports: socks5, wgpool, vpn, vpn+tor — "direct" + "proxy" forbidden) ---
	transportSelector := cfg.transportMode
	var poolTransport transport.AnonymousTransport
	if wgPool != nil && transportSelector != "wgpool" && transportSelector != "direct" {
		// Auto-upgrade rather than silently single-endpoint. "direct" is
		// excluded so the operator's explicit ALLOW_DIRECT_EGRESS opt-in
		// (2026-05-12 deliverability decision) survives the pool config
		// staying in env. Without this skip the wgpool config would silently
		// re-attach and Mullvad CZ exit IPs would resume leaking into the
		// SMTP Received chain, defeating the Gmail anti-VPN workaround.
		logger.Info("wgpool_auto_upgrade", minlog.F("from_mode", transportSelector))
		transportSelector = "wgpool"
	}
	if transportSelector == "wgpool" {
		if wgPool == nil {
			logger.Error("wgpool_mode_without_config")
			os.Exit(1)
		}
		poolTransport = wgpool.NewTransport(wgPool, 60*time.Second)
	}
	injectedTransport := vpnTransport
	if poolTransport != nil {
		injectedTransport = poolTransport
	}
	anonTransport, err := transport.BuildChain(transportSelector, torSocksAddr, injectedTransport)
	if err != nil {
		logger.Error("failed to build transport chain", minlog.F("error", err.Error()))
		os.Exit(1)
	}
	logger.Info("transport_chain", minlog.F("mode", transportSelector))

	// --- R7: runtime dial guard (belt-and-suspenders egress assertion) ---
	// When the rotating proxy pool is active, attach a DialGuard so every
	// outbound dial asserts the target is in the working pool. Refuses
	// direct egress (e.g. smtp.seznam.cz:465) and emits a
	// DIRECT_EGRESS_ATTEMPT alert.
	rotatingProxy, _ := anonTransport.(*transport.RotatingProxyTransport)
	if rotatingProxy != nil {
		guard := transport.NewDialGuard(rotatingProxy, nil, nil)
		rotatingProxy.AttachGuard(guard)
		logger.Info("dial_guard_attached", minlog.F("transport", "rotating_proxy"))
	}

	// --- Delivery ---
	smtpBaseCfg := delivery.SMTPConfig{
		Host:        cfg.smtpHost,
		Port:        cfg.smtpPort,
		Username:    cfg.smtpUsername,
		Password:    cfg.smtpPassword,
		HelloDomain: cfg.smtpHelloDomain,
		RequireTLS:  cfg.smtpRequireTLS,
	}
	deliverer := delivery.NewDeliverer(cfg.deliveryMode, anonTransport, smtpBaseCfg)

	// Build multi-account pool when accounts are configured.
	var accountPool *delivery.AccountPool
	if len(cfg.smtpAccounts) > 0 {
		accounts := make([]delivery.SMTPAccount, len(cfg.smtpAccounts))
		for i, a := range cfg.smtpAccounts {
			accounts[i] = delivery.SMTPAccount{Address: a.Address, Password: a.Password}
		}
		accountPool = delivery.NewAccountPool(anonTransport, smtpBaseCfg, accounts, deliverer)
		logger.Info("smtp_account_pool", minlog.F("accounts", fmt.Sprintf("%d", len(accounts))))
	}

	// --- Dead drop store ---
	deadDropStore := deaddrop.NewStore(deaddrop.Config{
		TTL:            time.Duration(cfg.deadDropTTLHours) * time.Hour,
		MaxSlotSize:    cfg.deadDropMaxSlotSize,
		MaxPayloadSize: cfg.deadDropMaxPayloadBytes,
	})

	// --- Mix pool (persistent if configured) ---
	var mixPool interface {
		Submit(env model.Envelope)
		Draw() (model.Envelope, bool)
		Requeue(env model.Envelope)
		Size() int
	}
	if cfg.poolPersistPath != "" {
		pp, err := pool.NewPersistentPool(cfg.mixPoolMinSize, filepath.Join(cfg.dataDir, cfg.poolPersistPath), dataCodec)
		if err != nil {
			logger.Error("failed to initialize persistent pool", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		mixPool = pp
		logger.Info("pool_persistent", minlog.F("path", cfg.poolPersistPath))
	} else {
		mixPool = pool.NewMixPool(cfg.mixPoolMinSize)
	}

	// --- Bridge to privacy-gateway ---
	var gatewayBridge *bridge.PrivacyGatewayBridge
	if cfg.bridgeGatewayURL != "" {
		gatewayBridge = bridge.NewPrivacyGatewayBridge(bridge.BridgeConfig{
			GatewayURL: cfg.bridgeGatewayURL,
			Token:      cfg.bridgeGatewayToken,
		}, logger)
		logger.Info("bridge_configured", minlog.F("gateway", cfg.bridgeGatewayURL))
	}

	pipeline := intake.NewPipeline(
		sanitizerService,
		identityService,
		minimizer,
		sealer,
		bus,
		auditService,
		limiter,
		logger,
	)

	authenticator := auth.NewStaticTokenAuthenticator(map[string]model.Actor{
		cfg.devToken: {ID: cfg.devUserID, TenantID: cfg.devTenantID},
	})

	server := web.NewServer(
		authenticator,
		pipeline,
		scheduler,
		auditService,
		vaultService,
		exitVerifier,
		limiter,
	).WithDeadDrop(deadDropStore).
		WithDeliveryMode(cfg.deliveryMode).
		WithVerifyEnabled(envconfig.BoolOr("VERIFY_EMAIL_ENABLED", false))

	if gatewayBridge != nil {
		server = server.WithBridge(gatewayBridge, cfg.deliveryMode)
	}

	if rotatingProxy != nil {
		server = server.
			WithProxyPool(rotatingProxy).
			WithProxyRefresher(rotatingProxy)
		logger.Info("proxy_pool_wired", minlog.F("transport", "rotating_proxy"))
	} else if cfg.socksProxyAddr != "" {
		// Mullvad-only path: no rotating pool. Probe handlers fall back to
		// dialing through SOCKS_PROXY_ADDR (wireproxy on 127.0.0.1:1080).
		server = server.WithFallbackProxyAddr(cfg.socksProxyAddr)
		logger.Info("probe_fallback_wired")
	}
	// Multi-endpoint pool: wire to web server so /v1/proxy-pool returns
	// real per-endpoint health (replaces synthetic data the BFF used to fabricate).
	if wgPool != nil {
		server = server.WithWGPool(wgPool)
		logger.Info("wgpool_wired_to_server")

		// AP4-P1: time-driven ring buffer pressure monitor. Fires Sentry alerts on a
		// 60s wall-clock tick regardless of whether the BFF /v1/egress-debug cron is
		// running. Replaces the handler-coupled alert path in web/egress_debug.go.
		wgPool.StartHealthMonitor(ctx, 60*time.Second, func(evictCount int64, fillPct, size, cap, hw int) {
			if evictCount > 0 {
				telemetry.CaptureAlert(
					fmt.Sprintf("egress_obs ring buffer eviction: evict_count=%d — BFF drain cron is behind", evictCount),
					telemetry.AlertTags{
						Alert: "egress_obs_ring_evict",
						Extras: map[string]any{
							"evict_count":            evictCount,
							"ring_buffer_size":       size,
							"ring_buffer_cap":        cap,
							"ring_buffer_high_water": hw,
						},
					},
				)
			} else if fillPct >= wgpool.RingBufferAlertThreshold {
				telemetry.CaptureAlert(
					fmt.Sprintf("egress_obs ring buffer at %d%% capacity — drain cron may be lagging", fillPct),
					telemetry.AlertTags{
						Alert: "egress_obs_ring_high_water",
						Extras: map[string]any{
							"ring_buffer_fill_pct": fillPct,
							"ring_buffer_size":     size,
							"ring_buffer_cap":      cap,
						},
					},
				)
			}
		})
		logger.Info("wgpool_health_monitor_started", minlog.F("interval_s", "60"))
	}

	if envconfig.BoolOr("VERIFY_EMAIL_ENABLED", false) {
		server = server.WithVerifyEnabled(true)
		logger.Info("verify_email_enabled", minlog.F("op", "main/verify_gate"))
	}

	httpServer := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           web.SecurityHeadersMiddleware(server.Handler()),
		ReadHeaderTimeout: 5 * time.Second,
	}
	if !cfg.plainHTTP {
		httpServer.TLSConfig = &tls.Config{
			MinVersion:       tls.VersionTLS13,
			CurvePreferences: []tls.CurveID{tls.X25519},
		}
	}

	// --- Onion hidden service listener (separate, plain HTTP for .onion) ---
	if cfg.onionListenAddr != "" {
		onionListener, err := net.Listen("tcp", cfg.onionListenAddr)
		if err != nil {
			logger.Error("failed to bind onion listener", minlog.F("error", err.Error()))
			os.Exit(1)
		}
		onionHandler := web.WithIntakeChannel(server.Handler(), "onion")
		onionServer := &http.Server{
			Handler:           web.SecurityHeadersMiddleware(onionHandler),
			ReadHeaderTimeout: 5 * time.Second,
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			logger.Info("onion_listener_started", minlog.F("listen", cfg.onionListenAddr))
			if err := onionServer.Serve(onionListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Error("onion_server_error")
			}
		}()
		go func() {
			<-ctx.Done()
			shutdownCtx, c := context.WithTimeout(context.Background(), 5*time.Second)
			defer c()
			if err := onionServer.Shutdown(shutdownCtx); err != nil {
				logger.Error("onion_server_shutdown_error", minlog.F("error", err.Error()))
			}
		}()
	}

	// --- Subscribe to sealed envelopes ---
	sealedCh := bus.Subscribe(msgbus.TopicSealed)
	wg.Add(1)
	go func() {
		defer wg.Done()
		runSealedSubscriberLoop(ctx, sealedCh, cfg.deliveryMode, mixPool, scheduler, auditService, logger)
	}()

	// --- Delivery engine (two modes) ---
	if strings.EqualFold(cfg.deliveryMode, "deaddrop") {
		// ADR-002: Constant-rate emitter + pool mixing + dead drop delivery
		decoyPoster := decoy.NewPoster(deadDropStore, cfg.decoyRatio)
		emitterSender := &deadDropSender{
			store:  deadDropStore,
			poster: decoyPoster,
			audit:  auditService,
			logger: logger,
		}
		emitter := constrate.NewEmitter(
			time.Duration(cfg.emissionIntervalSeconds)*time.Second,
			mixPool,
			emitterSender,
			logger,
		)
		wg.Add(1)
		go func() {
			defer wg.Done()
			emitter.Run(ctx)
		}()
		logger.Info("constrate_emitter_started",
			minlog.F("interval_s", fmt.Sprintf("%d", cfg.emissionIntervalSeconds)),
			minlog.F("pool_min", fmt.Sprintf("%d", cfg.mixPoolMinSize)),
		)

		// Periodic dead drop GC
		wg.Add(1)
		go func() {
			defer wg.Done()
			runDeadDropGCLoop(ctx, deadDropStore, time.Hour)
		}()
	} else {
		// ADR-001 legacy: Batch drain with jitter
		coverGen := traffic.NewCoverGenerator()
		drainer := traffic.NewBatchDrainer(scheduler, coverGen, cfg.coverTrafficRatio)
		wg.Add(1)
		envCfg := drainEnvelopeConfig{
				deliveryMode:    cfg.deliveryMode,
				smtpUsername:    cfg.smtpUsername,
				smtpHelloDomain: cfg.smtpHelloDomain,
				smtpBaseCfg:     smtpBaseCfg,
				anonTransport:   anonTransport,
				// Sprint AW7-5: greylist auto-retry for 4xx transient SMTP
				// failures. Defaults to 3 attempts / 5m,15m,60m backoff.
				// Operator overrides via RELAY_GREYLIST_RETRY_* env vars.
				retryCfg: delivery.LoadRetryConfigFromEnv(),
				nowFn:    time.Now,
			}
			logger.Info("drain_retry_config",
				minlog.F("enabled", fmt.Sprintf("%v", envCfg.retryCfg.Enabled)),
				minlog.F("max_attempts", fmt.Sprintf("%d", envCfg.retryCfg.MaxAttempts)),
				minlog.F("backoff_steps", fmt.Sprintf("%d", len(envCfg.retryCfg.Backoff))),
			)
			// AP2: wire pool pin setter when wgPool is available.
			// AP4: wire egress chaos observation callback when wgPool is available.
			if wgPool != nil {
				envCfg.setPinFn = wgPool.SetPin
				envCfg.egressObserverFn = wgPool.RecordEgressObservation
			}
			// Convert *AccountPool typed-nil to a TRUE-nil drainAccountPool interface
			// when no pool is configured. Otherwise the interface holds a typed-nil
			// pointer, `pool != nil` lies and method calls panic at the call site.
			var poolArg drainAccountPool
			if accountPool != nil {
				poolArg = accountPool
			}
			go func() {
				defer wg.Done()
				runDrainLoop(ctx, drainer, envCfg, scheduler, exitVerifier, deliverer, poolArg, gatewayBridge, minimizer, auditService, logger, time.Duration(cfg.batchInterval)*time.Second)
			}()
	}

	// --- Periodic limiter cleanup ---
	wg.Add(1)
	go func() {
		defer wg.Done()
		runLimiterCleanupLoop(ctx, limiter, 5*time.Minute)
	}()

	// --- H4.2: Sentry alert on stuck relay queue ---
	// Fires when the oldest pending envelope age exceeds 10 minutes.
	// No-op when SENTRY_DSN_GO is unset.
	go runQueueStuckAlert(ctx, scheduler, logger)

	// --- Graceful shutdown ---
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting_down")
		cancel()
		bus.Close()

		// Stop Tor and VPN
		if torManager != nil {
			torManager.Stop()
		}
		if vpnManager != nil {
			vpnManager.Stop()
		}

		// Wait for in-flight goroutines before stopping HTTP
		done := make(chan struct{})
		go func() {
			wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			logger.Error("shutdown_timeout")
		}

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			logger.Error("http_server_shutdown_error", minlog.F("error", err.Error()))
		}
	}()

	logger.Info("starting",
		minlog.F("listen", cfg.listenAddr),
		minlog.F("mode", cfg.deliveryMode),
		minlog.F("data_dir", cfg.dataDir),
	)
	var listenErr error
	if cfg.plainHTTP {
		logger.Info("plain_http_mode")
		listenErr = httpServer.ListenAndServe()
	} else {
		listenErr = httpServer.ListenAndServeTLS(cfg.tlsCertFile, cfg.tlsKeyFile)
	}
	if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
		logger.Error("server error", minlog.F("error", listenErr.Error()))
		os.Exit(1)
	}
	logger.Info("stopped")
}

type appConfig struct {
	listenAddr         string
	onionListenAddr    string
	dataDir            string
	dataEncryptionKey  string
	vaultEncryptionKey string
	deliveryMode       string
	relayMinDelay      int
	relayMaxDelay      int
	batchInterval      int
	coverTrafficRatio  float64
	rateLimitPerMinute int
	auditRetentionHours int
	vaultRetentionHours int
	relayRetentionHours int
	devToken           string
	devUserID          string
	devTenantID        string
	tlsCertFile        string
	tlsKeyFile         string
	plainHTTP          bool
	socksProxyAddr     string
	smtpHost           string
	smtpPort           int
	smtpUsername       string
	smtpPassword       string
	smtpHelloDomain    string
	smtpRequireTLS     bool
	smtpAccounts       []config.SMTPAccountConfig // multi-account pool

	// Transport mode: "proxy", "tor", "vpn", "vpn+tor" — "direct" is forbidden (leaks egress IP)
	transportMode string

	// Tor hidden service
	torEnabled    bool
	torSocksPort  int
	torHiddenPort int
	torBinary     string

	// Constant-rate emission + pool mixing
	emissionIntervalSeconds int
	mixPoolMinSize          int

	// Dead drop
	deadDropTTLHours       int
	deadDropMaxSlotSize    int
	deadDropMaxPayloadBytes int
	decoyRatio              int

	// Persistent pool
	poolPersistPath string

	// Bridge to privacy-gateway
	bridgeGatewayURL   string
	bridgeGatewayToken string

	// WireGuard VPN
	vpnEnabled       bool
	vpnPrivateKey    string
	vpnAddress       string
	vpnDNS           string
	vpnPeerPublicKey string
	vpnPeerEndpoint  string
	vpnAllowedIPs    string
	vpnPresharedKey  string
	vpnKeepalive     int

	// Multi-endpoint Mullvad pool (per-envelope rotation). When set, the
	// entrypoint script has spawned N userspace WG-SOCKS bridges on
	// 127.0.0.1:108x; this struct echoes the same JSON so the relay can
	// route each envelope through wgpool.Pool.
	wireproxyPoolConfig string
	wireproxyAffinity   bool
}

func loadConfig() appConfig {
	return appConfig{
		listenAddr:          resolveListenAddr(),
		onionListenAddr:    envconfig.GetOr("ONION_LISTEN_ADDR", ""),
		dataDir:            envconfig.GetOr("DATA_DIR", "./data"),
		dataEncryptionKey:  envconfig.GetOr("DATA_ENCRYPTION_KEY_B64", ""),
		vaultEncryptionKey: envconfig.GetOr("VAULT_ENCRYPTION_KEY_B64", ""),
		deliveryMode:       envconfig.GetOr("DELIVERY_MODE", "record-only"),
		relayMinDelay:      envIntOr("RELAY_MIN_DELAY_SECONDS", 30),
		relayMaxDelay:      envIntOr("RELAY_MAX_DELAY_SECONDS", 300),
		batchInterval:      envIntOr("BATCH_INTERVAL_SECONDS", 60),
		coverTrafficRatio:  0.3,
		rateLimitPerMinute: envIntOr("RATE_LIMIT_PER_MINUTE", 10),
		auditRetentionHours: envIntOr("AUDIT_RETENTION_HOURS", 72),
		vaultRetentionHours: envIntOr("VAULT_RETENTION_HOURS", 0),
		relayRetentionHours: envIntOr("RELAY_RETENTION_HOURS", 24),
		devToken:           envconfig.GetOr("DEV_API_TOKEN", ""), // No default -- must be set explicitly
		devUserID:          envconfig.GetOr("DEV_USER_ID", ""),
		devTenantID:        envconfig.GetOr("DEV_TENANT_ID", ""),
		tlsCertFile:        envconfig.GetOr("TLS_CERT_FILE", ""),
		tlsKeyFile:         envconfig.GetOr("TLS_KEY_FILE", ""),
		plainHTTP:          envconfig.BoolOr("PLAIN_HTTP", false),
		socksProxyAddr:     envconfig.GetOr("SOCKS_PROXY_ADDR", ""), // e.g. "127.0.0.1:9050" for Tor
		smtpHost:           envconfig.GetOr("SMTP_HOST", ""),
		smtpPort:           envIntOr("SMTP_PORT", 587),
		smtpUsername:       envconfig.GetOr("SMTP_USERNAME", ""),
		smtpPassword:       envconfig.GetOr("SMTP_PASSWORD", ""),
		smtpHelloDomain:    envconfig.GetOr("SMTP_HELLO_DOMAIN", ""),
		smtpRequireTLS:     envconfig.BoolOr("SMTP_REQUIRE_STARTTLS", true),
		smtpAccounts:       config.Load().SMTPAccounts,

		// Constant-rate + pool
		emissionIntervalSeconds: envIntOr("EMISSION_INTERVAL_SECONDS", 5),
		mixPoolMinSize:          envIntOr("MIX_POOL_MIN_SIZE", 20),

		// Dead drop
		deadDropTTLHours:        envIntOr("DEAD_DROP_TTL_HOURS", 24),
		deadDropMaxSlotSize:     envIntOr("DEAD_DROP_MAX_SLOT_SIZE", 100),
		deadDropMaxPayloadBytes: envIntOr("DEAD_DROP_MAX_PAYLOAD_BYTES", 65536),
		decoyRatio:              envIntOr("DECOY_RATIO", 3),
		poolPersistPath:         envconfig.GetOr("POOL_PERSIST_PATH", ""),

		// Bridge
		bridgeGatewayURL:   envconfig.GetOr("BRIDGE_GATEWAY_URL", ""),   // e.g. "http://127.0.0.1:8081"
		bridgeGatewayToken: envconfig.GetOr("BRIDGE_GATEWAY_TOKEN", ""), // privacy-gateway intake token

		// Transport — "direct" leaks egress IP and is forbidden. "proxy" (free
		// rotating pool) is retired (Seznam/Czech recipients reject free-proxy
		// and Tor exit IPs). Default "socks5" → relay dials through
		// SOCKS_PROXY_ADDR; production wires it at wireproxy on 127.0.0.1:1080
		// over Mullvad WireGuard.
		transportMode: envconfig.GetOr("TRANSPORT_MODE", "socks5"),

		// Tor
		torEnabled:    envconfig.BoolOr("TOR_ENABLED", false),
		torSocksPort:  envIntOr("TOR_SOCKS_PORT", 9050),
		torHiddenPort: envIntOr("TOR_HIDDEN_PORT", 80),
		torBinary:     envconfig.GetOr("TOR_BINARY", "tor"),

		// VPN
		vpnEnabled:       envconfig.BoolOr("VPN_ENABLED", false),
		vpnPrivateKey:    envconfig.GetOr("VPN_PRIVATE_KEY", ""),
		vpnAddress:       envconfig.GetOr("VPN_ADDRESS", "10.66.66.2/32"),
		vpnDNS:           envconfig.GetOr("VPN_DNS", ""),
		vpnPeerPublicKey: envconfig.GetOr("VPN_PEER_PUBLIC_KEY", ""),
		vpnPeerEndpoint:  envconfig.GetOr("VPN_PEER_ENDPOINT", ""),
		vpnAllowedIPs:    envconfig.GetOr("VPN_ALLOWED_IPS", "0.0.0.0/0, ::/0"),
		vpnPresharedKey:  envconfig.GetOr("VPN_PRESHARED_KEY", ""),
		vpnKeepalive:     envIntOr("VPN_KEEPALIVE", 25),

		// Multi-endpoint Mullvad pool. JSON array of {label, peer_pubkey,
		// peer_host, country?, city?}; entrypoint.sh has spawned a bridge
		// on 127.0.0.1:108${i} for each entry.
		wireproxyPoolConfig: envconfig.GetOr("WIREPROXY_POOL_CONFIG", ""),
		wireproxyAffinity:   envconfig.BoolOr("MAILBOX_ENDPOINT_AFFINITY", false),
	}
}

func envIntOr(key string, fallback int) int {
	v := envconfig.GetOr(key, "")
	if v == "" {
		return fallback
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// deadDropSender implements constrate.Sender by posting envelopes to dead drop slots.
// Cover traffic is silently discarded (no slot to post to).
type deadDropSender struct {
	store  *deaddrop.Store
	poster *decoy.Poster
	audit  *audit.Service
	logger *minlog.Logger
}

func (d *deadDropSender) Send(ctx context.Context, env model.Envelope) error {
	if env.IsCover {
		return nil
	}

	slotID := deaddrop.DeriveSlotID([]byte(env.AliasToken), deaddrop.CurrentEpoch())
	payload := []byte(hex.EncodeToString(env.SealedContent))

	// Post with decoys (real message + N decoy posts to random slots)
	if d.poster != nil {
		if err := d.poster.PostWithDecoys(slotID, payload); err != nil {
			d.audit.Record(ctx, env.TenantID, model.EventRelayFailed, env.ID)
			d.logger.Error("deaddrop_post_failed", minlog.F("envelope_id", env.ID))
			return err
		}
	} else {
		if err := d.store.Post(slotID, payload); err != nil {
			d.audit.Record(ctx, env.TenantID, model.EventRelayFailed, env.ID)
			d.logger.Error("deaddrop_post_failed", minlog.F("envelope_id", env.ID))
			return err
		}
	}

	d.audit.Record(ctx, env.TenantID, model.EventRelayCompleted, env.ID)
	d.logger.Info("deaddrop_posted", minlog.F("envelope_id", env.ID))
	return nil
}

// resolveListenAddr determines the listen address.
// Railway sets PORT env var; LISTEN_ADDR takes precedence.
func resolveListenAddr() string {
	if v := envconfig.GetOr("LISTEN_ADDR", ""); v != "" {
		return v
	}
	if port := envconfig.GetOr("PORT", ""); port != "" {
		return ":" + port
	}
	return ":8090"
}

// disableCoreDumps prevents key material from being written to disk on crash.
// The OS-level implementation is injected via disableCoreDumpsFunc so tests can
// cover the error branch without requiring a privileged process.
var disableCoreDumpsFunc = disableCoreDumpsOS

func disableCoreDumps(logger *minlog.Logger) {
	if err := disableCoreDumpsFunc(); err != nil {
		logger.Error("failed_to_disable_core_dumps")
	}
}

// auditRecorder is the minimal interface used by recordOrLog and
// handleSealedEnvelope. *audit.Service satisfies it.
type auditRecorder interface {
	Record(ctx context.Context, tenantID, eventType, envelopeID string) error
}

// sealedEnvelopeScheduler abstracts *relay.Scheduler.Schedule for testability.
type sealedEnvelopeScheduler interface {
	Schedule(ctx context.Context, env model.Envelope) (time.Time, error)
}

// sealedEnvelopeMixPool abstracts the mix pool used by the sealed subscriber.
type sealedEnvelopeMixPool interface {
	Submit(env model.Envelope)
	Size() int
}

// recordOrLog wraps auditRecorder.Record and logs any persistence error so
// compliance/forensics failures (disk full, permission error, schema
// corruption) surface in logs instead of being silently dropped.
// Safe with a nil recorder: no-op, no panic.
// Error value is intentionally logged only at a high level — the event type
// and envelope ID are safe; the error string is vetted by minlog's filters.
func recordOrLog(ctx context.Context, rec auditRecorder, tenantID, eventType, envelopeID string, logger *minlog.Logger) {
	if rec == nil {
		return
	}
	if err := rec.Record(ctx, tenantID, eventType, envelopeID); err != nil {
		logger.Error("audit_persist_failed",
			minlog.F("event_type", eventType),
			minlog.F("envelope_id", envelopeID),
			minlog.F("error", err.Error()),
		)
	}
}

// handleSealedEnvelope processes one sealed envelope from the msgbus subscriber.
// The caller (main subscriber goroutine) still wraps this in a defer/recover so
// any panic in scheduler/mixPool/audit cannot crash the relay process. This
// helper additionally wraps its own body in recover so a panic on envelope N
// does not drop envelope N+1 in the same loop.
func handleSealedEnvelope(
	ctx context.Context,
	env model.Envelope,
	deliveryMode string,
	mixPool sealedEnvelopeMixPool,
	scheduler sealedEnvelopeScheduler,
	auditRec auditRecorder,
	logger *minlog.Logger,
) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("sealed_envelope_handler_panic",
				minlog.F("envelope_id", env.ID),
				minlog.F("panic", fmt.Sprintf("%v", r)),
			)
		}
	}()

	if strings.EqualFold(deliveryMode, "deaddrop") {
		// Feed into mix pool for constant-rate emission.
		mixPool.Submit(env)
		recordOrLog(ctx, auditRec, env.TenantID, model.EventRelayScheduled, env.ID, logger)
		logger.Info("envelope_pooled",
			minlog.F("envelope_id", env.ID),
			minlog.F("pool_size", fmt.Sprintf("%d", mixPool.Size())),
		)
		return
	}

	// Legacy path: schedule with random delay.
	scheduledAt, err := scheduler.Schedule(ctx, env)
	if err != nil {
		logger.Error("schedule_failed", minlog.F("envelope_id", env.ID))
		return
	}
	recordOrLog(ctx, auditRec, env.TenantID, model.EventRelayScheduled, env.ID, logger)
	logger.Info("envelope_scheduled",
		minlog.F("envelope_id", env.ID),
		minlog.BucketedTime("scheduled_at", scheduledAt),
	)
}

// cryptoJitterDuration returns the base duration +/- 25% using crypto/rand.
// randReader is injectable for testing; production callers pass rand.Reader.
func cryptoJitterDuration(base time.Duration) time.Duration {
	return cryptoJitterDurationWithReader(base, rand.Reader)
}

// cryptoJitterDurationWithReader is the testable core of cryptoJitterDuration.
func cryptoJitterDurationWithReader(base time.Duration, r io.Reader) time.Duration {
	var buf [8]byte
	if _, err := io.ReadFull(r, buf[:]); err != nil {
		return base
	}
	n := binary.BigEndian.Uint64(buf[:])
	quarter := base / 4
	jitter := time.Duration(n%uint64(2*quarter)) - quarter // -25% to +25%
	return base + jitter
}

// ---------------------------------------------------------------------------
// Periodic background loop helpers — extracted for testability
// ---------------------------------------------------------------------------

// deadDropGCer is the interface satisfied by *deaddrop.Store for GC operations.
type deadDropGCer interface {
	GC() int
}

// limiterCleaner is the interface satisfied by *abuse.Limiter for cleanup.
type limiterCleaner interface {
	Cleanup()
}

// runDeadDropGCLoop runs a periodic garbage-collection ticker for the dead drop
// store. Extracted so tests can drive the ticker channel directly.
func runDeadDropGCLoop(ctx context.Context, store deadDropGCer, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			store.GC() //nolint:errcheck — return value (pruned count) is informational only
		}
	}
}

// runLimiterCleanupLoop runs a periodic cleanup ticker for the abuse limiter.
// Extracted so tests can drive the ticker channel directly.
func runLimiterCleanupLoop(ctx context.Context, limiter limiterCleaner, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			limiter.Cleanup()
		}
	}
}

// ---------------------------------------------------------------------------
// Sealed subscriber loop — extracted for testability
// ---------------------------------------------------------------------------

// sealedEnvelopeHandler processes one sealed envelope; injectable for tests.
type sealedEnvelopeHandler func(
	ctx context.Context,
	env model.Envelope,
	deliveryMode string,
	mixPool sealedEnvelopeMixPool,
	scheduler sealedEnvelopeScheduler,
	auditRec auditRecorder,
	logger *minlog.Logger,
)

// sealedEnvelopeHandlerFn is the per-envelope handler used by
// runSealedSubscriberLoop. It defaults to handleSealedEnvelope and can be
// overridden in tests to inject panics or other behavior.
var sealedEnvelopeHandlerFn = handleSealedEnvelope

// runSealedSubscriberLoop reads envelopes from sealedCh and dispatches them to
// sealedEnvelopeHandlerFn. An outer recover catches any panic that escapes the
// per-envelope handler (belt-and-suspenders). Extracted for testability.
func runSealedSubscriberLoop(
	ctx context.Context,
	sealedCh <-chan model.Envelope,
	deliveryMode string,
	mixPool sealedEnvelopeMixPool,
	scheduler sealedEnvelopeScheduler,
	auditRec auditRecorder,
	logger *minlog.Logger,
) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("sealed_subscriber_panic", minlog.F("panic", fmt.Sprintf("%v", r)))
		}
	}()
	for env := range sealedCh {
		sealedEnvelopeHandlerFn(ctx, env, deliveryMode, mixPool, scheduler, auditRec, logger)
	}
}

// batchDrainer is the interface satisfied by *traffic.BatchDrainer.
type batchDrainer interface {
	DrainAndShuffle(ctx context.Context) ([]model.Envelope, error)
}

// pendingCounter is the interface satisfied by *relay.Scheduler for pending count.
type pendingCounter interface {
	PendingCount() int
}

// drainPendingScheduler combines drain scheduling + pending count.
type drainPendingScheduler interface {
	drainScheduler
	pendingCounter
}

// runDrainLoop runs the batch-drain goroutine: waits for jitter, drains the
// scheduler, then processes each envelope. Runs until ctx is cancelled.
// Extracted from main() for testability of the drain error path and panic recovery.
func runDrainLoop(
	ctx context.Context,
	drainer batchDrainer,
	envCfg drainEnvelopeConfig,
	sched drainPendingScheduler,
	exitV drainExitVerifier,
	deliverer drainDeliverer,
	accountPool drainAccountPool,
	gatewayBridge drainGatewayBridge,
	minimizer *metamin.Minimizer,
	audit auditRecorder,
	logger *minlog.Logger,
	batchInterval time.Duration,
) {
	defer func() {
		if r := recover(); r != nil {
			logger.Error("drain_goroutine_panic", minlog.F("panic", fmt.Sprintf("%v", r)))
			// Bypass logger redaction — stack trace to stderr direct.
			fmt.Fprintf(os.Stderr, "DRAIN_PANIC_STACK: %v\n%s\n", r, debug.Stack())
		}
	}()
	for {
		jitter := cryptoJitterDuration(batchInterval)
		select {
		case <-ctx.Done():
			return
		case <-time.After(jitter):
		}

		batch, err := drainer.DrainAndShuffle(ctx)
		if err != nil {
			logger.Error("drain_failed")
			continue
		}
		logger.Info("drain_tick",
			minlog.F("batch_size", fmt.Sprintf("%d", len(batch))),
			minlog.F("pending", fmt.Sprintf("%d", sched.PendingCount())),
		)
		for _, env := range batch {
			processDrainEnvelope(ctx, env, envCfg, sched, exitV, deliverer, accountPool, gatewayBridge, minimizer, audit, logger)
		}
	}
}

// ---------------------------------------------------------------------------
// Drain loop envelope processor — extracted for testability
// ---------------------------------------------------------------------------

// drainScheduler is the scheduling interface used by the drain loop.
//
// Reschedule is called when a transient (4xx) SMTP failure occurs and the
// envelope still has remaining attempt budget. The implementation re-queues
// the envelope with a delayed ScheduledAt so the next drain tick after
// nextAttemptAt picks it back up. Sprint AW7-5.
type drainScheduler interface {
	MarkFailed(ctx context.Context, id string) error
	MarkRelayed(ctx context.Context, id string) error
	Reschedule(ctx context.Context, env model.Envelope, nextAttemptAt time.Time, lastErr string) error
}

// drainExitVerifier is the exit-channel interface used by the drain loop.
type drainExitVerifier interface {
	Verify(ctx context.Context, env model.Envelope, channelID string) error
	GetChannel(ctx context.Context, channelID, tenantID string) (model.ExitChannel, error)
}

// drainDeliverer is the delivery interface used by the drain loop.
type drainDeliverer interface {
	Deliver(ctx context.Context, from string, to []string, msg []byte) error
}

// drainAccountPool is the multi-account SMTP pool interface.
// A nil value means no pool is configured.
type drainAccountPool interface {
	Has(address string) bool
	Deliver(ctx context.Context, from string, to []string, msg []byte) error
}

// drainGatewayBridge is the bridge forwarding interface.
type drainGatewayBridge interface {
	ForwardSubmission(ctx context.Context, env model.Envelope, recipient, subject, body string) (*bridge.ForwardResult, error)
}

// smtpDelivererFactory creates one-shot SMTP deliverers for per-envelope credentials.
// The default implementation calls delivery.NewSMTPDeliverer.
type smtpDelivererFactory func(t transport.AnonymousTransport, cfg delivery.SMTPConfig) drainDeliverer

// drainEnvelopeConfig holds the delivery-related settings needed by processDrainEnvelope.
type drainEnvelopeConfig struct {
	deliveryMode  string
	smtpUsername  string
	smtpHelloDomain string
	smtpBaseCfg   delivery.SMTPConfig
	anonTransport transport.AnonymousTransport
	delivererFn   smtpDelivererFactory // nil → use delivery.NewSMTPDeliverer
	// setPinFn is set when a wgpool.Pool is wired; nil otherwise.
	// AP2: called after first successful outbound_smtp_delivered to lock the
	// mailbox to the chosen Mullvad endpoint for its entire lifetime.
	setPinFn func(mailboxID, endpointLabel, actor string) error
	// egressObserverFn, when non-nil, is called after a successful outbound-smtp
	// delivery to record which country/endpoint was used. Best-effort: never
	// blocks or fails the send path. Signature: (mailboxID, country, endpointLabel, opType).
	egressObserverFn func(mailboxID, country, endpointLabel, opType string)
	// retryCfg controls greylist auto-retry on 4xx transient SMTP errors.
	// Sprint AW7-5: Czech B2B mail servers (LUMIT/auto-mt.com, autostonis.cz)
	// frequently temp-reject the first delivery attempt; manual operator
	// retries 5–10 minutes later succeed. With retryCfg.Enabled=true the
	// drain loop re-queues the envelope with exponential backoff instead of
	// dropping it.
	retryCfg delivery.RetryConfig
	// nowFn is the time source for retry scheduling. Defaults to time.Now;
	// tests inject a deterministic clock.
	nowFn func() time.Time
}

// processDrainEnvelope applies the delivery policy for one envelope from the drain batch.
// It is extracted from the main drain goroutine to allow comprehensive unit testing of
// all delivery-mode branches and error paths without requiring a live relay process.
func processDrainEnvelope(
	ctx context.Context,
	env model.Envelope,
	cfg drainEnvelopeConfig,
	sched drainScheduler,
	exitV drainExitVerifier,
	deliverer drainDeliverer,
	accountPool drainAccountPool,
	gatewayBridge drainGatewayBridge,
	minimizer *metamin.Minimizer,
	audit auditRecorder,
	logger *minlog.Logger,
) {
	// Skip cover traffic — never delivered.
	if env.IsCover {
		return
	}

	// Verify exit channel when present (applies to all delivery modes).
	if env.ExitChannelID != "" {
		if err := exitV.Verify(ctx, env, env.ExitChannelID); err != nil {
			sched.MarkFailed(ctx, env.ID)
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
			return
		}
	}

	switch strings.ToLower(strings.TrimSpace(cfg.deliveryMode)) {
	case "record-only", "":
		sched.MarkRelayed(ctx, env.ID)
		recordOrLog(ctx, audit, env.TenantID, model.EventRelayCompleted, env.ID, logger)

	case "bridge":
		if gatewayBridge == nil {
			sched.MarkFailed(ctx, env.ID) //nolint:errcheck
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
			return
		}
		_, err := gatewayBridge.ForwardSubmission(ctx, env,
			env.Recipient, env.Subject,
			base64.StdEncoding.EncodeToString(env.SealedContent),
		)
		if err != nil {
			sched.MarkFailed(ctx, env.ID) //nolint:errcheck
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
		} else {
			sched.MarkRelayed(ctx, env.ID) //nolint:errcheck
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayCompleted, env.ID, logger)
		}

	case "smtp":
		exitCh, err := exitV.GetChannel(ctx, env.ExitChannelID, env.TenantID)
		if err != nil {
			sched.MarkFailed(ctx, env.ID) //nolint:errcheck
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
			return
		}
		msg := delivery.BuildMinimalMessage(
			"relay@"+cfg.smtpHelloDomain,
			[]string{exitCh.Endpoint},
			"[sealed-envelope]",
			base64.StdEncoding.EncodeToString(env.SealedContent),
		)
		err = deliverer.Deliver(ctx, "relay@"+cfg.smtpHelloDomain, []string{exitCh.Endpoint}, msg)
		if err != nil {
			sched.MarkFailed(ctx, env.ID)
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
		} else {
			sched.MarkRelayed(ctx, env.ID)
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayCompleted, env.ID, logger)
		}

	case "outbound-smtp":
		// Sprint AW7-5: count this attempt up-front so retry budget math
		// is correct regardless of which dispatch branch handles delivery.
		// The local copy of env is mutated; the persisted version is
		// updated by sched.Reschedule on transient failure (or removed
		// from the queue on MarkRelayed/MarkFailed for terminal outcomes).
		env.Attempts++
		unpadded := minimizer.UnpadFromSizeClass(env.SealedContent)
		var content struct {
			Recipient string            `json:"recipient"`
			Subject   string            `json:"subject"`
			Body      string            `json:"body"`
			BodyHTML  string            `json:"body_html,omitempty"`
			Headers   map[string]string `json:"headers,omitempty"`
		}
		if err := json.Unmarshal(unpadded, &content); err != nil {
			logger.Error("outbound_smtp_unmarshal", minlog.F("env_id", env.ID))
			sched.MarkFailed(ctx, env.ID)
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
			return
		}
		fromAddr := env.FromAddress
		if fromAddr == "" {
			fromAddr = cfg.smtpUsername
		}
		// Per-envelope SMTP credentials live on Envelope.InlineCreds (set by
		// services/relay/internal/intake/handler.go:143 — `InlineCreds: req.InlineCreds()`).
		// Sprint M5 RCA: prior code read `content.SMTPHost` / `content.SMTPPassword`
		// from the sealed body, but the intake handler never wrote those
		// fields into the sealed content (its inline anon struct only includes
		// Recipient/Subject/Body/BodyHTML/Headers). Result: drain saw empty
		// creds → fell to RecordDeliverer no-op → 0/N INBOX delivery despite
		// `outbound_smtp_delivered` log firing. Use InlineCreds as the source.
		inlineCreds := env.InlineCreds
		msg := delivery.BuildMessage(fromAddr, []string{content.Recipient}, content.Subject, content.Body, content.BodyHTML, content.Headers)
		logger.Info("outbound_smtp_delivering",
			minlog.F("env_id", env.ID),
			minlog.F("from", fromAddr),
			minlog.F("to", content.Recipient),
		)
		deliverCtx, deliverCancel := context.WithTimeout(ctx, 90*time.Second)
		// Inject wgpool routing keys so the pool picker can apply the per-mailbox
		// country pin (env.PreferredCountry) when selecting an egress endpoint.
		// WithRoutingKeysAndCountry is a no-op when PreferredCountry is empty.
		deliverCtx = wgpool.WithRoutingKeysAndCountry(deliverCtx, env.ID, fromAddr, env.PreferredCountry)
		// AP2: wire a label sink so DialContext can write the chosen endpoint
		// label back, enabling SetPin after first successful send.
		deliverCtx = wgpool.WithLabelSink(deliverCtx)
		if env.PreferredCountry != "" {
			logger.Info("outbound_smtp_preferred_country",
				minlog.F("env_id", env.ID),
				minlog.F("from", fromAddr),
				minlog.F("preferred_country", env.PreferredCountry),
			)
		}
		hasInlineCreds := inlineCreds.SMTPHost != "" && inlineCreds.SMTPPassword != ""
		logger.Info("outbound_smtp_dispatch",
			minlog.F("env_id", env.ID),
			minlog.F("has_inline_creds", fmt.Sprintf("%v", hasInlineCreds)),
			minlog.F("account_pool_nil", fmt.Sprintf("%v", accountPool == nil)),
		)
		var sendErr error
		if hasInlineCreds && (accountPool == nil || !accountPool.Has(fromAddr)) {
			logger.Info("outbound_smtp_dispatch_branch",
				minlog.F("env_id", env.ID),
				minlog.F("branch", "oneshot"),
			)
			port := inlineCreds.SMTPPort
			if port == 0 {
				port = 587
			}
			oneShotCfg := delivery.SMTPConfig{
				Host:     inlineCreds.SMTPHost,
				Port:     port,
				Username: inlineCreds.SMTPUsername,
				Password: inlineCreds.SMTPPassword,
			}
			if cfg.delivererFn != nil {
				oneShotD := cfg.delivererFn(cfg.anonTransport, oneShotCfg)
				sendErr = oneShotD.Deliver(deliverCtx, fromAddr, []string{content.Recipient}, msg)
			} else {
				oneShotDeliverer := delivery.NewSMTPDeliverer(cfg.anonTransport, oneShotCfg)
				sendErr = oneShotDeliverer.Deliver(deliverCtx, fromAddr, []string{content.Recipient}, msg)
			}
		} else if accountPool != nil {
			logger.Info("outbound_smtp_dispatch_branch",
				minlog.F("env_id", env.ID),
				minlog.F("branch", "account_pool"),
			)
			sendErr = accountPool.Deliver(deliverCtx, fromAddr, []string{content.Recipient}, msg)
		} else {
			logger.Info("outbound_smtp_dispatch_branch",
				minlog.F("env_id", env.ID),
				minlog.F("branch", "fallback_deliverer"),
			)
			sendErr = deliverer.Deliver(deliverCtx, fromAddr, []string{content.Recipient}, msg)
		}
		deliverCancel()
		if sendErr != nil {
			logger.Error("outbound_smtp_failed",
				minlog.F("env_id", env.ID),
				minlog.F("to", content.Recipient),
				minlog.F("attempts", fmt.Sprintf("%d", env.Attempts)),
				minlog.F("error", sendErr.Error()),
			)
			// Sprint AW7-5: classify the SMTP error. Transient (4xx) errors
			// trigger a re-queue with exponential backoff up to MaxAttempts.
			// Permanent (5xx) errors and uncatalogued failures keep current
			// MarkFailed behavior (no retry, no anti-trace impact).
			retryNow := cfg.nowFn
			if retryNow == nil {
				retryNow = time.Now
			}
			if shouldRetry, code := cfg.retryCfg.ShouldRetry(env.Attempts, sendErr); shouldRetry {
				// Jitter the backoff so a batch greylisted in the same drain
				// tick does not re-fire synchronously on the next attempt and
				// re-trip the same greylist / rate-limit window. cryptoJitterDuration
				// spreads the delay ±25% via crypto/rand — the same helper the
				// initial Schedule jitter path uses. Guard against a 0 base
				// (jitter of 0 would divide by zero).
				wait := cfg.retryCfg.BackoffFor(env.Attempts)
				if wait > 0 {
					wait = cryptoJitterDuration(wait)
				}
				next := retryNow().Add(wait)
				rescheduleErr := sched.Reschedule(ctx, env, next, sendErr.Error())
				if rescheduleErr != nil {
					logger.Error("outbound_smtp_reschedule_failed",
						minlog.F("env_id", env.ID),
						minlog.F("error", rescheduleErr.Error()),
					)
					// Reschedule failed → fall back to MarkFailed so we
					// don't leak the envelope.
					sched.MarkFailed(ctx, env.ID)
					recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
				} else {
					logger.Info("outbound_smtp_retry_scheduled",
						minlog.F("env_id", env.ID),
						minlog.F("attempt", fmt.Sprintf("%d", env.Attempts)),
						minlog.F("max_attempts", fmt.Sprintf("%d", cfg.retryCfg.MaxAttempts)),
						minlog.F("smtp_code", fmt.Sprintf("%d", code)),
						minlog.F("backoff", wait.String()),
						minlog.BucketedTime("next_attempt_at", next),
					)
					recordOrLog(ctx, audit, env.TenantID, model.EventRelayRetryScheduled, env.ID, logger)
				}
			} else {
				sched.MarkFailed(ctx, env.ID)
				recordOrLog(ctx, audit, env.TenantID, model.EventRelayFailed, env.ID, logger)
			}
		} else {
			logger.Info("outbound_smtp_delivered",
				minlog.F("env_id", env.ID),
				minlog.F("from", fromAddr),
				minlog.F("to", content.Recipient),
			)
			// AP2: pin the mailbox to the endpoint used on first successful send.
			// cfg.setPinFn is non-nil only when a wgpool.Pool is wired.
			// fromAddr uniquely identifies the mailbox (e.g. mb@seznam.cz).
			if cfg.setPinFn != nil && fromAddr != "" {
				chosenLabel := wgpool.RoutingLabelFromContext(deliverCtx)
				if chosenLabel != "" {
					if pinErr := cfg.setPinFn(fromAddr, chosenLabel, "drain_first_send"); pinErr != nil {
						logger.Error("egress_pin_failed",
							minlog.F("env_id", env.ID),
							minlog.F("from", fromAddr),
							minlog.F("error", pinErr.Error()),
						)
					}
				}
			}
			sched.MarkRelayed(ctx, env.ID)
			recordOrLog(ctx, audit, env.TenantID, model.EventRelayCompleted, env.ID, logger)
			// AP4 — egress chaos detection: record which country served this send.
			// Uses env.PreferredCountry as the egress country proxy (the wgpool
			// used the preferred country pin to pick the endpoint). Best-effort.
			if cfg.egressObserverFn != nil && env.MailboxID != "" && env.PreferredCountry != "" {
				cfg.egressObserverFn(env.MailboxID, env.PreferredCountry, "", "send")
			}
			// AW7-9: post-send IMAP APPEND to sender mailbox's "Sent" folder.
			// Spawned detached so APPEND latency (Seznam: 100-400ms observed)
			// does not slow the drain loop's per-send pacing. Best-effort:
			// the SMTP delivery has already succeeded by the time this fires,
			// so the message has reached the recipient regardless of APPEND
			// outcome.
			//
			// Replaces the orchestrator-side AW7-7 wiring, which failed on
			// PROD 2026-05-10 21:35 with "dial tcp 127.0.0.1:1080: connect:
			// connection refused" because wgsocks (the userspace WG-SOCKS
			// bridge) only runs in the relay container.
			if appendSentEnabled && inlineCreds.HasIMAP() {
				appendParams := delivery.AppendParams{
					MailboxAddress: fromAddr,
					IMAPHost:       inlineCreds.IMAPHost,
					IMAPPort:       inlineCreds.IMAPPort,
					Username:       inlineCreds.SMTPUsername,
					Password:       inlineCreds.SMTPPassword,
					WireMIME: delivery.BuildWireMIMEForAppend(
						fromAddr,
						content.Recipient,
						content.Subject,
						content.Body,
						content.BodyHTML,
						content.Headers,
					),
				}
				envID := env.ID
				mailboxID := env.MailboxID
				preferredCountry := env.PreferredCountry
				go func() {
					defer func() {
						if r := recover(); r != nil {
							logger.Error("imap_append_goroutine_panic",
								minlog.F("env_id", envID),
								minlog.F("mailbox", appendParams.MailboxAddress),
								minlog.F("recover", fmt.Sprintf("%v", r)),
							)
						}
					}()
					// Fresh timeout context — parent ctx may already be
					// cancelled by the time the goroutine runs (process
					// shutdown shortly after a successful send). 30s
					// upper-bounds Seznam's slow fsync tail.
					appendCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					defer cancel()
					// Re-attach the same wgpool routing keys used for SMTP
					// delivery so the APPEND dial picks an endpoint by the
					// same algorithm (mailbox affinity / preferred country)
					// as the send itself.
					appendCtx = wgpool.WithRoutingKeysAndCountry(appendCtx, envID, mailboxID, preferredCountry)
					if err := delivery.AppendToSent(appendCtx, cfg.anonTransport, appendParams); err != nil {
						// AppendToSent already slog.Warn'd the specific
						// failure; the helper is best-effort by contract so
						// we drop the error here on purpose.
						return
					}
				}()
			}
		}
	}
}

// appendSentEnabled is the package-level kill switch for the AW7-9
// post-send IMAP APPEND. Reads RELAY_SENT_APPEND_ENABLED at boot
// (default "1" — enabled). Operator can set "0" to disable the
// feature without redeploying code. The value is read once because
// changing it mid-process would require a goroutine-safe load anyway
// and the operator escape path is a full restart.
var appendSentEnabled = envconfig.GetOr("RELAY_SENT_APPEND_ENABLED", "1") != "0"

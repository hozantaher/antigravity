// Mail Lab admin REST server (ML1.5).
//
// Boots an HTTP server on $PORT (default 8090) backed by docker exec
// against docker-mailserver containers. Used by:
//   - operator scripts (scripts/mail-lab/seed.sh) — creates demo accounts
//   - test harness (#211) — drives scenarios programmatically
//   - dev workflow — operator curl from terminal
//
// Auth: X-Lab-Api-Key matched constant-time. LAB_API_KEY=dev-only is
// the seed.sh default; any caller can override via env.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"common/envconfig"

	"mail-lab-api/internal/exec"
	"mail-lab-api/internal/handler"
	"mail-lab-api/internal/profile"
)

func main() {
	port := envconfig.GetOr("PORT", "8090")
	apiKey := envconfig.GetOr("LAB_API_KEY", "dev-only")

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// ML2.2 — load profile registry. Try filesystem dir first; if absent
	// (container without mounted profiles dir) fall back to embedded defaults.
	registry := profile.NewRegistry()
	profilesDir := envconfig.GetOr("PROFILES_DIR", "profiles")
	if loaded, err := registry.Load(profilesDir); err != nil || loaded == 0 {
		if loaded, err := registry.LoadEmbedded(); err != nil {
			logger.Warn("profile registry empty",
				"op", "mail-lab-api.main/profile",
				"error", err)
		} else {
			logger.Info("profile registry from embedded",
				"op", "mail-lab-api.main/profile",
				"count", loaded)
		}
	} else {
		logger.Info("profile registry from disk",
			"op", "mail-lab-api.main/profile",
			"dir", profilesDir,
			"count", loaded)
	}

	srv := handler.NewServer(apiKey, exec.DockerRunner{}, logger).WithProfiles(registry)

	httpSrv := &http.Server{
		Addr:              ":" + port,
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	logger.Info("mail-lab-api starting",
		"op", "mail-lab-api.main",
		"port", port,
		"auth", apiKey != "")

	// Graceful shutdown on SIGTERM/SIGINT.
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed", "op", "mail-lab-api.main/listen", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	logger.Info("shutting down", "op", "mail-lab-api.main/shutdown")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

// llm-runner: Go HTTP wrapper kolem Ollama daemon.
//
// Per ADR-006 §D1, tento service exponuje stable kontrakt API
// (`/v1/classify`, `/v1/generate`, `/v1/parse-photo`) a interně volá
// `services/ollama` Railway service. Tato verze (LLM2.x) wire-uje
// real implementaci přes `internal/handler` package.
//
// Boot env vars (per `services/common/envconfig`):
//   - PORT (default 8092) — HTTP listen port
//   - OLLAMA_URL — required na prod; Railway internal Ollama daemon (např.
//     "http://ollama.railway.internal:11434"); pokud unset, healthz reportuje
//     status="degraded" a /v1/* handlery vrátí 502.
//   - DEFAULT_TEXT_MODEL (default "llama3.2:3b")
//   - DEFAULT_VISION_MODEL (default "llama3.2-vision:11b")
//   - LLM_API_KEY — optional; pokud set, vyžaduje X-LLM-Api-Key header
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"common/envconfig"

	"llm-runner/internal/handler"
	"llm-runner/internal/ollama"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	port := envconfig.GetOr("PORT", "8092")
	ollamaURL := envconfig.GetOr("OLLAMA_URL", "")
	textModel := envconfig.GetOr("DEFAULT_TEXT_MODEL", "llama3.2:3b")
	visionModel := envconfig.GetOr("DEFAULT_VISION_MODEL", "llama3.2-vision:11b")
	apiKey := envconfig.GetOr("LLM_API_KEY", "")

	if ollamaURL == "" {
		logger.Warn("OLLAMA_URL not set — health check will report degraded",
			"op", "llm-runner.main/boot")
	}

	client := ollama.NewClient(ollama.Config{
		BaseURL: ollamaURL,
		Timeout: 60 * time.Second,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthzHandler(client, textModel, visionModel, logger))
	mux.HandleFunc("/v1/classify", authMiddleware(apiKey, handler.Classify(client, textModel, logger), logger))
	mux.HandleFunc("/v1/generate", authMiddleware(apiKey, handler.Generate(client, textModel, logger), logger))
	mux.HandleFunc("/v1/parse-photo", authMiddleware(apiKey, handler.ParsePhoto(client, visionModel, logger), logger))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	logger.Info("llm-runner starting",
		"op", "llm-runner.main",
		"port", port,
		"ollama_url", ollamaURL,
		"text_model", textModel,
		"vision_model", visionModel,
		"auth", apiKey != "")

	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed",
				"op", "llm-runner.main/listen",
				"error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	logger.Info("shutting down", "op", "llm-runner.main/shutdown")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

// healthzHandler reportuje status llm-runner i underlying ollama daemon.
// Per ADR-006 §D6: pokud ollama unreachable, status="degraded" (ne "down")
// — consumer services degradují gracefully (manual operator triage).
func healthzHandler(client *ollama.Client, textModel, visionModel string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		resp := map[string]any{
			"status":  "ok",
			"service": "llm-runner",
		}

		if err := client.Ping(ctx); err != nil {
			resp["status"] = "degraded"
			resp["ollama_error"] = err.Error()
			logger.Warn("ollama ping failed",
				"op", "llm-runner.healthz/ping",
				"error", err)
			writeJSON(w, http.StatusServiceUnavailable, resp)
			return
		}

		models, err := client.ListModels(ctx)
		if err != nil {
			resp["status"] = "degraded"
			resp["ollama_error"] = err.Error()
			writeJSON(w, http.StatusServiceUnavailable, resp)
			return
		}

		resp["models_loaded"] = models
		resp["text_model"] = textModel
		resp["vision_model"] = visionModel

		// Pokud DEFAULT_TEXT_MODEL nebo DEFAULT_VISION_MODEL nejsou
		// stažené, status je degraded — consumer může unblock-nout
		// degraded path bez nutnosti čekat na model preload.
		if !modelLoaded(models, textModel) || !modelLoaded(models, visionModel) {
			resp["status"] = "degraded"
			resp["reason"] = "default models not yet loaded"
			writeJSON(w, http.StatusServiceUnavailable, resp)
			return
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// modelLoaded testuje název v Ollama tag listu.
// Ollama vrací jména s :tag suffix nebo bez (varianta podle verze daemon).
func modelLoaded(models []string, want string) bool {
	for _, m := range models {
		if m == want {
			return true
		}
		// Ollama může vrátit "llama3.2:3b" i "llama3.2:3b-instruct-q4_K_M"
		// pro stejný request — accept-uj prefix match.
		if len(m) > len(want) && m[:len(want)] == want {
			return true
		}
	}
	return false
}

// secureCompare uses HMAC-SHA256 to compare two strings in constant time,
// preventing timing side-channel attacks. Mirrors services/orchestrator/web/auth.go.
func secureCompare(a, b string) bool {
	key := []byte("llm-api-key-compare")
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(a))
	sigA := mac.Sum(nil)
	mac.Reset()
	mac.Write([]byte(b))
	sigB := mac.Sum(nil)
	return hmac.Equal(sigA, sigB)
}

// authMiddleware vyžaduje X-LLM-Api-Key header pokud apiKey není prázdný.
// Používá constant-time compare (HMAC-SHA256) shodně s orchestrator/web/auth.go
// a mail-lab-api/internal/handler/handler.go.
func authMiddleware(apiKey string, next http.HandlerFunc, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if apiKey == "" {
			next(w, r)
			return
		}
		got := r.Header.Get("X-LLM-Api-Key")
		if !secureCompare(got, apiKey) {
			logger.Warn("auth failed",
				"op", "llm-runner.auth",
				"path", r.URL.Path)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

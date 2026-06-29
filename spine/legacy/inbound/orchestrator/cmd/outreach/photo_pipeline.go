package main

import (
	"database/sql"
	"log/slog"
	"strconv"
	"time"

	"common/envconfig"

	"orchestrator/internal/llmclient"
	"orchestrator/internal/photoparse"
	"orchestrator/internal/photostore"
	"orchestrator/thread"
)

// wirePhotoProcessor returns a thread.PhotoProcessor that calls
// llm-runner /v1/parse-photo and persists photo_parse_audit rows. The
// helper keeps both InboundProcessor wiring sites (poll daemon +
// `outreach poll` subcommand) free of net/http and filesystem details.
//
// Tunables read from env (with conservative defaults):
//
//	PHOTO_VOLUME_DIR        Railway volume mount path (default /data/photos).
//	PHOTO_MAX_SIZE_BYTES    Per-photo upper bound in bytes (default 10 MiB).
//	LLM_RUNNER_URL          llm-runner base URL. Empty → audit rows still
//	                        written with extracted=NULL, retry job re-runs
//	                        when the URL is later configured.
//	LLM_API_KEY             Optional X-LLM-Api-Key header for llm-runner.
//	PHOTO_LLM_TIMEOUT       Per-call timeout (default 60s, ADR-006 §D4).
//	PHOTO_LLM_PROMPT_CONTEXT Static "context" hint forwarded to Ollama
//	                        (default "TP foto stroje"; orchestrator
//	                        passes it verbatim per ADR-006 §D2 contract).
//
// Returns nil when the photo pipeline is disabled (PHOTO_PIPELINE=off).
// In that case inbound replies still persist normally — no audit row.
func wirePhotoProcessor(db *sql.DB) thread.PhotoProcessor {
	if envconfig.GetOr("PHOTO_PIPELINE", "on") == "off" {
		slog.Info("photo pipeline disabled (PHOTO_PIPELINE=off)",
			"op", "main.wirePhotoProcessor")
		return nil
	}

	root := envconfig.GetOr("PHOTO_VOLUME_DIR", photostore.DefaultRoot)
	store := photostore.New(root)

	var client photoparse.PhotoClient
	llmURL := envconfig.GetOr("LLM_RUNNER_URL", "")
	if llmURL != "" {
		timeout := llmclient.DefaultTimeout
		if v := envconfig.GetOr("PHOTO_LLM_TIMEOUT", ""); v != "" {
			if d, err := time.ParseDuration(v); err == nil {
				timeout = d
			}
		}
		client = llmclient.NewClient(llmclient.Config{
			BaseURL: llmURL,
			APIKey:  envconfig.GetOr("LLM_API_KEY", ""),
			Timeout: timeout,
		})
	} else {
		slog.Info("photo pipeline: LLM_RUNNER_URL unset — audit rows will be written with extracted=NULL",
			"op", "main.wirePhotoProcessor")
	}

	maxBytes := photoparse.DefaultMaxSizeBytes
	if v := envconfig.GetOr("PHOTO_MAX_SIZE_BYTES", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxBytes = n
		}
	}

	processor := photoparse.New(db, photoparse.Config{
		Store:         store,
		Client:        client,
		MaxSizeBytes:  maxBytes,
		PromptContext: envconfig.GetOr("PHOTO_LLM_PROMPT_CONTEXT", "TP foto stroje"),
	})

	slog.Info("photo pipeline wired",
		"op", "main.wirePhotoProcessor",
		"volume_dir", root,
		"max_size_bytes", maxBytes,
		"llm_runner_wired", llmURL != "")

	return photoparse.NewAdapter(processor)
}

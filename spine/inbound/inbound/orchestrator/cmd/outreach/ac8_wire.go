package main

import (
	"database/sql"
	"log/slog"

	"common/envconfig"
	"common/operatorconfig"

	acllm "orchestrator/internal/llm"
	"orchestrator/thread"
)

// wireAC8PreClassifier attaches the Sprint AC8 Haiku pre-classifier and
// its operator_settings kill-switch to an InboundProcessor.
//
// Returns true when the pre-classifier was successfully wired. Returns
// false (with a slog.Warn) when ANTHROPIC_API_KEY is missing — the
// processor still runs, just without AC8 pre-classification. The
// operator can land the key via Railway env panel and restart to
// activate the path without code changes.
//
// Env vars:
//
//	ANTHROPIC_API_KEY                 — required
//	ENABLE_REPLY_PRE_CLASSIFICATION   — boot-time kill switch ("0" = off)
//	ANTHROPIC_REPLY_MODEL             — override classifier model
//
// Operator-settings runtime toggle:
//
//	reply_pre_classification_enabled  — "false" disables per-call
//
// The boot env var ENABLE_REPLY_PRE_CLASSIFICATION lets us flip the
// path off without redeploying if the operator_settings table itself
// is the failure (DB outage, schema drift). Operator-settings is the
// preferred runtime knob (per feedback_env_var_needs_db_fallback T0).
func wireAC8PreClassifier(p *thread.InboundProcessor, db *sql.DB) bool {
	// Boot-time kill switch — defaults ON ("1") so first deploy enables AC8.
	if !envconfig.BoolOr("ENABLE_REPLY_PRE_CLASSIFICATION", true) {
		slog.Info("AC8 pre-classifier disabled by ENABLE_REPLY_PRE_CLASSIFICATION=0",
			"op", "main.wireAC8PreClassifier/envDisabled")
		return false
	}
	apiKey := envconfig.GetOr("ANTHROPIC_API_KEY", "")
	if apiKey == "" {
		slog.Warn("AC8 pre-classifier disabled — no ANTHROPIC_API_KEY",
			"op", "main.wireAC8PreClassifier/noAPIKey")
		return false
	}
	model := envconfig.GetOr("ANTHROPIC_REPLY_MODEL", acllm.DefaultModel)

	classifier := acllm.NewClassifier(apiKey, acllm.WithModel(model))
	p.WithReplyPreClassifier(acllm.NewThreadAdapter(classifier))

	// Operator-settings toggle (best-effort). Missing operatorconfig
	// loader = fail-open (always-on) per fail-open contract in
	// maybePreClassifyAsync.
	if db != nil {
		p.WithPreClassifyToggle(operatorconfig.New(db))
	}
	return true
}

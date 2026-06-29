package intelligence

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"orchestrator/llm"
)

// LLMEnrichConfig configures the LLM description enrichment job.
type LLMEnrichConfig struct {
	Client    *llm.Client
	BatchSize int  // default 100 — gemma2:2b takes ~2-5s/item on CPU; 100 fits within 6h window
	DryRun    bool
}

// LLMEnrichResult holds the outcome of one enrichment run.
type LLMEnrichResult struct {
	Processed        int
	Enriched         int
	ConfidenceBoosted int
	Errors           int
	Duration         time.Duration
}

// RunLLMEnrich enriches Czech business descriptions for companies where
// sector_confidence < 0.7 and description_tags is still empty.
// When the LLM classification is confident enough (≥ 0.75), it also upgrades
// sector_tags and sector_confidence on the company row.
//
// Requires Ollama to be reachable (cfg.Client != nil).
func RunLLMEnrich(ctx context.Context, db *sql.DB, cfg LLMEnrichConfig) (*LLMEnrichResult, error) {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	start := time.Now()
	result := &LLMEnrichResult{}

	rows, err := db.QueryContext(ctx, `
		SELECT id, description, COALESCE(sector_confidence, 0)
		FROM companies
		WHERE description IS NOT NULL
		  AND description != ''
		  AND sector_confidence < 0.7
		  AND (description_tags IS NULL OR description_tags = '{}')
		  AND exclusion_status = 'pass'
		ORDER BY icp_score DESC NULLS LAST
		LIMIT $1
	`, cfg.BatchSize)
	if err != nil {
		return result, err
	}
	defer rows.Close()

	type pending struct {
		id          int64
		description string
		sectorConf  float64
	}
	var batch []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.description, &p.sectorConf); err != nil {
			continue
		}
		batch = append(batch, p)
	}
	rows.Close()

	for _, p := range batch {
		result.Processed++

		tags, err := cfg.Client.EnrichDescription(ctx, p.description)
		if err != nil {
			result.Errors++
			slog.Warn("llm enrich: describe", "op", "intelligence.RunLLMEnrich/describe", "id", p.id, "error", err)
			continue
		}

		tagsJSON, _ := json.Marshal(tags)

		if cfg.DryRun {
			result.Enriched++
			continue
		}

		// Also try ClassifyIndustry — use result to upgrade sector tags when confident.
		industryResult, err := cfg.Client.ClassifyIndustry(ctx, p.description)
		if err != nil {
			slog.Warn("llm enrich: classify", "op", "intelligence.RunLLMEnrich/classify", "id", p.id, "error", err)
		}

		if industryResult != nil &&
			industryResult.Confidence >= 0.75 &&
			len(industryResult.Tags) > 0 &&
			industryResult.Confidence > p.sectorConf {

			sectorTags := "{" + strings.Join(industryResult.Tags, ",") + "}"
			_, err = db.ExecContext(ctx, `
				UPDATE companies SET
					description_tags  = $2,
					sector_tags       = $3,
					sector_primary    = $4,
					sector_confidence = $5,
					sector_source     = 'llm',
					updated_at        = now()
				WHERE id = $1
			`, p.id, string(tagsJSON), sectorTags,
				industryResult.Tags[0], industryResult.Confidence)
			if err == nil {
				result.ConfidenceBoosted++
			} else {
				slog.Warn("llm enrich: persist upgrade", "op", "intelligence.RunLLMEnrich/persist_upgrade", "id", p.id, "error", err)
			}
		} else {
			_, err = db.ExecContext(ctx, `
				UPDATE companies SET description_tags = $2, updated_at = now() WHERE id = $1
			`, p.id, string(tagsJSON))
			if err != nil {
				result.Errors++
				slog.Warn("llm enrich: persist tags", "op", "intelligence.RunLLMEnrich/persist_tags", "id", p.id, "error", err)
				continue
			}
		}
		result.Enriched++
	}

	result.Duration = time.Since(start)
	return result, nil
}

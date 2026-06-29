package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// DescriptionTags holds structured entities extracted from a Czech business description.
type DescriptionTags struct {
	MainProduct    string   `json:"main_product"`
	TechKeywords   []string `json:"tech_keywords"`
	ExportOriented bool     `json:"export_oriented"`
	IsSeasonal     bool     `json:"is_seasonal"`
	EnrichedAt     string   `json:"enriched_at"`
	Model          string   `json:"model"`
}

const descriptionEnrichPrompt = `Z tohoto popisu české firmy extrahuj informace.

Odpověz POUZE jako JSON objekt v tomto přesném formátu:
{"main_product":"...","tech_keywords":["..."],"export_oriented":false,"is_seasonal":false}

Pravidla:
- main_product: hlavní výrobek nebo služba (1 věta česky, max 80 znaků)
- tech_keywords: technologie POUZE z tohoto seznamu: [CNC, svařování, lisování, frézování, soustružení, obrábění, vrtání, broušení, hydraulika, pneumatika, laserové řezání, ohýbání, galvanizace, práškové lakování]
- export_oriented: true pokud text zmiňuje export, zahraniční trh, EU, international
- is_seasonal: true pokud je zřejmá sezónnost (zemědělství, lyžařství, sezóna, atd.)
- Pokud žádné tech_keywords neodpovídají, vrať prázdné pole []

Popis firmy: %s

JSON:`

// EnrichDescription extracts structured tags from a Czech business description.
// Returns an empty DescriptionTags (not an error) when the LLM response cannot be parsed
// so that callers can gracefully degrade.
func (c *Client) EnrichDescription(ctx context.Context, description string) (*DescriptionTags, error) {
	if strings.TrimSpace(description) == "" {
		return &DescriptionTags{}, nil
	}
	if len(description) > 800 {
		description = description[:800]
	}

	prompt := fmt.Sprintf(descriptionEnrichPrompt, description)
	response, _, err := c.Generate(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("enrich description generate: %w", err)
	}

	tags := parseDescriptionTags(response)
	tags.EnrichedAt = time.Now().UTC().Format(time.RFC3339)
	tags.Model = c.model
	return tags, nil
}

// parseDescriptionTags extracts a DescriptionTags from an LLM response string.
// Gracefully returns an empty struct when the JSON cannot be found or parsed.
func parseDescriptionTags(response string) *DescriptionTags {
	start := strings.Index(response, "{")
	end := strings.LastIndex(response, "}")
	if start == -1 || end == -1 || end <= start {
		return &DescriptionTags{}
	}
	var tags DescriptionTags
	if err := json.Unmarshal([]byte(response[start:end+1]), &tags); err != nil {
		return &DescriptionTags{}
	}
	return &tags
}

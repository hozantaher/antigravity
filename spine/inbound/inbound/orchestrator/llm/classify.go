package llm

import (
	"context"
	"fmt"
	"strings"
)

// IndustryResult is the LLM-classified industry.
type IndustryResult struct {
	Tags       []string
	Confidence float64
	Reasoning  string
}

// ValidTags are the accepted industry classifications.
var ValidTags = map[string]bool{
	"machinery": true, "construction": true, "agriculture": true,
	"transport": true, "manufacturing": true, "metalwork": true,
	"woodwork": true, "automotive": true, "energy": true,
	"waste": true, "food_processing": true, "plastics": true, "other": true,
}

const industryPrompt = `Classify this Czech business description into up to 3 industry tags.

Tags: machinery, construction, agriculture, transport, manufacturing, metalwork, woodwork, automotive, energy, waste, food_processing, plastics, other

Rules:
- Reply with ONLY comma-separated tag names in priority order, e.g.: machinery, metalwork
- Use 1 tag for clear cases, 2-3 for businesses spanning multiple industries
- Use "other" only if none of the tags fit

Description: %s

Tags:`

// ClassifyIndustry uses the LLM to classify a business description.
func (c *Client) ClassifyIndustry(ctx context.Context, description string) (*IndustryResult, error) {
	if description == "" {
		return &IndustryResult{Tags: []string{"other"}, Confidence: 0}, nil
	}

	// Truncate very long descriptions
	if len(description) > 500 {
		description = description[:500]
	}

	prompt := fmt.Sprintf(industryPrompt, description)
	response, _, err := c.Generate(ctx, prompt)
	if err != nil {
		return nil, fmt.Errorf("classify industry: %w", err)
	}

	// Parse tags from response (LLM may return comma-separated list)
	tags := extractTags(response)
	confidence := 0.8
	if len(tags) == 1 && tags[0] == "other" {
		confidence = 0.3
	}

	return &IndustryResult{
		Tags:       tags,
		Confidence: confidence,
		Reasoning:  response,
	}, nil
}

const sentimentPrompt = `Classify this Czech/English email reply into exactly ONE category.

Categories: interested, meeting, later, objection, negative, ooo

Definitions:
- "interested" = wants more info, asks questions, asks for price (cena), asks for catalog (ceník)
- "meeting" = wants to schedule a call or meeting (zavolejte, schůzka, sejděme se)
- "later" = neutral postpone with intent to revisit (vrátím se k tomu, příště, za měsíc, na podzim)
- "objection" = has concerns/pushback but is still engaged — pushback against price/fit/integration without rejecting outright
- "negative" = not interested, unsubscribe, blocking, refusal (nemám zájem, nezájem, nezajímá, odhlásit, neobtěžujte, neberu)
- "ooo" = out of office, vacation, auto-reply, automatic reply (mimo kancelář, dovolená, on vacation, on holiday, annual leave)

Disambiguation rules:
- If the reply mixes OOO with anything else, choose "ooo" (auto-reply takes precedence).
- If the reply contains a refusal phrase ("nemám zájem", "neberu", "not interested") even alongside other content, choose "negative".
- "Cena je vysoká neberu" = negative (refusal trumps price-question signal).
- "Cena je vysoká" alone (no refusal) = objection (price pushback while engaged).
- "Děkuji za info" / "OK" / acknowledgements without intent = interested (default-low).
- Reply with ONLY the lowercase category name on a single line. No "Category:" prefix.

Examples:
Email: Kolik to stojí?
Category: interested

Email: Cena je moc vysoká.
Category: objection

Email: Cena je vysoká neberu.
Category: negative

Email: Máme už podobné řešení.
Category: objection

Email: Mimo kancelář vrátím se 15.
Category: ooo

Email: Mimo kancelář ale mám zájem o ceník.
Category: ooo

Email: Odhlásit prosím později uvidíme.
Category: negative

Email: Nechci nic ale jindy možná schůzka.
Category: negative

Email: %s

Category:`

// ClassifySentiment uses the LLM to classify a reply's sentiment.
func (c *Client) ClassifySentiment(ctx context.Context, replyText string) (string, error) {
	if replyText == "" {
		return "other", nil
	}

	if len(replyText) > 500 {
		replyText = replyText[:500]
	}

	prompt := fmt.Sprintf(sentimentPrompt, replyText)
	response, _, err := c.Generate(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("classify sentiment: %w", err)
	}

	category := extractCategory(response)
	return category, nil
}

const summarizePrompt = `Summarize this Czech business description in 1-2 short sentences in Czech. Focus on: what they do, what products/services, what industry.

Description: %s

Summary:`

// SummarizeDescription creates a concise summary of a business description.
func (c *Client) SummarizeDescription(ctx context.Context, description string) (string, error) {
	if len(description) < 50 {
		return description, nil
	}
	if len(description) > 1000 {
		description = description[:1000]
	}

	prompt := fmt.Sprintf(summarizePrompt, description)
	response, _, err := c.Generate(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("summarize: %w", err)
	}

	return response, nil
}

func extractTags(response string) []string {
	response = strings.ToLower(strings.TrimSpace(response))
	var found []string
	seen := map[string]bool{}
	for _, part := range strings.Split(response, ",") {
		word := strings.Trim(strings.TrimSpace(part), ".*;:\"'")
		if spaceIdx := strings.Index(word, " "); spaceIdx > 0 {
			word = word[:spaceIdx]
		}
		if ValidTags[word] && !seen[word] {
			found = append(found, word)
			seen[word] = true
		}
		if len(found) == 3 {
			break
		}
	}
	// Fallback: scan full response for any valid tag (handles sentences like "The tag is construction.")
	if len(found) == 0 {
		for tag := range ValidTags {
			if tag != "other" && strings.Contains(response, tag) {
				found = append(found, tag)
				break
			}
		}
	}
	if len(found) == 0 {
		return []string{"other"}
	}
	return found
}

func extractCategory(response string) string {
	response = strings.ToLower(strings.TrimSpace(response))
	categories := []string{"interested", "meeting", "later", "objection", "negative", "ooo"}

	// Strip a leading "category:" / "category :" prefix the model occasionally
	// echoes back from the prompt, so the substring fallback below doesn't
	// accidentally match the prompt scaffolding.
	response = strings.TrimPrefix(response, "category:")
	response = strings.TrimPrefix(response, "category :")
	response = strings.TrimSpace(response)

	firstWord := strings.Fields(response)
	if len(firstWord) > 0 {
		word := strings.Trim(firstWord[0], ".*,;:\"'")
		for _, cat := range categories {
			if word == cat {
				return cat
			}
		}
	}

	for _, cat := range categories {
		if strings.Contains(response, cat) {
			return cat
		}
	}

	return "interested" // default
}

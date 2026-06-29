package handler

import (
	"log/slog"
	"net/http"
	"strings"
)

// ClassifyCategories enumeruje 6 kategorií reply classification per
// ADR-006 §D2. ClassUnknown není ve výčtu — handler ho použije jako
// fallback při low-confidence (< minConfidence).
//
// Vocabulary musí zůstat synchronizována se `services/orchestrator/llm/classify.go`
// (sentimentPrompt) a `apps/outreach-dashboard/src/lib/llmReplyClassifier.js`.
var ClassifyCategories = []string{
	"interested", "meeting", "later", "objection", "negative", "ooo",
}

// minClassifyConfidence je práh pod kterým se response označuje jako
// "unknown". 0.6 je inicialní heuristic; tunable v ENV (LLM4.x sprint).
const minClassifyConfidence = 0.6

// classifyPrompt je sentiment classifier prompt portovaný z
// services/orchestrator/llm/classify.go. Identický few-shot set
// — přemístit, ne reinventovat.
//
// Vstup: %s = reply text (truncated na 500 znaků handler vrstvou).
const classifyPrompt = `Classify this Czech/English email reply into exactly ONE category.

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

Email: ` + "%s" + `

Category:`

// ClassifyRequest je input pro POST /v1/classify.
type ClassifyRequest struct {
	Text string `json:"text"`
}

// ClassifyResponse je output JSON shape per ADR-006 §D2.
type ClassifyResponse struct {
	Category   string  `json:"category"`
	Confidence float64 `json:"confidence"`
	Model      string  `json:"model"`
	LowConf    bool    `json:"low_confidence,omitempty"`
}

// Classify vytváří HTTP handler pro POST /v1/classify.
// Klient + model jsou injected; logger se použije pro op-tagged events.
func Classify(client LLMClient, model string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ClassifyRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		text := strings.TrimSpace(req.Text)
		if text == "" {
			writeError(w, http.StatusBadRequest, "text is required")
			return
		}
		// Defensive cap — orchestrator/llm/classify.go má stejných 500 bytes.
		text = truncate(text, 500)

		prompt := strings.Replace(classifyPrompt, "%s", text, 1)
		raw, err := client.Generate(r.Context(), model, prompt)
		if err != nil {
			logger.Error("classify generate failed",
				"op", "llm-runner.classify/generate",
				"error", err)
			writeError(w, http.StatusBadGateway, "ollama call failed: "+err.Error())
			return
		}

		category, confidence := ParseClassification(raw)
		resp := ClassifyResponse{
			Category:   category,
			Confidence: confidence,
			Model:      model,
		}
		if confidence < minClassifyConfidence {
			resp.LowConf = true
		}
		logger.Info("classify ok",
			"op", "llm-runner.classify",
			"category", resp.Category,
			"confidence", resp.Confidence,
			"low_confidence", resp.LowConf)
		writeJSON(w, http.StatusOK, resp)
	}
}

// ParseClassification extrahuje kategorii z LLM raw response a přiřadí
// confidence skóre. Logika je portovaná z
// services/orchestrator/llm/classify.go.extractCategory s rozšířením
// confidence scoring:
//
//   - Přesný first-word match na valid category → confidence 0.9
//   - Substring match někde v response → confidence 0.5 (low_confidence flag)
//   - Žádný match → "unknown" + confidence 0.0
//
// Funkce je exported pro mutation testing + cross-suite reuse.
func ParseClassification(raw string) (category string, confidence float64) {
	r := strings.ToLower(strings.TrimSpace(raw))
	r = strings.TrimPrefix(r, "category:")
	r = strings.TrimPrefix(r, "category :")
	r = strings.TrimSpace(r)

	// First-word exact match → high confidence.
	fields := strings.Fields(r)
	if len(fields) > 0 {
		first := strings.Trim(fields[0], ".*,;:\"'")
		for _, cat := range ClassifyCategories {
			if first == cat {
				return cat, 0.9
			}
		}
	}

	// Substring fallback → medium confidence (under low_conf threshold).
	for _, cat := range ClassifyCategories {
		if strings.Contains(r, cat) {
			return cat, 0.5
		}
	}

	return "unknown", 0.0
}

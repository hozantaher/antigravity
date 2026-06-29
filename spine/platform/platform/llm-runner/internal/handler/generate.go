package handler

import (
	"log/slog"
	"net/http"
	"strings"
)

// minGenerateConfidence je heuristic threshold pro "low confidence"
// flag na draft generation. Tunable v ENV (LLM4.x sprint).
const minGenerateConfidence = 0.6

// defaultGenerateSystem je system prompt template pro AI návrh
// generator. Operator může override v request body (`SystemPrompt`).
const defaultGenerateSystem = `Jsi asistent operátora B2B prodeje stavební techniky.
Tvým úkolem je navrhnout zdvořilou krátkou odpověď v češtině na poslední
zprávu zákazníka. Drž se obchodního tónu, žádné emoji, bez závazku
ceny.`

// generatePromptTemplate skládá thread context + last reply do prompt.
// Variables: %CONTEXT% = thread historie, %REPLY% = last reply text.
const generatePromptTemplate = `Předchozí komunikace:
%CONTEXT%

Poslední odpověď zákazníka:
%REPLY%

Navrhni krátkou (2–4 věty) odpověď v češtině:`

// GenerateRequest je input pro POST /v1/generate.
// SystemPrompt je optional override pro defaultGenerateSystem.
type GenerateRequest struct {
	ThreadContext string `json:"thread_context"`
	LastReply     string `json:"last_reply"`
	SystemPrompt  string `json:"system_prompt,omitempty"`
}

// GenerateResponse je output JSON shape per ADR-006 §D2.
type GenerateResponse struct {
	DraftText  string  `json:"draft_text"`
	Confidence float64 `json:"confidence"`
	Model      string  `json:"model"`
	LowConf    bool    `json:"low_confidence,omitempty"`
}

// Generate vytváří HTTP handler pro POST /v1/generate (AI návrh draft).
// Confidence scoring je heuristic na response length + token markers
// — model nedává explicit confidence z generation API.
func Generate(client LLMClient, model string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req GenerateRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		lastReply := strings.TrimSpace(req.LastReply)
		if lastReply == "" {
			writeError(w, http.StatusBadRequest, "last_reply is required")
			return
		}

		// Defensive caps: thread_context max 4kB, last_reply max 2kB.
		// Vyšší limit než classify protože generator potřebuje plný kontext.
		ctxText := truncate(strings.TrimSpace(req.ThreadContext), 4000)
		lastReply = truncate(lastReply, 2000)

		systemPrompt := req.SystemPrompt
		if systemPrompt == "" {
			systemPrompt = defaultGenerateSystem
		}

		prompt := generatePromptTemplate
		prompt = strings.Replace(prompt, "%CONTEXT%", ctxText, 1)
		prompt = strings.Replace(prompt, "%REPLY%", lastReply, 1)

		// Zkombinuj system + user prompt do single Generate call.
		// /api/chat by byla čistší, ale Generate s `system` field je
		// dostatečný pro jednorázový draft (žádný multi-turn).
		fullPrompt := systemPrompt + "\n\n" + prompt

		raw, err := client.Generate(r.Context(), model, fullPrompt)
		if err != nil {
			logger.Error("generate failed",
				"op", "llm-runner.generate/call",
				"error", err)
			writeError(w, http.StatusBadGateway, "ollama call failed: "+err.Error())
			return
		}

		draft := strings.TrimSpace(raw)
		confidence := ScoreDraftConfidence(draft)
		resp := GenerateResponse{
			DraftText:  draft,
			Confidence: confidence,
			Model:      model,
		}
		if confidence < minGenerateConfidence {
			resp.LowConf = true
		}
		logger.Info("generate ok",
			"op", "llm-runner.generate",
			"draft_len", len(draft),
			"confidence", resp.Confidence,
			"low_confidence", resp.LowConf)
		writeJSON(w, http.StatusOK, resp)
	}
}

// ScoreDraftConfidence vrací heuristic confidence pro generated draft.
//
// Heuristic:
//   - Empty / whitespace → 0.0
//   - Less than 20 chars → 0.3 (likely truncated nebo bizarní)
//   - 20–40 chars → 0.5
//   - 40+ chars bez problematic patterns → 0.85
//   - Obsahuje "[error]", "I cannot", "unable to" → 0.2
//
// Není to ground-truth confidence, ale stable heuristic pro low-conf
// flagging do operator UI (per ADR-006 §D2 confidence scoring).
func ScoreDraftConfidence(draft string) float64 {
	d := strings.TrimSpace(draft)
	if d == "" {
		return 0.0
	}
	lower := strings.ToLower(d)
	for _, marker := range []string{"[error]", "i cannot", "unable to", "i am unable", "as an ai"} {
		if strings.Contains(lower, marker) {
			return 0.2
		}
	}
	switch {
	case len(d) < 20:
		return 0.3
	case len(d) < 40:
		return 0.5
	default:
		return 0.85
	}
}

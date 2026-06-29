package handler

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
)

// minParsePhotoConfidence je práh pro low-confidence flag na photo
// extraction. Default 0.6 (per-endpoint per task spec).
const minParsePhotoConfidence = 0.6

// maxImageBytes je defensive cap na decoded image size (5 MB).
// Vision modely jsou OOM-sensitive na large input — limit chrání RAM.
const maxImageBytes = 5 * 1024 * 1024

// parsePhotoPrompt instruuje vision model k structured JSON extraction.
// Output formát fixed pro deterministic parsing v handler vrstvě.
const parsePhotoPrompt = `Analyze this photo of construction or industrial machinery (excavator, loader, crane, truck, etc.).

Extract the following attributes and respond ONLY with valid JSON, no commentary:

{
  "year": 2018,
  "make": "Caterpillar",
  "model": "320D",
  "condition": "good",
  "odometer_km": 8500
}

Rules:
- "year" = manufacture year as integer, or 0 if unknown
- "make" = manufacturer brand name as string, or "" if unknown
- "model" = specific model designation, or "" if unknown
- "condition" = one of: "excellent", "good", "fair", "poor", "unknown"
- "odometer_km" = odometer reading in kilometers as integer, or 0 if not visible
- If field is not visible or unclear, use the unknown value (0 / "" / "unknown").
- Respond ONLY with the JSON object. No markdown fences, no extra text.`

// ParsePhotoRequest je input pro POST /v1/parse-photo.
// ImageBase64 je čistý base64 string (handler strip-uje "data:" prefix).
type ParsePhotoRequest struct {
	ImageBase64 string `json:"image_base64"`
}

// ParsePhotoResponse je output JSON shape per ADR-006 §D2 + task spec.
type ParsePhotoResponse struct {
	Year             int     `json:"year"`
	Make             string  `json:"make"`
	Model            string  `json:"model"`
	Condition        string  `json:"condition"`
	OdometerKM       int     `json:"odometer_km"`
	Confidence       float64 `json:"confidence"`
	RawExtractedJSON string  `json:"raw_extracted_json"`
	LowConf          bool    `json:"low_confidence,omitempty"`
}

// extractedAttrs je intermediate shape pro parsing model výstupu.
type extractedAttrs struct {
	Year       int    `json:"year"`
	Make       string `json:"make"`
	Model      string `json:"model"`
	Condition  string `json:"condition"`
	OdometerKM int    `json:"odometer_km"`
}

// ParsePhoto vytváří HTTP handler pro POST /v1/parse-photo.
// Vyžaduje vision-capable model (default llama3.2-vision:11b).
func ParsePhoto(client LLMClient, model string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ParsePhotoRequest
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}

		img := strings.TrimSpace(req.ImageBase64)
		if img == "" {
			writeError(w, http.StatusBadRequest, "image_base64 is required")
			return
		}
		// Strip "data:image/...;base64," prefix pokud je přítomen.
		if idx := strings.Index(img, "base64,"); idx >= 0 {
			img = img[idx+len("base64,"):]
		}

		// Validate base64 encoding + size cap.
		decoded, err := base64.StdEncoding.DecodeString(img)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid base64: "+err.Error())
			return
		}
		if len(decoded) > maxImageBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "image exceeds 5MB limit")
			return
		}

		raw, err := client.GenerateWithImage(r.Context(), model, parsePhotoPrompt, img)
		if err != nil {
			logger.Error("parse-photo generate failed",
				"op", "llm-runner.parse-photo/generate",
				"error", err)
			writeError(w, http.StatusBadGateway, "ollama call failed: "+err.Error())
			return
		}

		attrs, jsonStr, confidence := ParsePhotoResponseText(raw)
		resp := ParsePhotoResponse{
			Year:             attrs.Year,
			Make:             attrs.Make,
			Model:            attrs.Model,
			Condition:        attrs.Condition,
			OdometerKM:       attrs.OdometerKM,
			Confidence:       confidence,
			RawExtractedJSON: jsonStr,
		}
		if confidence < minParsePhotoConfidence {
			resp.LowConf = true
		}
		logger.Info("parse-photo ok",
			"op", "llm-runner.parse-photo",
			"year", resp.Year,
			"make", resp.Make,
			"confidence", resp.Confidence,
			"low_confidence", resp.LowConf)
		writeJSON(w, http.StatusOK, resp)
	}
}

// ParsePhotoResponseText extrahuje JSON object z raw model výstupu a
// dekóduje ho do ParsePhotoResponse atributů. Vrací intermediate
// extracted attrs, čistý JSON string (pro audit), a confidence score.
//
// Confidence:
//   - 0.0 — není JSON v raw response (model selhal)
//   - 0.3 — JSON je validní ale všechny fields jsou unknown
//   - 0.7 — JSON validní, 1–2 fields populated
//   - 0.9 — JSON validní, 3+ fields populated
//
// Funkce je exported pro test reuse + mutation testing.
func ParsePhotoResponseText(raw string) (attrs extractedAttrs, jsonStr string, confidence float64) {
	// Strip markdown code fences pokud model je přidá.
	r := strings.TrimSpace(raw)
	r = strings.TrimPrefix(r, "```json")
	r = strings.TrimPrefix(r, "```")
	r = strings.TrimSuffix(r, "```")
	r = strings.TrimSpace(r)

	// Najdi JSON object — first '{' to last '}'.
	start := strings.Index(r, "{")
	end := strings.LastIndex(r, "}")
	if start < 0 || end < 0 || end <= start {
		return extractedAttrs{Condition: "unknown"}, "", 0.0
	}
	jsonStr = r[start : end+1]

	if err := json.Unmarshal([]byte(jsonStr), &attrs); err != nil {
		return extractedAttrs{Condition: "unknown"}, "", 0.0
	}

	// Default condition na "unknown" pokud model vrátil nesmysl.
	cond := strings.ToLower(strings.TrimSpace(attrs.Condition))
	switch cond {
	case "excellent", "good", "fair", "poor", "unknown":
		attrs.Condition = cond
	default:
		attrs.Condition = "unknown"
	}

	// Score na počet populated fields (year>0, make!="", model!="",
	// condition!="unknown", odometer>0).
	populated := 0
	if attrs.Year > 0 {
		populated++
	}
	if attrs.Make != "" {
		populated++
	}
	if attrs.Model != "" {
		populated++
	}
	if attrs.Condition != "" && attrs.Condition != "unknown" {
		populated++
	}
	if attrs.OdometerKM > 0 {
		populated++
	}

	switch {
	case populated == 0:
		confidence = 0.3
	case populated <= 2:
		confidence = 0.7
	default:
		confidence = 0.9
	}
	return attrs, jsonStr, confidence
}

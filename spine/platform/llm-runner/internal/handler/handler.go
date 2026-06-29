// Package handler implements the `/v1/*` HTTP endpointy llm-runner
// service. Handlers jsou tenké — request decode, validation, prompt
// template injection, Ollama call přes client, response parse, write
// JSON. Jediný stateful kus je injected ollama.Client.
//
// Per ADR-006 §D1 jsou tyto handlery jediný consumer Ollama daemonu;
// audit log insert + rate limiting přijdou v LLM3.x sprint.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// LLMClient je interface pro Ollama klient (pro test injection).
// Real impl: `internal/ollama.Client`.
type LLMClient interface {
	Generate(ctx context.Context, model, prompt string) (string, error)
	GenerateWithImage(ctx context.Context, model, prompt, imageB64 string) (string, error)
}

// errorResponse je standardní JSON shape pro 4xx/5xx odpovědi.
type errorResponse struct {
	Error string `json:"error"`
}

// writeJSON serializuje payload jako JSON s daným HTTP status.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// writeError je helper pro uniform error response.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}

// decodeJSON dekóduje request body do dst. Vrací chybu pokud body je
// prázdný / není JSON / má neznámá pole.
func decodeJSON(r *http.Request, dst any) error {
	if r.Body == nil {
		return errors.New("empty body")
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

// truncate zkracuje string na max byte length (UTF-8 safe boundary).
// Použito pro defensive input cap před voláním modelu.
func truncate(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	// Najdi UTF-8 boundary (žádný split mid-rune).
	for i := maxBytes; i > 0; i-- {
		if s[i]&0xC0 != 0x80 {
			return s[:i]
		}
	}
	return s[:maxBytes]
}

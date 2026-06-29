// Provider-side contract test for the privacy-gateway → anti-trace-relay HTTP
// boundary.
//
// This test treats privacy-gateway as the CONSUMER and anti-trace-relay as the
// PROVIDER. It uses the consumer's expected wire format (declared locally so
// a refactor of provider internals cannot silently redefine the contract) and
// fires real HTTP requests through httptest.NewServer + http.Client.
//
// Wire contract asserted:
//
//	POST /v1/submit
//	  Headers: Authorization: Bearer <token>, Content-Type: application/json
//	  JSON body fields: recipient, subject, body, body_html?, headers?, from_address?
//	Responses:
//	  202 Accepted  → { "envelope_id": non-empty, "status": "sealed", "size_class": int }
//	  401 Unauthorized  → { "error": "unauthorized" } on missing/invalid bearer
//	  400 Bad Request   → { "error": ... } when required fields missing or recipient malformed
//	  422 Unprocessable Entity → { "error": "content blocked by policy" } on sanitizer block
//
// If privacy-gateway ever changes its encoder, or anti-trace-relay ever changes
// its decoder, one of these assertions fails loudly.
package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// consumerRequest is the shape privacy-gateway sends. Declared locally on
// purpose — do NOT import from internal/model. If model.IntakeRequest drifts,
// this test must still speak the consumer's dialect.
type consumerRequest struct {
	Recipient   string            `json:"recipient"`
	Subject     string            `json:"subject"`
	Body        string            `json:"body"`
	BodyHTML    string            `json:"body_html,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	FromAddress string            `json:"from_address,omitempty"`
}

// consumerSuccessResponse is what the consumer expects on 202.
type consumerSuccessResponse struct {
	EnvelopeID string `json:"envelope_id"`
	Status     string `json:"status"`
	SizeClass  int    `json:"size_class"`
}

// consumerErrorResponse is what the consumer expects on any non-2xx.
type consumerErrorResponse struct {
	Error string `json:"error"`
}

// startContractServer boots a real anti-trace-relay Server behind an
// httptest.NewServer so the test exercises the full net/http stack (headers,
// body framing, status codes), not just ServeHTTP.
//
// The lifecycle is wired via t.Cleanup (not `defer`) so the server outlives
// t.Parallel subtests that execute after the enclosing test function returns.
func startContractServer(t *testing.T) (baseURL string, token string) {
	t.Helper()
	server, tok := testServer(t)
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	return ts.URL, tok
}

// TestPrivacyGatewayContract_AcceptedRequest confirms the provider accepts the
// exact wire format privacy-gateway will send, and returns the response
// fields the consumer expects.
func TestPrivacyGatewayContract_AcceptedRequest(t *testing.T) {
	t.Parallel()

	baseURL, token := startContractServer(t)

	cases := []struct {
		name    string
		payload consumerRequest
	}{
		{
			name: "minimal required fields",
			payload: consumerRequest{
				Recipient: "buyer@dealership.example",
				Subject:   "Quote request",
				Body:      "Please send the quote.",
			},
		},
		{
			name: "with html alternative",
			payload: consumerRequest{
				Recipient: "buyer@dealership.example",
				Subject:   "Quote",
				Body:      "plain",
				BodyHTML:  "<p>plain</p>",
			},
		},
		{
			name: "with fingerprint headers and from_address",
			payload: consumerRequest{
				Recipient:   "buyer@dealership.example",
				Subject:     "Quote",
				Body:        "plain",
				FromAddress: "sales@dealer.example",
				Headers: map[string]string{
					"X-Mailer":   "machinery-outreach/1.0",
					"Message-ID": "<abc@dealer.example>",
				},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			body, err := json.Marshal(tc.payload)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/submit", bytes.NewReader(body))
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")

			resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)

			if resp.StatusCode != http.StatusAccepted {
				t.Fatalf("status: got %d want 202: %s", resp.StatusCode, string(raw))
			}
			if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
				t.Fatalf("Content-Type: got %q want application/json", ct)
			}

			var got consumerSuccessResponse
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("response not decodable into consumer struct: %v (raw=%s)", err, string(raw))
			}
			if got.EnvelopeID == "" {
				t.Fatalf("envelope_id missing in 202 response; raw=%s", string(raw))
			}
			if got.Status != "sealed" {
				t.Fatalf("status: got %q want sealed; raw=%s", got.Status, string(raw))
			}
			if got.SizeClass <= 0 {
				t.Fatalf("size_class: got %d, expected > 0; raw=%s", got.SizeClass, string(raw))
			}
		})
	}
}

// TestPrivacyGatewayContract_ErrorStatuses verifies the provider emits the
// documented status codes and shapes for every failure mode the consumer
// handles.
func TestPrivacyGatewayContract_ErrorStatuses(t *testing.T) {
	t.Parallel()

	baseURL, token := startContractServer(t)

	type expect struct {
		status    int
		errorSubs string
	}

	cases := []struct {
		name    string
		auth    string
		payload consumerRequest
		want    expect
	}{
		{
			name: "missing bearer → 401",
			auth: "", // deliberately omit
			payload: consumerRequest{
				Recipient: "buyer@dealership.example",
				Subject:   "Q",
				Body:      "b",
			},
			want: expect{status: http.StatusUnauthorized, errorSubs: "unauthorized"},
		},
		{
			name: "invalid bearer → 401",
			auth: "Bearer not-a-real-token",
			payload: consumerRequest{
				Recipient: "buyer@dealership.example",
				Subject:   "Q",
				Body:      "b",
			},
			want: expect{status: http.StatusUnauthorized, errorSubs: "unauthorized"},
		},
		{
			name: "missing required body → 400",
			auth: "Bearer {{token}}",
			payload: consumerRequest{
				Recipient: "buyer@dealership.example",
				Subject:   "Q",
				// Body omitted
			},
			want: expect{status: http.StatusBadRequest, errorSubs: "required"},
		},
		{
			name: "malformed recipient → 400",
			auth: "Bearer {{token}}",
			payload: consumerRequest{
				Recipient: "not-an-email",
				Subject:   "Q",
				Body:      "b",
			},
			want: expect{status: http.StatusBadRequest, errorSubs: "recipient"},
		},
		{
			name: "blocked content → 422",
			auth: "Bearer {{token}}",
			payload: consumerRequest{
				Recipient: "buyer@dealership.example",
				Subject:   "Q",
				Body:      "<script>alert('xss')</script>",
			},
			want: expect{status: http.StatusUnprocessableEntity, errorSubs: "blocked"},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			body, err := json.Marshal(tc.payload)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/submit", bytes.NewReader(body))
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			if tc.auth != "" {
				authHeader := tc.auth
				// Substitute the real token so we don't leak it in the table.
				if authHeader == "Bearer {{token}}" {
					authHeader = "Bearer " + token
				}
				req.Header.Set("Authorization", authHeader)
			}

			resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
			if err != nil {
				t.Fatalf("do: %v", err)
			}
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)

			if resp.StatusCode != tc.want.status {
				t.Fatalf("status: got %d want %d (raw=%s)", resp.StatusCode, tc.want.status, string(raw))
			}
			var gotErr consumerErrorResponse
			if err := json.Unmarshal(raw, &gotErr); err != nil {
				t.Fatalf("error body not decodable: %v (raw=%s)", err, string(raw))
			}
			if gotErr.Error == "" {
				t.Fatalf("error body must have non-empty %q field (raw=%s)", "error", string(raw))
			}
			if tc.want.errorSubs != "" && !containsFold(gotErr.Error, tc.want.errorSubs) {
				t.Fatalf("error body %q does not contain %q", gotErr.Error, tc.want.errorSubs)
			}
		})
	}
}

// TestPrivacyGatewayContract_IgnoresUnknownFields documents that adding new
// optional fields on the consumer side (forward compat) does not break the
// provider. Go's encoding/json silently ignores unknown keys by default.
func TestPrivacyGatewayContract_IgnoresUnknownFields(t *testing.T) {
	t.Parallel()

	baseURL, token := startContractServer(t)

	// Hand-rolled JSON with a field the provider does not know about.
	raw := []byte(`{
      "recipient":"buyer@dealership.example",
      "subject":"Quote",
      "body":"hi",
      "future_field":"some-value-the-provider-does-not-know"
    }`)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/submit", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("provider must accept unknown fields for forward compat; got %d: %s", resp.StatusCode, string(got))
	}
}

// containsFold is a tiny case-insensitive substring check (stdlib strings.Contains
// avoided a lint-preferred allocator in our earlier revs). We keep a local
// helper so the test stays self-contained.
func containsFold(haystack, needle string) bool {
	h, n := toLower(haystack), toLower(needle)
	if len(n) == 0 {
		return true
	}
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}

func toLower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}

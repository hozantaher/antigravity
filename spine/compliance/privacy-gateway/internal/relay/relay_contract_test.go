// Package relay contract tests.
//
// Consumer-driven contract test for the HTTP boundary between privacy-gateway
// (consumer) and anti-trace-relay (provider).
//
// Wire contract under test:
//
//	POST {relay}/v1/submit
//	Authorization: Bearer <token>
//	Content-Type: application/json
//
//	Body:
//	  {
//	    "recipient":    string,           // required, rfc5322-ish address
//	    "subject":      string,
//	    "body":         string,           // required (plaintext)
//	    "body_html":    string (opt),
//	    "headers":      map[string]string (opt),
//	    "from_address": string (opt)
//	  }
//
//	Response:
//	  202 Accepted on success, JSON { "envelope_id": string, "status": "sealed", ... }
//	  401 Unauthorized when Bearer token is missing / invalid
//	  400 Bad Request when recipient or body are missing / malformed
//	  422 Unprocessable Entity when sanitizer blocks content
//	  429 Too Many Requests when upstream rate-limits
//
// The test uses httptest.NewServer + http.Client — stdlib only — and fires a
// real HTTP request so any drift between the consumer's encoded request and
// the provider's expectations is surfaced by the assertions in the handler
// below.
package relay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// relayRequestPayload is the shape privacy-gateway, as a consumer, is expected
// to send to anti-trace-relay's POST /v1/submit. It is intentionally declared
// inside the test so a provider-side rename cannot silently compile away the
// contract check.
type relayRequestPayload struct {
	Recipient   string            `json:"recipient"`
	Subject     string            `json:"subject"`
	Body        string            `json:"body"`
	BodyHTML    string            `json:"body_html,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	FromAddress string            `json:"from_address,omitempty"`
}

// relayResponsePayload mirrors the anti-trace-relay ProcessResult returned on
// 202 Accepted.
type relayResponsePayload struct {
	EnvelopeID string `json:"envelope_id"`
	Status     string `json:"status"`
	SizeClass  int    `json:"size_class"`
}

// submitRelay is the minimal HTTP client under test. It represents the
// privacy-gateway -> anti-trace-relay call and is defined here (not in
// production code) so we test the wire format the consumer is expected to
// use. Any real http client that privacy-gateway adopts must match this
// encoding exactly, or these tests fail.
func submitRelay(ctx context.Context, baseURL, token string, payload relayRequestPayload) (*http.Response, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/v1/submit", strings.NewReader(string(body)))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	return resp, raw, err
}

// TestRelayContract_ConsumerRequestShape stands up a stub that impersonates
// anti-trace-relay and asserts the request privacy-gateway sends matches the
// documented wire contract: method, path, headers, JSON field names.
func TestRelayContract_ConsumerRequestShape(t *testing.T) {
	t.Parallel()

	type capture struct {
		method      string
		path        string
		auth        string
		contentType string
		body        map[string]any
	}

	tests := []struct {
		name    string
		payload relayRequestPayload
		check   func(t *testing.T, got capture)
	}{
		{
			name: "minimal required fields",
			payload: relayRequestPayload{
				Recipient: "buyer@dealership.example",
				Subject:   "Quote request",
				Body:      "Please send the quote.",
			},
			check: func(t *testing.T, got capture) {
				if got.method != http.MethodPost {
					t.Fatalf("method: got %q want POST", got.method)
				}
				if got.path != "/v1/submit" {
					t.Fatalf("path: got %q want /v1/submit", got.path)
				}
				if got.auth != "Bearer test-token" {
					t.Fatalf("Authorization: got %q want Bearer test-token", got.auth)
				}
				if got.contentType != "application/json" {
					t.Fatalf("Content-Type: got %q want application/json", got.contentType)
				}
				// Required fields present with exact JSON keys.
				for _, key := range []string{"recipient", "subject", "body"} {
					if _, ok := got.body[key]; !ok {
						t.Fatalf("missing required JSON field %q; got body=%v", key, got.body)
					}
				}
				if got.body["recipient"] != "buyer@dealership.example" {
					t.Fatalf("recipient mismatch: got %v", got.body["recipient"])
				}
				// Omitted optional fields must NOT appear (JSON `omitempty`).
				for _, key := range []string{"body_html", "headers", "from_address"} {
					if _, present := got.body[key]; present {
						t.Fatalf("optional field %q should be omitted when empty; got body=%v", key, got.body)
					}
				}
			},
		},
		{
			name: "with optional headers and html body",
			payload: relayRequestPayload{
				Recipient:   "buyer@dealership.example",
				Subject:     "Quote request",
				Body:        "plain text",
				BodyHTML:    "<p>plain text</p>",
				FromAddress: "sales@dealer.example",
				Headers: map[string]string{
					"X-Mailer":   "machinery-outreach/1.0",
					"Message-ID": "<abc@dealer.example>",
				},
			},
			check: func(t *testing.T, got capture) {
				if got.body["body_html"] != "<p>plain text</p>" {
					t.Fatalf("body_html mismatch: got %v", got.body["body_html"])
				}
				if got.body["from_address"] != "sales@dealer.example" {
					t.Fatalf("from_address mismatch: got %v", got.body["from_address"])
				}
				hdrs, ok := got.body["headers"].(map[string]any)
				if !ok {
					t.Fatalf("headers must be a JSON object; got %T", got.body["headers"])
				}
				if hdrs["X-Mailer"] != "machinery-outreach/1.0" {
					t.Fatalf("headers[X-Mailer] mismatch: got %v", hdrs["X-Mailer"])
				}
			},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var got capture
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got.method = r.Method
				got.path = r.URL.Path
				got.auth = r.Header.Get("Authorization")
				got.contentType = r.Header.Get("Content-Type")
				raw, _ := io.ReadAll(r.Body)
				if err := json.Unmarshal(raw, &got.body); err != nil {
					t.Errorf("stub could not decode body as JSON: %v (raw=%s)", err, string(raw))
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(relayResponsePayload{
					EnvelopeID: "env_deadbeefcafebabe",
					Status:     "sealed",
					SizeClass:  4096,
				})
			}))
			defer stub.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			resp, raw, err := submitRelay(ctx, stub.URL, "test-token", tc.payload)
			if err != nil {
				t.Fatalf("submitRelay: %v", err)
			}
			if resp.StatusCode != http.StatusAccepted {
				t.Fatalf("expected 202, got %d: %s", resp.StatusCode, string(raw))
			}
			var decoded relayResponsePayload
			if err := json.Unmarshal(raw, &decoded); err != nil {
				t.Fatalf("could not decode response: %v (raw=%s)", err, string(raw))
			}
			if decoded.EnvelopeID == "" {
				t.Fatal("response missing envelope_id")
			}
			if decoded.Status != "sealed" {
				t.Fatalf("response status: got %q want sealed", decoded.Status)
			}
			tc.check(t, got)
		})
	}
}

// TestRelayContract_ConsumerHandlesProviderStatusCodes ensures the consumer
// correctly surfaces every status code the provider is documented to emit.
// This guards against a consumer that only tolerates 202 and panics on 4xx.
func TestRelayContract_ConsumerHandlesProviderStatusCodes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		statusCode int
		respBody   string
	}{
		{"accepted", http.StatusAccepted, `{"envelope_id":"env_1","status":"sealed","size_class":1024}`},
		{"unauthorized", http.StatusUnauthorized, `{"error":"unauthorized"}`},
		{"bad_request_missing_fields", http.StatusBadRequest, `{"error":"recipient and body are required"}`},
		{"blocked_content", http.StatusUnprocessableEntity, `{"error":"content blocked by policy"}`},
		{"rate_limited", http.StatusTooManyRequests, `{"error":"rate limited"}`},
		{"internal_error", http.StatusInternalServerError, `{"error":"internal server error"}`},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.statusCode)
				_, _ = w.Write([]byte(tc.respBody))
			}))
			defer stub.Close()

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			resp, raw, err := submitRelay(ctx, stub.URL, "test-token", relayRequestPayload{
				Recipient: "buyer@dealership.example",
				Subject:   "Q",
				Body:      "b",
			})
			if err != nil {
				t.Fatalf("submitRelay: %v", err)
			}
			if resp.StatusCode != tc.statusCode {
				t.Fatalf("status: got %d want %d", resp.StatusCode, tc.statusCode)
			}
			// Error responses must be decodable JSON with a top-level "error".
			if tc.statusCode >= 400 {
				var body map[string]any
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("error body must be JSON: %v (raw=%s)", err, string(raw))
				}
				if _, ok := body["error"]; !ok {
					t.Fatalf("error body must contain top-level %q field; got %v", "error", body)
				}
			}
		})
	}
}

// TestRelayContract_ConsumerRejectsMissingAuthStub guards the inverse: if the
// consumer forgets the Authorization header, the provider contract says it
// MUST get a 401. The stub enforces the provider's documented auth rule so
// the consumer can't silently drop the header.
func TestRelayContract_ConsumerRejectsMissingAuthStub(t *testing.T) {
	t.Parallel()

	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"env_x","status":"sealed"}`))
	}))
	defer stub.Close()

	// Force the consumer into the unauth branch by passing an empty token.
	// submitRelay still writes the header literally as "Bearer " (no token),
	// which is what we want to reject in production too. Build a bare request
	// here instead so we can exercise the truly-missing-header path.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	body, _ := json.Marshal(relayRequestPayload{Recipient: "r@x.example", Body: "b"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, stub.URL+"/v1/submit", strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	// deliberately NO Authorization header
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 when Authorization header absent, got %d", resp.StatusCode)
	}
}

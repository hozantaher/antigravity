package maillabclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML5.1 — Go client for mail-lab-api.
// ════════════════════════════════════════════════════════════════════════

// fixture spins up a httptest.Server with a per-test handler. The test
// gets back the server URL + a client wired to it.
func fixture(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := New(srv.URL, "secret-key")
	return c, srv
}

// 1. Constructor strips trailing slash from baseURL (matters for path joining).
func TestS51_New_StripsTrailingSlash(t *testing.T) {
	c := New("http://example.com/", "k")
	if c.baseURL != "http://example.com" {
		t.Errorf("baseURL %q, want stripped slash", c.baseURL)
	}
}

// 2. Auth header attached when apiKey set.
func TestS51_AuthHeader_Set(t *testing.T) {
	var gotKey atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotKey.Store(r.Header.Get("X-Lab-Api-Key"))
		w.Write([]byte(`{"status":"ok","uptime_seconds":1}`))
	})
	c.Health(context.Background())
	if v, _ := gotKey.Load().(string); v != "secret-key" {
		t.Errorf("X-Lab-Api-Key %q, want secret-key", v)
	}
}

// 3. Auth header omitted when apiKey empty.
func TestS51_AuthHeader_Empty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v := r.Header.Get("X-Lab-Api-Key"); v != "" {
			t.Errorf("header set when key empty: %q", v)
		}
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "")
	c.Health(context.Background())
}

// 4. Health roundtrip decodes correctly.
func TestS51_Health_Roundtrip(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("path %q, want /healthz", r.URL.Path)
		}
		json.NewEncoder(w).Encode(HealthResponse{Status: "ok", UptimeSeconds: 42})
	})
	got, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if got.Status != "ok" || got.UptimeSeconds != 42 {
		t.Errorf("got %+v", got)
	}
}

// 5. CreateMailbox sends POST + body.
func TestS51_CreateMailbox_PostBody(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/mailbox" {
			t.Errorf("expected POST /v1/mailbox, got %s %s", r.Method, r.URL.Path)
		}
		var req map[string]string
		json.NewDecoder(r.Body).Decode(&req)
		if req["address"] != "a@x.lab" || req["password"] != "pw" {
			t.Errorf("body %+v", req)
		}
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(MailboxResponse{Address: "a@x.lab", Domain: "x.lab", Created: true})
	})
	got, err := c.CreateMailbox(context.Background(), "a@x.lab", "pw")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !got.Created {
		t.Error("created=false")
	}
}

// 6. GetMailbox URL-escapes address.
func TestS51_GetMailbox_URLEscapes(t *testing.T) {
	var gotPath atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath.Store(r.URL.Path)
		json.NewEncoder(w).Encode(MailboxResponse{Address: "a+test@x.lab"})
	})
	c.GetMailbox(context.Background(), "a+test@x.lab")
	if v, _ := gotPath.Load().(string); !strings.Contains(v, "a+test@x.lab") && !strings.Contains(v, "a%2Btest@x.lab") {
		t.Errorf("path %q didn't include escaped address", v)
	}
}

// 7. DeleteMailbox sends DELETE + accepts 204 No Content.
func TestS51_DeleteMailbox_Method(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			t.Errorf("method %q, want DELETE", r.Method)
		}
		w.WriteHeader(204)
	})
	if err := c.DeleteMailbox(context.Background(), "a@x.lab"); err != nil {
		t.Errorf("delete: %v", err)
	}
}

// 8. ListProfiles unwraps the {"profiles":[...]} envelope.
func TestS51_ListProfiles_Unwrap(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string][]Profile{
			"profiles": {{Domain: "a.lab"}, {Domain: "b.lab"}},
		})
	})
	got, err := c.ListProfiles(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 || got[0].Domain != "a.lab" {
		t.Errorf("got %+v", got)
	}
}

// 9. ApplyOverride POSTs the map verbatim.
func TestS51_ApplyOverride_Body(t *testing.T) {
	var gotBody atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		var v map[string]interface{}
		json.NewDecoder(r.Body).Decode(&v)
		gotBody.Store(v)
		json.NewEncoder(w).Encode(Profile{Domain: "x.lab", RateLimitPerHour: 999})
	})
	c.ApplyOverride(context.Background(), "x.lab", map[string]interface{}{"rate_limit_per_hour": 999})
	body, _ := gotBody.Load().(map[string]interface{})
	if body == nil || body["rate_limit_per_hour"] != float64(999) {
		t.Errorf("body %+v", body)
	}
}

// 10. Check sends MessageContext + parses CheckResponse.
func TestS51_Check_Roundtrip(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(CheckResponse{Decision: "reject", Reason: "size"})
	})
	got, err := c.Check(context.Background(), "x.lab", MessageContext{SizeBytes: 999})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if got.Decision != "reject" || got.Reason != "size" {
		t.Errorf("got %+v", got)
	}
}

// 11. PreviewDSN body wraps {envelope, context}.
func TestS51_PreviewDSN_Wraps(t *testing.T) {
	var gotBody atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		var v map[string]interface{}
		json.NewDecoder(r.Body).Decode(&v)
		gotBody.Store(v)
		json.NewEncoder(w).Encode(PreviewDSNResponse{
			Decision: "reject",
			DSN:      &DSN{Body: "DSN BODY", StatusCode: "5.7.1"},
		})
	})
	got, _ := c.PreviewDSN(context.Background(), "x.lab",
		DSNEnvelope{OriginalTo: "x@y", OriginalFrom: "s@z"},
		MessageContext{SizeBytes: 100})
	body, _ := gotBody.Load().(map[string]interface{})
	if _, ok := body["envelope"]; !ok {
		t.Errorf("body missing envelope key: %+v", body)
	}
	if _, ok := body["context"]; !ok {
		t.Errorf("body missing context key: %+v", body)
	}
	if got.DSN.StatusCode != "5.7.1" {
		t.Errorf("DSN %+v", got.DSN)
	}
}

// 12. Evaluate roundtrip.
func TestS51_Evaluate_Roundtrip(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(EvaluateResponse{
			Decision: "greylist", FiredBy: "greylist", Reason: "first contact",
		})
	})
	got, _ := c.Evaluate(context.Background(), "outlook.lab", EvaluateRequest{
		SenderMailbox: "a@x", RecipientAddr: "r@outlook.lab",
	})
	if got.Decision != "greylist" || got.FiredBy != "greylist" {
		t.Errorf("got %+v", got)
	}
}

// 13. RateGet path includes domain + mailbox.
func TestS51_RateGet_Path(t *testing.T) {
	var gotPath atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath.Store(r.URL.Path)
		json.NewEncoder(w).Encode(RateResponse{Mailbox: "a@x", Count: 5, Limit: 100, Remaining: 95})
	})
	got, _ := c.RateGet(context.Background(), "x.lab", "a@x")
	if got.Count != 5 {
		t.Errorf("count %d", got.Count)
	}
	if v, _ := gotPath.Load().(string); !strings.Contains(v, "x.lab") || !strings.Contains(v, "a@x") {
		t.Errorf("path %q missing domain/mailbox", v)
	}
}

// 14. RateRecord uses POST.
func TestS51_RateRecord_PostMethod(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method %q, want POST", r.Method)
		}
		json.NewEncoder(w).Encode(RateResponse{Count: 1})
	})
	c.RateRecord(context.Background(), "x.lab", "a@x")
}

// 15. QuotaAdd refuses bytes <= 0 client-side.
func TestS51_QuotaAdd_RefusesZero(t *testing.T) {
	c := New("http://nowhere", "k")
	if _, err := c.QuotaAdd(context.Background(), "x.lab", "a@x", 0); err == nil {
		t.Error("QuotaAdd(0) should error before HTTP")
	}
	if _, err := c.QuotaAdd(context.Background(), "x.lab", "a@x", -1); err == nil {
		t.Error("QuotaAdd(-1) should error before HTTP")
	}
}

// 16. QuotaGet path + decode.
func TestS51_QuotaGet_Path(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(QuotaResponse{Used: 1024, Cap: 1073741824})
	})
	got, _ := c.QuotaGet(context.Background(), "seznam.lab", "a@seznam.lab")
	if got.Used != 1024 || got.Cap != 1073741824 {
		t.Errorf("got %+v", got)
	}
}

// 17. Greylist refuses missing recipient_addr client-side.
func TestS51_Greylist_RequiresRecipient(t *testing.T) {
	c := New("http://nowhere", "k")
	_, err := c.Greylist(context.Background(), "x.lab", GreylistRequest{
		SenderIP: "1.2.3.4",
	})
	if err == nil {
		t.Error("Greylist without recipient should error before HTTP")
	}
}

// 18. ResetAll sends source field.
func TestS51_ResetAll_BodyField(t *testing.T) {
	var gotBody atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		var v map[string]string
		json.NewDecoder(r.Body).Decode(&v)
		gotBody.Store(v)
		w.WriteHeader(200)
		w.Write([]byte(`{"status":"ok","source":"embedded"}`))
	})
	c.ResetAll(context.Background(), "embedded")
	body, _ := gotBody.Load().(map[string]string)
	if body["source"] != "embedded" {
		t.Errorf("source %q, want embedded", body["source"])
	}
}

// 19. DeliverBounce sends BounceRequest, parses BounceResponse.
func TestS51_DeliverBounce_Roundtrip(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		var req BounceRequest
		json.NewDecoder(r.Body).Decode(&req)
		if req.RecipientDomain != "seznam.lab" {
			t.Errorf("req.RecipientDomain %q", req.RecipientDomain)
		}
		json.NewEncoder(w).Encode(BounceResponse{
			Decision: "reject", Delivered: true,
			Container: "mail-lab-gmail", DSNBody: "BOUNCE",
		})
	})
	got, _ := c.DeliverBounce(context.Background(), BounceRequest{
		RecipientDomain: "seznam.lab",
		OriginalTo:      "rej@seznam.lab",
		OriginalFrom:    "marketer@gmail.lab",
	})
	if !got.Delivered || got.Container != "mail-lab-gmail" {
		t.Errorf("got %+v", got)
	}
}

// 20. HTTP 404 → ErrUnknownDomain via errors.Is.
func TestS51_404_MapsToErrUnknownDomain(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"error":"unknown domain never.lab"}`))
	})
	_, err := c.GetProfile(context.Background(), "never.lab")
	if !errors.Is(err, ErrUnknownDomain) {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 21. HTTP 401 → ErrUnauthorized.
func TestS51_401_MapsToErrUnauthorized(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"missing or invalid X-Lab-Api-Key"}`))
	})
	_, err := c.Health(context.Background())
	if !errors.Is(err, ErrUnauthorized) {
		t.Errorf("got %v, want ErrUnauthorized", err)
	}
}

// 22. HTTP 400 → ErrBadRequest.
func TestS51_400_MapsToErrBadRequest(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		w.Write([]byte(`{"error":"bytes must be > 0"}`))
	})
	_, err := c.ApplyOverride(context.Background(), "x.lab", map[string]interface{}{})
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("got %v, want ErrBadRequest", err)
	}
}

// 23. HTTP 500 → opaque error (no sentinel match).
func TestS51_500_OpaqueError(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
	})
	_, err := c.Health(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	for _, sentinel := range []error{ErrUnknownDomain, ErrUnauthorized, ErrBadRequest} {
		if errors.Is(err, sentinel) {
			t.Errorf("500 should not match %v", sentinel)
		}
	}
}

// 24. Context cancellation propagates.
func TestS51_Context_Cancellation(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // wait for client-side cancel
		w.WriteHeader(200)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := c.Health(ctx)
	if err == nil {
		t.Error("expected timeout error")
	}
}

// 25. WithHTTP swaps http.Client.
func TestS51_WithHTTP_Swap(t *testing.T) {
	c := New("http://nowhere", "k")
	swapped := &http.Client{Timeout: 1 * time.Second}
	c2 := c.WithHTTP(swapped)
	if c2.http != swapped {
		t.Error("WithHTTP did not replace client")
	}
	if c2 != c {
		t.Error("WithHTTP should return same Client (chaining)")
	}
}

// 26. Content-Type header set on POST with body.
func TestS51_ContentType_PostBody(t *testing.T) {
	var gotCT atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotCT.Store(r.Header.Get("Content-Type"))
		json.NewEncoder(w).Encode(MailboxResponse{})
	})
	c.CreateMailbox(context.Background(), "a@x", "p")
	if v, _ := gotCT.Load().(string); v != "application/json" {
		t.Errorf("Content-Type %q, want application/json", v)
	}
}

// 27. GET with no body → no Content-Type set.
func TestS51_NoContentType_GET(t *testing.T) {
	var gotCT atomic.Value
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		gotCT.Store(r.Header.Get("Content-Type"))
		w.Write([]byte(`{"status":"ok"}`))
	})
	c.Health(context.Background())
	if v, _ := gotCT.Load().(string); v != "" {
		t.Errorf("GET should not set Content-Type, got %q", v)
	}
}

// 28. Garbage JSON in response body → decode error wrapped.
func TestS51_BadResponseJSON_Errors(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "not json at all")
	})
	_, err := c.Health(context.Background())
	if err == nil {
		t.Error("expected decode error")
	}
}

// 29. Constructor does not panic on empty baseURL (defensive).
func TestS51_New_EmptyBaseURL(t *testing.T) {
	c := New("", "k")
	if c == nil {
		t.Error("constructor should not return nil")
	}
	if c.baseURL != "" {
		t.Errorf("baseURL %q, want empty", c.baseURL)
	}
}

// 30. ApplyOverride passes nil map without crashing (zero-key override).
func TestS51_ApplyOverride_NilMap(t *testing.T) {
	c, _ := fixture(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Profile{Domain: "x.lab"})
	})
	if _, err := c.ApplyOverride(context.Background(), "x.lab", nil); err != nil {
		t.Errorf("nil override errored: %v", err)
	}
}

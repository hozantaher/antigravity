package handler

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// helper — encode arbitrary bytes as base64 JSON-safe string.
func b64(s string) string {
	return base64.StdEncoding.EncodeToString([]byte(s))
}

// --- ParsePhotoResponseText table-driven (≥10 cases) ---

func TestParsePhotoResponseText_TableDriven(t *testing.T) {
	cases := []struct {
		name        string
		raw         string
		wantYear    int
		wantMake    string
		wantCond    string
		wantConfMin float64
	}{
		{
			"happy path with all fields",
			`{"year":2018,"make":"Caterpillar","model":"320D","condition":"good","odometer_km":8500}`,
			2018, "Caterpillar", "good", 0.85,
		},
		{
			"markdown fenced JSON",
			"```json\n{\"year\":2020,\"make\":\"Volvo\",\"model\":\"L60\",\"condition\":\"excellent\",\"odometer_km\":2000}\n```",
			2020, "Volvo", "excellent", 0.85,
		},
		{
			"empty unknown all fields",
			`{"year":0,"make":"","model":"","condition":"unknown","odometer_km":0}`,
			0, "", "unknown", 0.2,
		},
		{
			"two fields only",
			`{"year":2015,"make":"JCB","model":"","condition":"unknown","odometer_km":0}`,
			2015, "JCB", "unknown", 0.65,
		},
		{
			"three fields populated",
			`{"year":2019,"make":"Komatsu","model":"PC200","condition":"unknown","odometer_km":0}`,
			2019, "Komatsu", "unknown", 0.85,
		},
		{
			"odd condition normalized",
			`{"year":2020,"make":"Hitachi","model":"ZX","condition":"like-new","odometer_km":1500}`,
			2020, "Hitachi", "unknown", 0.85, // 4 fields populated (year, make, model, odometer)
		},
		{
			"no JSON at all",
			"sorry I cannot parse this photo",
			0, "", "unknown", 0.0,
		},
		{
			"malformed JSON",
			`{"year": 2018, "make": "Cat",`,
			0, "", "unknown", 0.0,
		},
		{
			"with trailing commentary",
			`Here is the data: {"year":2017,"make":"Liebherr","model":"R954","condition":"fair","odometer_km":12000} hope this helps`,
			2017, "Liebherr", "fair", 0.85,
		},
		{
			"poor condition",
			`{"year":2005,"make":"Bobcat","model":"S130","condition":"poor","odometer_km":42000}`,
			2005, "Bobcat", "poor", 0.85,
		},
		{
			"condition uppercase normalized",
			`{"year":2021,"make":"Doosan","model":"DX","condition":"GOOD","odometer_km":500}`,
			2021, "Doosan", "good", 0.85,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			attrs, jsonStr, conf := ParsePhotoResponseText(tc.raw)
			if attrs.Year != tc.wantYear {
				t.Fatalf("year: want %d, got %d", tc.wantYear, attrs.Year)
			}
			if attrs.Make != tc.wantMake {
				t.Fatalf("make: want %q, got %q", tc.wantMake, attrs.Make)
			}
			if attrs.Condition != tc.wantCond {
				t.Fatalf("condition: want %q, got %q", tc.wantCond, attrs.Condition)
			}
			if conf+0.001 < tc.wantConfMin {
				t.Fatalf("confidence: want ≥%.2f, got %.2f", tc.wantConfMin, conf)
			}
			if tc.wantConfMin > 0 && jsonStr == "" {
				t.Fatalf("expected non-empty extracted JSON, got empty")
			}
		})
	}
}

// --- HTTP handler integration ---

func TestParsePhotoHandler_Success(t *testing.T) {
	out := `{"year":2018,"make":"Caterpillar","model":"320D","condition":"good","odometer_km":8500}`
	client := &stubClient{withImageOut: out}
	handler := ParsePhoto(client, "llama3.2-vision:11b", silentLogger())

	body, _ := json.Marshal(ParsePhotoRequest{ImageBase64: b64("fake-image-bytes")})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var resp ParsePhotoResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Year != 2018 || resp.Make != "Caterpillar" || resp.Condition != "good" {
		t.Fatalf("unexpected resp: %+v", resp)
	}
	if resp.LowConf {
		t.Fatal("expected high confidence with all 5 fields populated")
	}
	if resp.RawExtractedJSON == "" {
		t.Fatalf("expected raw_extracted_json populated")
	}
	if client.withImageCalls != 1 {
		t.Fatalf("expected 1 vision call, got %d", client.withImageCalls)
	}
}

func TestParsePhotoHandler_DataURIPrefixStripped(t *testing.T) {
	client := &stubClient{withImageOut: `{"year":2020,"make":"Volvo","model":"L60","condition":"good","odometer_km":1000}`}
	handler := ParsePhoto(client, "vision", silentLogger())

	imgB64 := b64("png-bytes")
	body, _ := json.Marshal(ParsePhotoRequest{ImageBase64: "data:image/png;base64," + imgB64})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got %d (body %s)", w.Code, w.Body.String())
	}
	if client.lastImage != imgB64 {
		t.Fatalf("expected stripped base64 (%q), got %q", imgB64, client.lastImage)
	}
}

func TestParsePhotoHandler_OllamaError(t *testing.T) {
	client := &stubClient{withImageErr: errBoom}
	handler := ParsePhoto(client, "v", silentLogger())

	body, _ := json.Marshal(ParsePhotoRequest{ImageBase64: b64("x")})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d (body %s)", w.Code, w.Body.String())
	}
}

func TestParsePhotoHandler_MethodNotAllowed(t *testing.T) {
	handler := ParsePhoto(&stubClient{}, "v", silentLogger())
	req := httptest.NewRequest(http.MethodGet, "/v1/parse-photo", nil)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestParsePhotoHandler_InvalidJSON(t *testing.T) {
	handler := ParsePhoto(&stubClient{}, "v", silentLogger())
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader("not-json"))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestParsePhotoHandler_EmptyImage(t *testing.T) {
	handler := ParsePhoto(&stubClient{}, "v", silentLogger())
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(`{"image_base64":""}`))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "image_base64 is required") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestParsePhotoHandler_InvalidBase64(t *testing.T) {
	handler := ParsePhoto(&stubClient{}, "v", silentLogger())
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(`{"image_base64":"!!!not-valid-b64!!!"}`))
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid base64") {
		t.Fatalf("body: %s", w.Body.String())
	}
}

func TestParsePhotoHandler_OversizedImage(t *testing.T) {
	handler := ParsePhoto(&stubClient{}, "v", silentLogger())

	// Vytvoř 6 MB raw → cca 8 MB base64.
	huge := make([]byte, 6*1024*1024)
	body, _ := json.Marshal(ParsePhotoRequest{
		ImageBase64: base64.StdEncoding.EncodeToString(huge),
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", w.Code)
	}
}

func TestParsePhotoHandler_LowConfidenceModelUnsureFields(t *testing.T) {
	out := `{"year":0,"make":"","model":"","condition":"unknown","odometer_km":0}`
	client := &stubClient{withImageOut: out}
	handler := ParsePhoto(client, "v", silentLogger())

	body, _ := json.Marshal(ParsePhotoRequest{ImageBase64: b64("x")})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	var resp ParsePhotoResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.LowConf {
		t.Fatalf("expected low_confidence=true for all-unknown response, got false (conf=%.2f)", resp.Confidence)
	}
}

func TestParsePhotoHandler_MalformedModelOutput(t *testing.T) {
	out := "I cannot identify this image"
	client := &stubClient{withImageOut: out}
	handler := ParsePhoto(client, "v", silentLogger())

	body, _ := json.Marshal(ParsePhotoRequest{ImageBase64: b64("x")})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 (gracefully degrade), got %d", w.Code)
	}
	var resp ParsePhotoResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.LowConf {
		t.Fatalf("expected low_confidence=true for unparseable response")
	}
	if resp.Year != 0 || resp.Make != "" || resp.Condition != "unknown" {
		t.Fatalf("expected zero-value response: %+v", resp)
	}
}

func TestParsePhotoHandler_PassesPromptToClient(t *testing.T) {
	out := `{"year":0,"make":"","model":"","condition":"unknown","odometer_km":0}`
	client := &stubClient{withImageOut: out}
	handler := ParsePhoto(client, "vision", silentLogger())

	body, _ := json.Marshal(ParsePhotoRequest{ImageBase64: b64("x")})
	req := httptest.NewRequest(http.MethodPost, "/v1/parse-photo",
		strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	handler(w, req)

	if !strings.Contains(client.lastPrompt, "construction or industrial machinery") {
		t.Fatalf("expected vision prompt template; got %s", client.lastPrompt)
	}
	if client.lastModel != "vision" {
		t.Fatalf("expected model 'vision', got %s", client.lastModel)
	}
}

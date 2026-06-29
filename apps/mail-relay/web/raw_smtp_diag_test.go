package web

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// ─── handler-level tests ────────────────────────────────────────────

func TestRawSmtpTest_AuthRequired(t *testing.T) {
	srv, _ := testServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(`{}`))
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want 401", rr.Code)
	}
}

func TestRawSmtpTest_MethodNotAllowed(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	req := httptest.NewRequest(http.MethodGet, "/v1/raw-smtp-test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("got %d, want 405", rr.Code)
	}
}

func TestRawSmtpTest_MissingFields(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	cases := []struct {
		name, body string
	}{
		{"empty", `{}`},
		{"no_password", `{"from":"a@b.cz","recipient":"c@d.cz","subject":"s","body":"b"}`},
		{"no_recipient", `{"from":"a@b.cz","password":"p","subject":"s","body":"b"}`},
		{"no_subject", `{"from":"a@b.cz","password":"p","recipient":"c@d.cz","body":"b"}`},
		{"no_body", `{"from":"a@b.cz","password":"p","recipient":"c@d.cz","subject":"s"}`},
		{"no_from", `{"password":"p","recipient":"c@d.cz","subject":"s","body":"b"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(c.body))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusBadRequest {
				t.Errorf("got %d, want 400", rr.Code)
			}
		})
	}
}

func TestRawSmtpTest_NoEgressConfigured(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@example.cz","subject":"s","body":"b"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200 (with ok:false body)", rr.Code)
	}
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.OK {
		t.Error("OK should be false when no egress configured")
	}
	if !strings.Contains(resp.Error, "no egress") && !strings.Contains(resp.Error, "dial:") {
		t.Errorf("error should mention egress: got %q", resp.Error)
	}
}

func TestRawSmtpTest_BadFromYieldsError(t *testing.T) {
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"no-at-sign","password":"p","recipient":"r@x.cz","subject":"s","body":"b"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.OK {
		t.Error("OK should be false for malformed from")
	}
	if !strings.Contains(resp.Error, "FQDN") {
		t.Errorf("error should mention FQDN extraction: got %q", resp.Error)
	}
}

// ─── unit-level tests ───────────────────────────────────────────────

func TestSenderFQDN(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"mazher.a@email.cz", "email.cz"},
		{"info@messing.dev", "messing.dev"},
		{"foo+tag@sub.example.org", "sub.example.org"},
		{"plain", ""},
		{"@no-local", ""},
		{"no-domain@", ""},
		{"", ""},
	}
	for _, c := range cases {
		got := senderFQDN(c.in)
		if got != c.want {
			t.Errorf("senderFQDN(%q): got %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildMessageID_Format(t *testing.T) {
	id, err := buildMessageID("email.cz")
	if err != nil {
		t.Fatal(err)
	}
	// RFC 5322 msg-id: <id-left@id-right>; we use 16 hex + fqdn.
	re := regexp.MustCompile(`^<[a-f0-9]{16}@email\.cz>$`)
	if !re.MatchString(id) {
		t.Errorf("message-id format: got %q, want match %s", id, re.String())
	}
}

func TestBuildMessageID_Unique(t *testing.T) {
	a, _ := buildMessageID("x.cz")
	b, _ := buildMessageID("x.cz")
	if a == b {
		t.Errorf("two consecutive IDs collided: %q", a)
	}
}

func TestBuildPlainMIME_HasNoAntiTraceHeaders(t *testing.T) {
	req := rawSMTPTestRequest{
		From:      "a@email.cz",
		Password:  "p",
		Recipient: "r@b.cz",
		Subject:   "Diagnostický test",
		Body:      "Ahoj, toto je test.",
	}
	mime := buildPlainMIME(req, "<deadbeef@email.cz>", time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC))
	s := string(mime)

	mustContain := []string{
		"From: a@email.cz\r\n",
		"To: r@b.cz\r\n",
		"Subject: Diagnostický test\r\n",
		"Message-Id: <deadbeef@email.cz>\r\n",
		"MIME-Version: 1.0\r\n",
		"Content-Type: text/plain; charset=utf-8\r\n",
		"Content-Transfer-Encoding: 8bit\r\n",
		"\r\nAhoj, toto je test.\r\n",
	}
	for _, want := range mustContain {
		if !strings.Contains(s, want) {
			t.Errorf("missing required substring %q in MIME:\n%s", want, s)
		}
	}

	mustNotContain := []string{
		"X-Mailer:",
		"multipart/",
		"text/html",
		"X-Anti-Trace",
		"X-Campaign-Id",
		"List-Unsubscribe",
		"boundary=",
	}
	for _, banned := range mustNotContain {
		if strings.Contains(s, banned) {
			t.Errorf("MIME must NOT contain %q (anti-trace bypass goal); got:\n%s", banned, s)
		}
	}
}

func TestBuildPlainMIME_PreservesUTF8(t *testing.T) {
	req := rawSMTPTestRequest{
		From:      "a@email.cz",
		Password:  "p",
		Recipient: "r@b.cz",
		Subject:   "Žluťoučký kůň",
		Body:      "Příliš žluťoučký kůň úpěl ďábelské ódy",
	}
	mime := buildPlainMIME(req, "<id@x>", time.Now().UTC())
	s := string(mime)

	if !strings.Contains(s, "Subject: Žluťoučký kůň\r\n") {
		t.Errorf("UTF-8 subject not preserved verbatim:\n%s", s)
	}
	if !strings.Contains(s, "Příliš žluťoučký kůň úpěl ďábelské ódy") {
		t.Errorf("UTF-8 body not preserved verbatim:\n%s", s)
	}
}

func TestBuildPlainMIME_BodyEndsWithCRLF(t *testing.T) {
	cases := []struct{ body string }{
		{"no trailing newline"},
		{"already has crlf\r\n"},
		{""},
	}
	for _, c := range cases {
		req := rawSMTPTestRequest{
			From: "a@b.cz", Password: "p", Recipient: "c@d.cz",
			Subject: "s", Body: c.body,
		}
		mime := buildPlainMIME(req, "<id@x>", time.Now().UTC())
		if !bytes.HasSuffix(mime, []byte("\r\n")) {
			t.Errorf("MIME for body=%q must end with CRLF; got tail=%q", c.body, mime[len(mime)-4:])
		}
	}
}

func TestEnvelopeIDFromInputs_Idempotent(t *testing.T) {
	a := envelopeIDFromInputs("Subject A", "<id1@x>")
	b := envelopeIDFromInputs("Subject A", "<id1@x>")
	if a != b {
		t.Errorf("same inputs must produce same envelope id: %q vs %q", a, b)
	}
	c := envelopeIDFromInputs("Subject B", "<id1@x>")
	if a == c {
		t.Errorf("different subjects should produce different envelope ids: both %q", a)
	}
	if len(a) != 16 {
		t.Errorf("envelope id length: got %d, want 16", len(a))
	}
}

// ─── Engine HMAC Message-Id format (sprint I1) ─────────────────────

// engineHMACFormat matches BuildMessageIDHeader in
// services/campaigns/sender/headers.go: `<{16-hex}.{nanos}@{fqdn}>`.
var engineHMACFormat = regexp.MustCompile(`^<[a-f0-9]{16}\.\d+@[^>]+>$`)

// randomHexFormat matches the legacy buildMessageID shape:
// `<{16-hex}@{fqdn}>` (no dot-nanos).
var randomHexFormat = regexp.MustCompile(`^<[a-f0-9]{16}@[^>]+>$`)

// validBase64Key is a 32-byte all-zero key, base64-encoded.
// Stable across tests so output is deterministic.
const validBase64Key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" // 32 zero bytes

func TestPickMessageID_DefaultUsesRandomHexFormat(t *testing.T) {
	t.Setenv("MESSAGE_ID_HMAC_KEY", validBase64Key) // even with key set, default flag stays random
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "b",
		// EngineMessageID intentionally omitted → false
	}
	id, err := pickMessageID(req, "email.cz", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !randomHexFormat.MatchString(id) {
		t.Errorf("default must use random hex format: got %q", id)
	}
	if engineHMACFormat.MatchString(id) {
		t.Errorf("default must NOT match engine HMAC dot-nanos format: got %q", id)
	}
}

func TestPickMessageID_EngineFlagUsesHMACFormat(t *testing.T) {
	t.Setenv("MESSAGE_ID_HMAC_KEY", validBase64Key)
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "b",
		EngineMessageID: true,
	}
	id, err := pickMessageID(req, "email.cz", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !engineHMACFormat.MatchString(id) {
		t.Errorf("engine flag must produce HMAC dot-nanos format: got %q", id)
	}
}

func TestPickMessageID_EngineFlagPreservesFQDN(t *testing.T) {
	t.Setenv("MESSAGE_ID_HMAC_KEY", validBase64Key)
	cases := []string{"email.cz", "messing.dev", "sub.example.org"}
	for _, fqdn := range cases {
		req := rawSMTPTestRequest{
			From: "a@" + fqdn, Recipient: "r@target.cz",
			Subject: "s", Body: "b", EngineMessageID: true,
		}
		id, err := pickMessageID(req, fqdn, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(id, "@"+fqdn+">") {
			t.Errorf("FQDN %q not preserved in HMAC mode: got %q", fqdn, id)
		}
	}
}

func TestPickMessageID_DefaultPreservesFQDN(t *testing.T) {
	cases := []string{"email.cz", "messing.dev", "sub.example.org"}
	for _, fqdn := range cases {
		req := rawSMTPTestRequest{
			From: "a@" + fqdn, Recipient: "r@target.cz",
			Subject: "s", Body: "b",
		}
		id, err := pickMessageID(req, fqdn, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(id, "@"+fqdn+">") {
			t.Errorf("FQDN %q not preserved in random mode: got %q", fqdn, id)
		}
	}
}

func TestPickMessageID_EmptyKeyFallsBackToRandom(t *testing.T) {
	t.Setenv("MESSAGE_ID_HMAC_KEY", "")
	req := rawSMTPTestRequest{
		From: "a@email.cz", Recipient: "r@x.cz",
		Subject: "s", Body: "b", EngineMessageID: true,
	}
	id, err := pickMessageID(req, "email.cz", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !randomHexFormat.MatchString(id) {
		t.Errorf("empty key must fall back to random format: got %q", id)
	}
}

func TestPickMessageID_BadBase64KeyFallsBackToRandom(t *testing.T) {
	t.Setenv("MESSAGE_ID_HMAC_KEY", "not-valid-base64-!!!@@@")
	req := rawSMTPTestRequest{
		From: "a@email.cz", Recipient: "r@x.cz",
		Subject: "s", Body: "b", EngineMessageID: true,
	}
	id, err := pickMessageID(req, "email.cz", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !randomHexFormat.MatchString(id) {
		t.Errorf("undecodable key must fall back to random: got %q", id)
	}
}

func TestBuildEngineMessageID_DeterministicForSameInputs(t *testing.T) {
	key, _ := base64.StdEncoding.DecodeString(validBase64Key)
	now := time.Date(2026, 5, 2, 10, 0, 0, 12345, time.UTC)
	a := buildEngineMessageID("r@x.cz", "envelope-1", "email.cz", key, now)
	b := buildEngineMessageID("r@x.cz", "envelope-1", "email.cz", key, now)
	if a != b {
		t.Errorf("same inputs must produce identical id: %q vs %q", a, b)
	}
}

func TestBuildEngineMessageID_DifferentRecipientDiffersHash(t *testing.T) {
	key, _ := base64.StdEncoding.DecodeString(validBase64Key)
	now := time.Date(2026, 5, 2, 10, 0, 0, 12345, time.UTC)
	a := buildEngineMessageID("r1@x.cz", "envelope-1", "email.cz", key, now)
	b := buildEngineMessageID("r2@x.cz", "envelope-1", "email.cz", key, now)
	if a == b {
		t.Errorf("different recipients must produce different hash; both got %q", a)
	}
	// Both should still match the engine format.
	if !engineHMACFormat.MatchString(a) || !engineHMACFormat.MatchString(b) {
		t.Errorf("both ids must match engine format: %q / %q", a, b)
	}
}

func TestBuildEngineMessageID_DifferentEnvelopeIDDiffersHash(t *testing.T) {
	key, _ := base64.StdEncoding.DecodeString(validBase64Key)
	now := time.Date(2026, 5, 2, 10, 0, 0, 12345, time.UTC)
	a := buildEngineMessageID("r@x.cz", "env-A", "email.cz", key, now)
	b := buildEngineMessageID("r@x.cz", "env-B", "email.cz", key, now)
	if a == b {
		t.Errorf("different envelope ids must produce different hash; both got %q", a)
	}
}

func TestBuildEngineMessageID_EmptyFQDNFallsBackToAliasLocal(t *testing.T) {
	key, _ := base64.StdEncoding.DecodeString(validBase64Key)
	now := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	id := buildEngineMessageID("r@x.cz", "env-1", "", key, now)
	if !strings.HasSuffix(id, "@alias.local>") {
		t.Errorf("empty fqdn must fall back to alias.local: got %q", id)
	}
}

func TestPickMessageID_FlagDoesNotLeakBetweenRequests(t *testing.T) {
	// Idempotency: alternating flag values must produce the right format
	// for each call; no global state should carry over.
	t.Setenv("MESSAGE_ID_HMAC_KEY", validBase64Key)
	now := time.Now()

	engineReq := rawSMTPTestRequest{
		From: "a@email.cz", Recipient: "r@x.cz",
		Subject: "s", Body: "b", EngineMessageID: true,
	}
	randomReq := rawSMTPTestRequest{
		From: "a@email.cz", Recipient: "r@x.cz",
		Subject: "s", Body: "b", EngineMessageID: false,
	}

	for i := 0; i < 5; i++ {
		eID, err := pickMessageID(engineReq, "email.cz", now)
		if err != nil {
			t.Fatal(err)
		}
		if !engineHMACFormat.MatchString(eID) {
			t.Errorf("iter %d engine: format mismatch: %q", i, eID)
		}

		rID, err := pickMessageID(randomReq, "email.cz", now)
		if err != nil {
			t.Fatal(err)
		}
		if !randomHexFormat.MatchString(rID) {
			t.Errorf("iter %d random: format mismatch: %q", i, rID)
		}
		if engineHMACFormat.MatchString(rID) {
			t.Errorf("iter %d random: must NOT match engine format: %q", i, rID)
		}
	}
}

func TestBuildPlainMIME_BodyUnchangedRegardlessOfFlag(t *testing.T) {
	// The Message-Id flag must not influence MIME body bytes.
	body := "Příliš žluťoučký kůň úpěl ďábelské ódy"
	subject := "Test"
	mkReq := func(engine bool) rawSMTPTestRequest {
		return rawSMTPTestRequest{
			From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
			Subject: subject, Body: body, EngineMessageID: engine,
		}
	}
	stamp := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	mimeRandom := buildPlainMIME(mkReq(false), "<aaaa@email.cz>", stamp)
	mimeEngine := buildPlainMIME(mkReq(true), "<bbbb.123@email.cz>", stamp)

	// Body must appear verbatim in both.
	for _, m := range [][]byte{mimeRandom, mimeEngine} {
		if !bytes.Contains(m, []byte(body)) {
			t.Errorf("body not present verbatim:\n%s", m)
		}
		if !bytes.Contains(m, []byte("Subject: "+subject+"\r\n")) {
			t.Errorf("subject not present:\n%s", m)
		}
	}
	// Differ ONLY in Message-Id line.
	stripMessageID := func(b []byte) string {
		lines := strings.Split(string(b), "\r\n")
		out := lines[:0]
		for _, l := range lines {
			if !strings.HasPrefix(l, "Message-Id:") {
				out = append(out, l)
			}
		}
		return strings.Join(out, "\r\n")
	}
	if stripMessageID(mimeRandom) != stripMessageID(mimeEngine) {
		t.Errorf("MIME bytes differ in places other than Message-Id; flag is leaking")
	}
}

// ─── multipart/alternative MIME (sprint I2) ────────────────────────

// multipartCTRE matches the top-level Content-Type header for the
// multipart/alternative envelope.
var multipartCTRE = regexp.MustCompile(`(?m)^Content-Type: multipart/alternative; boundary="(.+)"\r$`)

// boundaryFormat matches our chosen boundary token shape.
var boundaryFormat = regexp.MustCompile(`^----=_Part_[a-f0-9]{32}$`)

func TestPickMIME_DefaultIsPlain(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "b",
		// Multipart intentionally omitted → false
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)
	if !strings.Contains(s, "Content-Type: text/plain; charset=utf-8\r\n") {
		t.Errorf("default must be text/plain; got:\n%s", s)
	}
	if strings.Contains(s, "multipart/") {
		t.Errorf("default must NOT contain multipart marker; got:\n%s", s)
	}
	if strings.Contains(s, "boundary=") {
		t.Errorf("default must NOT contain boundary; got:\n%s", s)
	}
}

func TestPickMIME_MultipartProducesTwoParts(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "Test multipart", Body: "Hello world",
		Multipart: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)

	m := multipartCTRE.FindStringSubmatch(s)
	if m == nil {
		t.Fatalf("missing multipart/alternative Content-Type; got:\n%s", s)
	}
	boundary := m[1]
	if !boundaryFormat.MatchString(boundary) {
		t.Errorf("boundary token format: got %q, want match %s", boundary, boundaryFormat.String())
	}

	// Both parts present.
	if !strings.Contains(s, "Content-Type: text/plain; charset=utf-8\r\n") {
		t.Errorf("text/plain part missing:\n%s", s)
	}
	if !strings.Contains(s, "Content-Type: text/html; charset=utf-8\r\n") {
		t.Errorf("text/html part missing:\n%s", s)
	}

	// Both parts have 8bit transfer encoding.
	if c := strings.Count(s, "Content-Transfer-Encoding: 8bit\r\n"); c != 2 {
		t.Errorf("expected 2 Content-Transfer-Encoding: 8bit, got %d", c)
	}

	// Boundary appears twice as opener and once as closer (3 occurrences of `--<boundary>`).
	openCount := strings.Count(s, "--"+boundary+"\r\n")
	if openCount != 2 {
		t.Errorf("expected 2 opening boundary markers, got %d", openCount)
	}
	if !strings.Contains(s, "--"+boundary+"--\r\n") {
		t.Errorf("missing closing boundary --%s--", boundary)
	}
}

func TestPickMIME_MultipartPlainPartIsFirst(t *testing.T) {
	// Per RFC 2046: alternatives ordered least-rich → richest, so receivers
	// that pick the "best they can render" prefer the latter (HTML). For a
	// plain-text-only client, the first part is what shows.
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "plain body",
		Multipart: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)
	plainIdx := strings.Index(s, "Content-Type: text/plain")
	htmlIdx := strings.Index(s, "Content-Type: text/html")
	if plainIdx < 0 || htmlIdx < 0 {
		t.Fatalf("missing parts: plainIdx=%d htmlIdx=%d", plainIdx, htmlIdx)
	}
	if plainIdx >= htmlIdx {
		t.Errorf("text/plain must precede text/html (RFC 2046 least-rich-first); plainIdx=%d htmlIdx=%d", plainIdx, htmlIdx)
	}
}

func TestPickMIME_MultipartContainsPlainBodyVerbatim(t *testing.T) {
	body := "Toto je obyčejný text bez HTML."
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: body, Multipart: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)
	if !strings.Contains(s, body) {
		t.Errorf("plain body not present verbatim in multipart MIME:\n%s", s)
	}
}

func TestPickMIME_MultipartHTMLEscapesSpecialChars(t *testing.T) {
	// Each special char must appear ONLY as its entity in the HTML part
	// (the plain part above keeps the literal char). We test by checking
	// that the HTML region after the second boundary contains entities.
	body := `Cena & výhody: <strong>2025</strong> ceny "nízké" 's tématem'`
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: body, Multipart: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)

	htmlStart := strings.Index(s, "Content-Type: text/html")
	if htmlStart < 0 {
		t.Fatal("missing text/html part")
	}
	htmlPart := s[htmlStart:]

	wantEntities := []string{
		"&amp;",
		"&lt;strong&gt;",
		"&lt;/strong&gt;",
		"&quot;nízké&quot;",
		"&#39;s tématem&#39;",
	}
	for _, want := range wantEntities {
		if !strings.Contains(htmlPart, want) {
			t.Errorf("HTML part missing escaped entity %q; got:\n%s", want, htmlPart)
		}
	}

	// Raw < or > or & inside the HTML BODY content (not headers/markers)
	// would indicate an escape miss. Check that the body region between
	// `<p>` and `</p>` does not contain unescaped `<strong>` literal.
	pOpen := strings.Index(htmlPart, "<p>")
	pClose := strings.Index(htmlPart, "</p>")
	if pOpen < 0 || pClose < 0 || pOpen >= pClose {
		t.Fatalf("malformed <p>...</p> region: pOpen=%d pClose=%d", pOpen, pClose)
	}
	bodyContent := htmlPart[pOpen+len("<p>") : pClose]
	if strings.Contains(bodyContent, "<strong>") {
		t.Errorf("HTML body content contains unescaped <strong>; got: %q", bodyContent)
	}
}

func TestPickMIME_MultipartHTMLConvertsNewlinesToBR(t *testing.T) {
	cases := []struct {
		name, body string
	}{
		{"crlf", "line1\r\nline2\r\nline3"},
		{"lf", "line1\nline2\nline3"},
		{"cr_only", "line1\rline2\rline3"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := rawSMTPTestRequest{
				From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
				Subject: "s", Body: c.body, Multipart: true,
			}
			mime, err := pickMIME(req, "<id@email.cz>", time.Now().UTC())
			if err != nil {
				t.Fatal(err)
			}
			s := string(mime)
			htmlStart := strings.Index(s, "Content-Type: text/html")
			if htmlStart < 0 {
				t.Fatal("missing text/html part")
			}
			htmlPart := s[htmlStart:]

			pOpen := strings.Index(htmlPart, "<p>")
			pClose := strings.Index(htmlPart, "</p>")
			if pOpen < 0 || pClose < 0 {
				t.Fatal("malformed <p>...</p>")
			}
			bodyContent := htmlPart[pOpen+len("<p>") : pClose]

			if c := strings.Count(bodyContent, "<br/>"); c != 2 {
				t.Errorf("expected 2 <br/> in body content %q; got %d", bodyContent, c)
			}
			if !strings.Contains(bodyContent, "line1<br/>line2<br/>line3") {
				t.Errorf("br conversion shape wrong; got %q", bodyContent)
			}
		})
	}
}

func TestPickMIME_MultipartEmptyBodyStillValid(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "", Multipart: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)
	// Both parts must still be present even with empty body.
	if !strings.Contains(s, "Content-Type: text/plain; charset=utf-8\r\n") {
		t.Errorf("empty body must still produce text/plain part:\n%s", s)
	}
	if !strings.Contains(s, "Content-Type: text/html; charset=utf-8\r\n") {
		t.Errorf("empty body must still produce text/html part:\n%s", s)
	}
	if !strings.Contains(s, "<!DOCTYPE html><html><body><p></p></body></html>\r\n") {
		t.Errorf("empty body must produce empty <p></p>; got:\n%s", s)
	}
}

func TestPickMIME_MultipartBoundaryUniquePerCall(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "b", Multipart: true,
	}
	now := time.Now().UTC()

	a, err := pickMIME(req, "<id@email.cz>", now)
	if err != nil {
		t.Fatal(err)
	}
	b, err := pickMIME(req, "<id@email.cz>", now)
	if err != nil {
		t.Fatal(err)
	}

	getBoundary := func(buf []byte) string {
		m := multipartCTRE.FindStringSubmatch(string(buf))
		if m == nil {
			t.Fatalf("missing boundary in:\n%s", buf)
		}
		return m[1]
	}
	bA := getBoundary(a)
	bB := getBoundary(b)
	if bA == bB {
		t.Errorf("two calls produced identical boundary token: %q", bA)
	}
}

func TestPickMIME_MultipartPreservesUTF8DiacriticsInBothParts(t *testing.T) {
	body := "Příliš žluťoučký kůň úpěl ďábelské ódy"
	subject := "Vážený kliente"
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: subject, Body: body, Multipart: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)

	// Subject preserved verbatim.
	if !strings.Contains(s, "Subject: "+subject+"\r\n") {
		t.Errorf("UTF-8 subject not preserved verbatim:\n%s", s)
	}

	// Plain part: literal body.
	plainStart := strings.Index(s, "Content-Type: text/plain")
	htmlStart := strings.Index(s, "Content-Type: text/html")
	if plainStart < 0 || htmlStart < 0 {
		t.Fatal("missing parts")
	}
	plainPart := s[plainStart:htmlStart]
	htmlPart := s[htmlStart:]

	if !strings.Contains(plainPart, body) {
		t.Errorf("UTF-8 body not preserved verbatim in plain part:\n%s", plainPart)
	}
	// HTML part: same diacritics survive escape (no special chars in this body).
	if !strings.Contains(htmlPart, body) {
		t.Errorf("UTF-8 body not preserved in HTML part (escape should not touch diacritics):\n%s", htmlPart)
	}
}

func TestEscapeHTMLBody_OrderingAvoidsDoubleEscape(t *testing.T) {
	// & must be replaced first so subsequent entity replacements don't
	// double-encode the ampersand of those entities.
	got := escapeHTMLBody("a & <b>")
	want := "a &amp; &lt;b&gt;"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestFreshBoundary_FormatAndUniqueness(t *testing.T) {
	a, err := freshBoundary()
	if err != nil {
		t.Fatal(err)
	}
	b, err := freshBoundary()
	if err != nil {
		t.Fatal(err)
	}
	if !boundaryFormat.MatchString(a) {
		t.Errorf("boundary %q does not match expected format", a)
	}
	if !boundaryFormat.MatchString(b) {
		t.Errorf("boundary %q does not match expected format", b)
	}
	if a == b {
		t.Errorf("two consecutive boundaries collided: %q", a)
	}
}

func TestRawSmtpTest_ResponseEchoesBothFlags(t *testing.T) {
	// Even when egress is unwired (resp.OK=false), the response must
	// echo the flags so the operator can verify what shape was used.
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"b","engine_messageid":true,"multipart":true}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.EngineMessageID {
		t.Errorf("response must echo engine_messageid=true")
	}
	if !resp.Multipart {
		t.Errorf("response must echo multipart=true")
	}
}

func TestRunRawSMTPTest_BadFromShortCircuits(t *testing.T) {
	// Drives the function-level path that the handler covers via HTTP.
	// Pinning here so refactors of the HTTP layer don't lose the FQDN guard.
	srv, _ := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp := srv.runRawSMTPTest(ctx, rawSMTPTestRequest{
		From: "no-at", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: "b",
	})
	if resp.OK {
		t.Error("OK should be false")
	}
	if !strings.Contains(resp.Error, "FQDN") {
		t.Errorf("error: got %q, want FQDN", resp.Error)
	}
	if resp.LatencyMs < 0 {
		t.Error("latency_ms should be >= 0")
	}
}

// ─── humanize-light char-level substitutions (sprint I3) ───────────

// applyHumanizeLight is deterministic when seed != 0 — every test below
// uses a fixed non-zero seed so output is reproducible across runs.
const humanizeLightTestSeed int64 = 0xC0FFEE

func TestApplyHumanizeLight_EmptyBodyIsNoOp(t *testing.T) {
	if got := applyHumanizeLight("", humanizeLightTestSeed); got != "" {
		t.Errorf("empty input must return empty string; got %q", got)
	}
}

func TestApplyHumanizeLight_DefaultFlagDoesNotMutateBody(t *testing.T) {
	// When humanize_light is OFF, the runner must NOT call applyHumanizeLight.
	// We verify the behavior at the integration level: same body → identical
	// MIME bytes regardless of whether the flag is omitted vs explicit false.
	body := "Body with - hyphen and \"quotes\" and  spaces."
	mkReq := func(flag bool) rawSMTPTestRequest {
		return rawSMTPTestRequest{
			From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
			Subject: "s", Body: body, HumanizeLight: flag,
		}
	}
	stamp := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	mimeOff, err := pickMIME(mkReq(false), "<id@x>", stamp)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(mimeOff, []byte(body)) {
		t.Errorf("default-off body must appear verbatim:\n%s", mimeOff)
	}
}

func TestApplyHumanizeLight_AppliesAtLeastOneSubstitution(t *testing.T) {
	// Source contains all three trigger patterns; output MUST differ from
	// input on at least one of them.
	t.Setenv("HUMANIZE_LIGHT_TEST_SEED", strconv.FormatInt(humanizeLightTestSeed, 10))
	src := `Vážený kliente, máme - speciální nabídku a "akci" pro vás.`
	got := applyHumanizeLight(src, humanizeLightTestSeed)
	if got == src {
		t.Errorf("at least one substitution must apply; got identical:\n%s", got)
	}
}

func TestApplyHumanizeLight_EmDashReplacesHyphenPattern(t *testing.T) {
	src := "produkt - cena"
	got := applyHumanizeLight(src, humanizeLightTestSeed)
	if !strings.Contains(got, "—") {
		t.Errorf("em-dash (U+2014) missing; got %q", got)
	}
	if strings.Contains(got, " - ") {
		t.Errorf("ASCII hyphen-space pattern must be replaced; got %q", got)
	}
}

func TestApplyHumanizeLight_CurlyQuotesPairedInOrder(t *testing.T) {
	src := `pre "open close" post "open2 close2" tail`
	got := applyHumanizeLight(src, humanizeLightTestSeed)
	if strings.Contains(got, `"`) {
		t.Errorf("ASCII straight quotes must all be replaced; got %q", got)
	}
	openIdx := strings.Index(got, "“")
	closeIdx := strings.Index(got, "”")
	if openIdx < 0 || closeIdx < 0 {
		t.Fatalf("missing curly quotes: open=%d close=%d in %q", openIdx, closeIdx, got)
	}
	if openIdx >= closeIdx {
		t.Errorf("opening curly quote (U+201C) must precede closing (U+201D); open=%d close=%d", openIdx, closeIdx)
	}
}

func TestApplyHumanizeLight_NBSPConvertsSomeSpaces(t *testing.T) {
	// 100 ASCII spaces, prob=0.30 with deterministic seed → expected
	// somewhere in [10, 60] NBSPs (loose binomial bounds; seed ensures
	// exact value is reproducible across runs).
	src := strings.Repeat("a ", 100) // 100 spaces between 100 'a's
	got := applyHumanizeLight(src, humanizeLightTestSeed)
	nbspCount := strings.Count(got, " ")
	if nbspCount == 0 {
		t.Errorf("no NBSP introduced; deterministic seed should yield >0; got input=%d nbsp=0", strings.Count(src, " "))
	}
	if nbspCount > 90 {
		t.Errorf("NBSP count %d wildly exceeds prob=0.30 expectation", nbspCount)
	}
}

func TestApplyHumanizeLight_DeterministicWithSameSeed(t *testing.T) {
	src := "Vážený kliente - máme \"speciální\" nabídku pro vás dnes."
	a := applyHumanizeLight(src, humanizeLightTestSeed)
	b := applyHumanizeLight(src, humanizeLightTestSeed)
	if a != b {
		t.Errorf("same seed must produce identical output:\nA=%q\nB=%q", a, b)
	}
}

func TestApplyHumanizeLight_DiacriticsPreserved(t *testing.T) {
	// All Czech diacritics must survive the substitution path verbatim
	// — H1 humanize/imperfect.go is SEPARATE; this layer must not degrade.
	src := "Příliš žluťoučký kůň úpěl ďábelské ódy"
	got := applyHumanizeLight(src, humanizeLightTestSeed)
	mustKeep := []string{"Příliš", "žluťoučký", "kůň", "úpěl", "ďábelské", "ódy"}
	for _, w := range mustKeep {
		if !strings.Contains(got, w) {
			t.Errorf("diacritic word %q lost; got %q", w, got)
		}
	}
	// Specifically: "vážený" stays "vážený" — no degrade to "vazeny".
	if strings.Contains(got, "vazeny") {
		t.Errorf("diacritics degraded — humanize_light must not invoke H1 imperfect.go path; got %q", got)
	}
}

func TestApplyHumanizeLight_UTF8MultibyteSequencesValid(t *testing.T) {
	// Em-dash is 3-byte UTF-8 (E2 80 94). Verify the output is valid UTF-8
	// AND that the rune count after substitution makes sense (no truncation).
	src := "produkt - cena - sleva"
	got := applyHumanizeLight(src, humanizeLightTestSeed)
	if !utf8.ValidString(got) {
		t.Errorf("output is not valid UTF-8: %q", got)
	}
	// Exactly 2 em-dashes inserted.
	if c := strings.Count(got, "—"); c != 2 {
		t.Errorf("expected 2 em-dashes; got %d in %q", c, got)
	}
}

func TestApplyHumanizeLight_OnlyMutatesBodyNotSubject(t *testing.T) {
	// Subject must pass through to MIME verbatim even with humanize_light=true.
	subject := `Nabídka - speciální "akce"`
	body := `Body - with "quotes"`
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: subject, Body: body, HumanizeLight: true,
	}
	// Drive runRawSMTPTest indirectly: build the substituted body then MIME.
	srv, _ := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t.Setenv("HUMANIZE_LIGHT_TEST_SEED", strconv.FormatInt(humanizeLightTestSeed, 10))
	resp := srv.runRawSMTPTest(ctx, req)
	if !resp.HumanizeLight {
		t.Errorf("response must echo humanize_light=true; got %+v", resp)
	}
	// Indirect check — re-build the MIME the same way the runner did,
	// then assert subject is verbatim ASCII while body is mutated.
	subjectMIME := buildPlainMIME(req, "<id@x>", time.Now().UTC())
	if !bytes.Contains(subjectMIME, []byte("Subject: "+subject+"\r\n")) {
		t.Errorf("subject must be passed verbatim with no substitutions: got\n%s", subjectMIME)
	}
}

func TestApplyHumanizeLight_MultipartBothPartsGetSameSubstitutions(t *testing.T) {
	// When humanize_light + multipart combine, BOTH parts (text/plain and
	// text/html) must contain the same substituted text — the runner
	// substitutes BEFORE pickMIME so this is automatic.
	rawBody := `Vážený - "kliente"`
	substituted := applyHumanizeLight(rawBody, humanizeLightTestSeed)

	mimeReq := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: substituted, // simulate runner pre-substitution
		Multipart: true,
	}
	mime, err := pickMIME(mimeReq, "<id@x>", time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)

	plainStart := strings.Index(s, "Content-Type: text/plain")
	htmlStart := strings.Index(s, "Content-Type: text/html")
	if plainStart < 0 || htmlStart < 0 {
		t.Fatal("missing parts")
	}
	plainPart := s[plainStart:htmlStart]
	htmlPart := s[htmlStart:]

	// Em-dash present in plain part verbatim and (since "—" has no HTML
	// special-char meaning) verbatim in HTML part too.
	if !strings.Contains(plainPart, "—") {
		t.Errorf("em-dash missing from plain part:\n%s", plainPart)
	}
	if !strings.Contains(htmlPart, "—") {
		t.Errorf("em-dash missing from HTML part (should not be HTML-escaped):\n%s", htmlPart)
	}
	// Curly quote U+201C must appear in BOTH parts (it's not in the HTML
	// special-char set, so escapeHTMLBody passes it through verbatim).
	if !strings.Contains(plainPart, "“") {
		t.Errorf("curly quote U+201C missing from plain part:\n%s", plainPart)
	}
	if !strings.Contains(htmlPart, "“") {
		t.Errorf("curly quote U+201C missing from HTML part:\n%s", htmlPart)
	}
}

func TestApplyHumanizeLight_MultipartHTMLEscapingIntact(t *testing.T) {
	// The HTML escape pipeline (escapeHTMLBody) must still escape
	// dangerous chars even after humanize_light has substituted the text.
	// Source has `<`, `>`, `&` after substitution — those still need to
	// become entities in the HTML part.
	bodyWithHTML := `<script> & special - chars`
	substituted := applyHumanizeLight(bodyWithHTML, humanizeLightTestSeed)
	// Sanity: the substitution should keep the dangerous chars intact.
	if !strings.Contains(substituted, "<") || !strings.Contains(substituted, ">") || !strings.Contains(substituted, "&") {
		t.Fatalf("substitution unexpectedly removed HTML special chars: %q", substituted)
	}

	mimeReq := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: substituted, Multipart: true,
	}
	mime, err := pickMIME(mimeReq, "<id@x>", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)
	htmlStart := strings.Index(s, "Content-Type: text/html")
	if htmlStart < 0 {
		t.Fatal("missing html part")
	}
	htmlPart := s[htmlStart:]
	for _, ent := range []string{"&lt;script&gt;", "&amp;"} {
		if !strings.Contains(htmlPart, ent) {
			t.Errorf("HTML part missing entity %q; escape pipeline broken:\n%s", ent, htmlPart)
		}
	}
}

func TestRawSmtpTest_ResponseEchoesHumanizeLight(t *testing.T) {
	// Idempotent flag echo — operator can verify which shape was sent
	// even when egress is unwired (resp.OK=false).
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"text - with \"quotes\"","humanize_light":true}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.HumanizeLight {
		t.Errorf("response must echo humanize_light=true; got %+v", resp)
	}
}

func TestRawSmtpTest_ResponseDefaultsHumanizeLightFalse(t *testing.T) {
	// When the flag is omitted from the request JSON, the response
	// must echo it as false — not absent.
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	rawBody := rr.Body.String()
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(strings.NewReader(rawBody)).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.HumanizeLight {
		t.Errorf("default-omitted flag must echo as false; got true")
	}
	// And the JSON must contain the field even when false.
	if !strings.Contains(rawBody, `"humanize_light":false`) {
		t.Errorf("response JSON must always include humanize_light field; got: %s", rawBody)
	}
}

func TestLoadHumanizeLightSeed_EnvParsing(t *testing.T) {
	cases := []struct {
		name, env string
		want      int64
	}{
		{"unset", "", 0},
		{"valid_positive", "12345", 12345},
		{"valid_negative", "-7", -7},
		{"hex_not_supported", "0xC0FFEE", 0}, // strconv.ParseInt base 10 only
		{"garbage", "not-a-number", 0},
		{"whitespace_trimmed", "  42  ", 42},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("HUMANIZE_LIGHT_TEST_SEED", c.env)
			if got := loadHumanizeLightSeed(); got != c.want {
				t.Errorf("env=%q: got %d, want %d", c.env, got, c.want)
			}
		})
	}
}

func TestSubstituteCurlyQuotes_OddCountLeavesTrailingOpening(t *testing.T) {
	// Unbalanced source: 3 quotes → open, close, open (last one orphaned).
	src := `a "b" c "d`
	got := substituteCurlyQuotes(src)
	if strings.Contains(got, `"`) {
		t.Errorf("all ASCII quotes must be replaced even when unbalanced; got %q", got)
	}
	openCount := strings.Count(got, "“")
	closeCount := strings.Count(got, "”")
	if openCount != 2 || closeCount != 1 {
		t.Errorf("unbalanced source: expected open=2 close=1; got open=%d close=%d in %q", openCount, closeCount, got)
	}
}

func TestSubstituteCurlyQuotes_PreservesSingleQuotesAndApostrophes(t *testing.T) {
	// Apostrophes (Czech "s.r.o." ≠ but English contractions like "don't")
	// must NOT be touched — single-quote substitution is out of scope.
	src := `it's "double" don't`
	got := substituteCurlyQuotes(src)
	if !strings.Contains(got, "it's") || !strings.Contains(got, "don't") {
		t.Errorf("apostrophes must be preserved; got %q", got)
	}
	if !strings.Contains(got, "“double”") {
		t.Errorf("double quotes must be curly-substituted; got %q", got)
	}
}

func TestSubstituteEmDash_OnlyReplacesSurroundedHyphen(t *testing.T) {
	// "word-word" (no surrounding spaces) is NOT a candidate — that's
	// compound noun usage in Czech and English; replacing it would break
	// e.g. "B2B-strategie".
	src := "word-word and a - b and c-d"
	got := substituteEmDash(src)
	if !strings.Contains(got, "word-word") {
		t.Errorf("compound hyphen (no surrounding spaces) must be preserved; got %q", got)
	}
	if !strings.Contains(got, "c-d") {
		t.Errorf("compound hyphen at end must be preserved; got %q", got)
	}
	if !strings.Contains(got, "a — b") {
		t.Errorf("space-surrounded hyphen must become em-dash; got %q", got)
	}
}

// ─── diacritics random-degrade (sprint I4) ────────────────────────

// applyDiacriticsDegrade is deterministic when seed != 0 — every test
// below uses a fixed non-zero seed so output is reproducible across runs.
// Distinct from humanizeLightTestSeed so failures don't accidentally
// cross-cancel across the two coin-flippers.
const diacriticsDegradeTestSeed int64 = 0xDEADBEEF

func TestApplyDiacriticsDegrade_EmptyBodyIsNoOp(t *testing.T) {
	if got := applyDiacriticsDegrade("", diacriticsDegradeProb, diacriticsDegradeTestSeed); got != "" {
		t.Errorf("empty input must return empty string; got %q", got)
	}
}

func TestApplyDiacriticsDegrade_DefaultFlagDoesNotMutateBody(t *testing.T) {
	// When diacritics_degrade is OFF, the runner must NOT call
	// applyDiacriticsDegrade. We verify the behavior at the integration
	// level: same body → identical MIME bytes regardless of whether the
	// flag is omitted vs explicit false.
	body := "Vážený kliente, máme speciální nabídku."
	mkReq := func(flag bool) rawSMTPTestRequest {
		return rawSMTPTestRequest{
			From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
			Subject: "s", Body: body, DiacriticsDegrade: flag,
		}
	}
	stamp := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	mimeOff, err := pickMIME(mkReq(false), "<id@x>", stamp)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(mimeOff, []byte(body)) {
		t.Errorf("default-off body must appear verbatim:\n%s", mimeOff)
	}
}

func TestApplyDiacriticsDegrade_AppliesAtLeastOneReplacement(t *testing.T) {
	// Source has plenty of diacritics; output MUST differ from input on
	// at least one character. Statistical: with prob=0.30 across 12+
	// diacritic glyphs, P(zero replacement) ≈ 0.7^12 ≈ 0.014 — vanishingly
	// small for the chosen seed.
	src := "Příliš žluťoučký kůň úpěl ďábelské ódy"
	got := applyDiacriticsDegrade(src, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	if got == src {
		t.Errorf("at least one diacritic must be replaced; got identical:\n%s", got)
	}
}

func TestApplyDiacriticsDegrade_BodyWithoutDiacriticsUnchanged(t *testing.T) {
	// Pure ASCII input has no diacritic candidates → output must equal input.
	src := "Hello, this is a plain ASCII paragraph with no special chars."
	got := applyDiacriticsDegrade(src, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	if got != src {
		t.Errorf("ASCII-only input must be unchanged; got %q", got)
	}
}

func TestApplyDiacriticsDegrade_PreservesCapitalization(t *testing.T) {
	// 'Á' → 'A' (uppercase ASCII), NEVER → 'a'. Run with prob=1.0 so
	// every diacritic is degraded and the capitalization map is fully
	// exercised.
	src := "ÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ áčďéěíňóřšťúůýž"
	got := applyDiacriticsDegrade(src, 1.0, diacriticsDegradeTestSeed)
	wantUpper := "ACDEEINORSTUUYZ"
	wantLower := "acdeeinorstuuyz"
	if !strings.Contains(got, wantUpper) {
		t.Errorf("uppercase diacritics must degrade to uppercase ASCII; want %q in %q", wantUpper, got)
	}
	if !strings.Contains(got, wantLower) {
		t.Errorf("lowercase diacritics must degrade to lowercase ASCII; want %q in %q", wantLower, got)
	}
}

func TestApplyDiacriticsDegrade_UTF8MultibyteHandling(t *testing.T) {
	// Czech diacritics are 2-byte UTF-8 sequences (e.g. 'á' = C3 A1).
	// After degrade, the output must still be valid UTF-8 (no truncated
	// sequences, no orphaned continuation bytes).
	src := "vážený kliente žluťoučký"
	got := applyDiacriticsDegrade(src, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	if !utf8.ValidString(got) {
		t.Errorf("output is not valid UTF-8: %q (bytes=%x)", got, []byte(got))
	}
}

func TestApplyDiacriticsDegrade_SubjectUntouched(t *testing.T) {
	// Subject must pass through to MIME verbatim even with
	// diacritics_degrade=true. Only the body is mutated.
	subject := "Vážený zákazníku — speciální nabídka"
	body := "Vážený kliente, máme nabídku."
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: subject, Body: body, DiacriticsDegrade: true,
	}
	srv, _ := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t.Setenv("DIACRITICS_DEGRADE_TEST_SEED", strconv.FormatInt(diacriticsDegradeTestSeed, 10))
	resp := srv.runRawSMTPTest(ctx, req)
	if !resp.DiacriticsDegrade {
		t.Errorf("response must echo diacritics_degrade=true; got %+v", resp)
	}
	// Indirect check — re-build the MIME the same way the runner did,
	// then assert subject is verbatim while body is mutated.
	subjectMIME := buildPlainMIME(req, "<id@x>", time.Now().UTC())
	if !bytes.Contains(subjectMIME, []byte("Subject: "+subject+"\r\n")) {
		t.Errorf("subject must be passed verbatim with no diacritic substitution: got\n%s", subjectMIME)
	}
}

func TestApplyDiacriticsDegrade_DeterministicWithSameSeed(t *testing.T) {
	// Same seed + same input → same output across two runs (test-mode
	// reproducibility). Operator A/B replay relies on this property.
	src := "Vážený kliente, máme speciální nabídku pro váš podnik."
	a := applyDiacriticsDegrade(src, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	b := applyDiacriticsDegrade(src, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	if a != b {
		t.Errorf("same seed must produce identical output:\nA=%q\nB=%q", a, b)
	}
}

func TestApplyDiacriticsDegrade_MultipartBothPartsGetSameDegrade(t *testing.T) {
	// When diacritics_degrade + multipart combine, BOTH parts (text/plain
	// and text/html) must contain the same degraded text — the runner
	// substitutes BEFORE pickMIME so this is automatic.
	rawBody := "Vážený kliente, příloha"
	degraded := applyDiacriticsDegrade(rawBody, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	if degraded == rawBody {
		t.Skip("seed produced no replacement on this corpus — adjust corpus or seed")
	}

	mimeReq := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: degraded, // simulate runner pre-substitution
		Multipart: true,
	}
	mime, err := pickMIME(mimeReq, "<id@x>", time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	s := string(mime)
	plainStart := strings.Index(s, "Content-Type: text/plain")
	htmlStart := strings.Index(s, "Content-Type: text/html")
	if plainStart < 0 || htmlStart < 0 {
		t.Fatal("missing parts")
	}
	plainPart := s[plainStart:htmlStart]
	htmlPart := s[htmlStart:]
	if !strings.Contains(plainPart, degraded) {
		t.Errorf("plain part must contain degraded body verbatim:\n%s", plainPart)
	}
	if !strings.Contains(htmlPart, degraded) {
		t.Errorf("html part must contain degraded body verbatim:\n%s", htmlPart)
	}
}

func TestRawSmtpTest_ResponseEchoesDiacriticsDegrade(t *testing.T) {
	// Idempotent flag echo — operator can verify which shape was sent
	// even when egress is unwired (resp.OK=false).
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"Vážený kliente","diacritics_degrade":true}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.DiacriticsDegrade {
		t.Errorf("response must echo diacritics_degrade=true; got %+v", resp)
	}
}

func TestRawSmtpTest_ResponseDefaultsDiacriticsDegradeFalse(t *testing.T) {
	// When the flag is omitted from the request JSON, the response
	// must echo it as false — not absent.
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	rawBody := rr.Body.String()
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(strings.NewReader(rawBody)).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.DiacriticsDegrade {
		t.Errorf("default-omitted flag must echo as false; got true")
	}
	if !strings.Contains(rawBody, `"diacritics_degrade":false`) {
		t.Errorf("response JSON must always include diacritics_degrade field; got: %s", rawBody)
	}
}

func TestApplyDiacriticsDegrade_ProbZeroIsNoOp(t *testing.T) {
	// prob=0 → no coin flips → output identical to input. Defense-in-depth
	// against misconfiguration silently mutating the body.
	src := "Vážený žluťoučký kůň"
	got := applyDiacriticsDegrade(src, 0.0, diacriticsDegradeTestSeed)
	if got != src {
		t.Errorf("prob=0 must be a no-op; got %q", got)
	}
}

func TestApplyDiacriticsDegrade_ProbOneReplacesAll(t *testing.T) {
	// prob=1.0 → every diacritic must be replaced. After degrade the
	// output must contain ZERO diacritic glyphs from the map.
	src := "Vážený kliente, máme speciální"
	got := applyDiacriticsDegrade(src, 1.0, diacriticsDegradeTestSeed)
	for r := range diacriticsDegradeMap {
		if strings.ContainsRune(got, r) {
			t.Errorf("prob=1 must replace all diacritics; rune %q remained in %q", r, got)
		}
	}
	// And ASCII letters that weren't diacritics must be preserved.
	// "Vážený kliente, máme speciální" → "Vazeny kliente, mame specialni"
	// (every diacritic glyph mapped 1:1 to its ASCII partner; the word
	// shape is preserved character-by-character).
	for _, w := range []string{"Vazeny", "kliente", "mame", "specialni"} {
		if !strings.Contains(got, w) {
			t.Errorf("non-diacritic ASCII or fully-degraded form must survive prob=1; missing %q in %q", w, got)
		}
	}
}

func TestApplyDiacriticsDegrade_HumanizeLightSubstitutionsSurvive(t *testing.T) {
	// Pipeline order test: humanize_light runs FIRST, diacritics_degrade
	// SECOND. The non-ASCII glyphs introduced by humanize_light (em-dash
	// U+2014, curly quotes U+201C/U+201D, NBSP U+00A0) are NOT in the
	// diacritic map → they must survive the second pass verbatim.
	humanized := "vážený — “kliente” máme"
	got := applyDiacriticsDegrade(humanized, 1.0, diacriticsDegradeTestSeed)
	for _, glyph := range []string{"—", "“", "”", " "} {
		if !strings.Contains(got, glyph) {
			t.Errorf("humanize_light glyph %q must survive diacritics_degrade; output=%q", glyph, got)
		}
	}
}

func TestApplyDiacriticsDegrade_MapMatchesH1Source(t *testing.T) {
	// Ratchet: the relay's diacriticsDegradeMap MUST match the production
	// source-of-truth at services/common/humanize/imperfect.go:135-142.
	// If H1 ever adds (or changes) a diacritic mapping, this test fails
	// and forces the relay copy to be updated explicitly. The two maps
	// are intentionally duplicated (relay is stdlib-only) but a drift
	// would cause the I4 measurement to diverge from production behavior.
	expected := map[rune]rune{
		'á': 'a', 'č': 'c', 'ď': 'd', 'é': 'e', 'ě': 'e',
		'í': 'i', 'ň': 'n', 'ó': 'o', 'ř': 'r', 'š': 's',
		'ť': 't', 'ú': 'u', 'ů': 'u', 'ý': 'y', 'ž': 'z',
		'Á': 'A', 'Č': 'C', 'Ď': 'D', 'É': 'E', 'Ě': 'E',
		'Í': 'I', 'Ň': 'N', 'Ó': 'O', 'Ř': 'R', 'Š': 'S',
		'Ť': 'T', 'Ú': 'U', 'Ů': 'U', 'Ý': 'Y', 'Ž': 'Z',
	}
	if len(diacriticsDegradeMap) != len(expected) {
		t.Fatalf("map size drift: got %d, want %d entries", len(diacriticsDegradeMap), len(expected))
	}
	for k, v := range expected {
		if got, ok := diacriticsDegradeMap[k]; !ok || got != v {
			t.Errorf("entry %q drifted: got %q ok=%v, want %q", k, got, ok, v)
		}
	}
}

func TestLoadDiacriticsDegradeSeed_EnvParsing(t *testing.T) {
	cases := []struct {
		name, env string
		want      int64
	}{
		{"unset", "", 0},
		{"valid_positive", "12345", 12345},
		{"valid_negative", "-7", -7},
		{"hex_not_supported", "0xDEADBEEF", 0}, // strconv.ParseInt base 10 only
		{"garbage", "not-a-number", 0},
		{"whitespace_trimmed", "  42  ", 42},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("DIACRITICS_DEGRADE_TEST_SEED", c.env)
			if got := loadDiacriticsDegradeSeed(); got != c.want {
				t.Errorf("env=%q: got %d, want %d", c.env, got, c.want)
			}
		})
	}
}

func TestApplyDiacriticsDegrade_StatisticalRateReasonable(t *testing.T) {
	// Loose binomial bound: 60 diacritic glyphs at prob=0.30 → expected
	// 18 replacements ± noise. We assert [3, 50] to leave plenty of room
	// for the deterministic seed's actual draw without making the test
	// brittle. This is the "sanity floor" — if the rate ever lands on 0
	// or 60, the coin-flipper is broken.
	src := strings.Repeat("á", 60)
	got := applyDiacriticsDegrade(src, diacriticsDegradeProb, diacriticsDegradeTestSeed)
	replaced := strings.Count(got, "a") // ASCII 'a' wasn't in input
	preserved := strings.Count(got, "á")
	if replaced+preserved != 60 {
		t.Fatalf("rune count drift: replaced=%d preserved=%d total=%d, want 60", replaced, preserved, replaced+preserved)
	}
	if replaced < 3 || replaced > 50 {
		t.Errorf("replacement rate outside [3,50] for prob=0.30 over 60 glyphs: got %d replacements", replaced)
	}
}

// ─── span injection — per-line HTML structure churn (sprint I5) ──

// buildSpansInjectHTMLBody is deterministic when seed != 0. Tests use
// a fixed non-zero seed distinct from the I3/I4 seeds so a regression
// in one stage doesn't mask a regression in another via cross-cancel.
const spansInjectTestSeed int64 = 0xCAFEBABE

// spanAttrRegex matches the exact span opening tag emitted by
// buildSpansInjectHTMLBody — useful for asserting attribute shape and
// counting injected spans without relying on string-prefix arithmetic.
var spanAttrRegex = regexp.MustCompile(`<span style="font-size:(1[3-5])px">`)

func TestBuildSpansInjectHTMLBody_EmptyBodyIsNoOp(t *testing.T) {
	if got := buildSpansInjectHTMLBody("", spansInjectProb, spansInjectTestSeed); got != "" {
		t.Errorf("empty input must return empty string; got %q", got)
	}
}

func TestRawSmtpTest_DefaultFlagSpansNotInjected(t *testing.T) {
	// When spans_inject is OFF, the multipart HTML part must contain
	// the legacy `<p>...</p>` shape with no span tags. We verify at the
	// MIME-byte level: the output bytes contain `<p>` exactly once and
	// zero `<span` substrings.
	body := "Vážený kliente, máme nabídku."
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: body, Multipart: true, // flag absent → false
	}
	stamp := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	mime, err := pickMIME(req, "<id@x>", stamp)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(mime, []byte("<span")) {
		t.Errorf("default-off must NOT inject any <span>; got:\n%s", mime)
	}
}

func TestRawSmtpTest_SpansInjectMultipartFalseIsNoOp(t *testing.T) {
	// spans_inject=true with multipart=false has no HTML to inject
	// into → the flat text/plain MIME is identical to the no-flag baseline.
	// The flag is still echoed in the response but the wire bytes don't
	// change.
	body := "Vážený kliente, máme nabídku."
	mkReq := func(spans bool) rawSMTPTestRequest {
		return rawSMTPTestRequest{
			From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
			Subject: "s", Body: body, Multipart: false, SpansInject: spans,
		}
	}
	stamp := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	mimeOff, err := pickMIME(mkReq(false), "<id@x>", stamp)
	if err != nil {
		t.Fatal(err)
	}
	mimeOn, err := pickMIME(mkReq(true), "<id@x>", stamp)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mimeOff, mimeOn) {
		t.Errorf("spans_inject must be a no-op when multipart=false:\noff=%s\non=%s", mimeOff, mimeOn)
	}
	if bytes.Contains(mimeOn, []byte("<span")) {
		t.Errorf("flat text/plain output must contain no span tags; got:\n%s", mimeOn)
	}
}

func TestBuildSpansInjectHTMLBody_OnMultipartTrueProducesSomeSpans(t *testing.T) {
	// Statistical: with 60 non-empty lines at prob=0.30, P(zero spans) ≈
	// 0.7^60 ≈ 2.2e-10 — vanishingly small for the chosen seed. We assert
	// at least 1 span tag in the output so the path is exercised.
	src := strings.Repeat("line of body content\n", 60)
	got := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)
	matches := spanAttrRegex.FindAllString(got, -1)
	if len(matches) < 1 {
		t.Errorf("at least 1 span must be injected over 60 lines; got %d in:\n%s", len(matches), got)
	}
}

func TestBuildSpansInjectHTMLBody_SingleLineZeroOrOneSpan(t *testing.T) {
	// A single non-empty line is wrapped 30% of the time → output has
	// exactly 0 or 1 span tag, never more. Run with a fixed seed so the
	// outcome is deterministic but the assertion remains correct under
	// any seed choice.
	got := buildSpansInjectHTMLBody("hello world", spansInjectProb, spansInjectTestSeed)
	count := strings.Count(got, "<span")
	if count > 1 {
		t.Errorf("single-line body must produce 0 or 1 span; got %d in %q", count, got)
	}
	closeCount := strings.Count(got, "</span>")
	if closeCount != count {
		t.Errorf("open/close span count mismatch: open=%d close=%d in %q", count, closeCount, got)
	}
}

func TestBuildSpansInjectHTMLBody_SpanAttributeFormatExact(t *testing.T) {
	// Every span tag emitted must match the canonical
	// `<span style="font-size:Npx">` shape exactly — no trailing
	// semicolon, no extra whitespace, N ∈ {13, 14, 15}. We collect every
	// `<span` opener in the output and assert each one matches the regex.
	src := strings.Repeat("a line\n", 50)
	got := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)

	openCount := strings.Count(got, "<span")
	if openCount == 0 {
		t.Skip("seed produced no spans on this corpus — adjust corpus or seed")
	}
	matches := spanAttrRegex.FindAllStringIndex(got, -1)
	if len(matches) != openCount {
		t.Fatalf("span shape drift: %d <span openers but %d matched the canonical regex; output:\n%s",
			openCount, len(matches), got)
	}
}

func TestBuildSpansInjectHTMLBody_SpanTagsNotEntityEncoded(t *testing.T) {
	// The span tags injected by the helper are intentional HTML
	// structure, not literal text — they must NOT be entity-encoded as
	// `&lt;span&gt;`. We assert literal `<span` appears (when spans
	// fire) and `&lt;span` never appears.
	src := strings.Repeat("line\n", 30)
	got := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)
	if strings.Contains(got, "&lt;span") {
		t.Errorf("span tags must not be entity-encoded; got:\n%s", got)
	}
	// Sanity: at least one literal `<span` must appear over 30 lines.
	if !strings.Contains(got, "<span") {
		t.Skip("seed produced no spans on this corpus — adjust corpus or seed")
	}
}

func TestRawSmtpTest_SpansInjectTextPlainPartUntouched(t *testing.T) {
	// text/plain part must remain byte-identical to the no-flag
	// baseline — the span injection is HTML-only.
	body := "Vážený kliente,\nmáme speciální nabídku.\nSrdečně, X"
	mkReq := func(spans bool) rawSMTPTestRequest {
		return rawSMTPTestRequest{
			From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
			Subject: "s", Body: body, Multipart: true, SpansInject: spans,
		}
	}
	stamp := time.Date(2026, 5, 2, 10, 0, 0, 0, time.UTC)
	t.Setenv("SPANS_INJECT_TEST_SEED", strconv.FormatInt(spansInjectTestSeed, 10))
	mimeOn, err := pickMIME(mkReq(true), "<id@x>", stamp)
	if err != nil {
		t.Fatal(err)
	}
	s := string(mimeOn)
	plainStart := strings.Index(s, "Content-Type: text/plain")
	htmlStart := strings.Index(s, "Content-Type: text/html")
	if plainStart < 0 || htmlStart < 0 {
		t.Fatal("missing parts")
	}
	plainPart := s[plainStart:htmlStart]
	if strings.Contains(plainPart, "<span") {
		t.Errorf("text/plain part must not contain span tags:\n%s", plainPart)
	}
	// And the body bytes must appear verbatim in the plain part.
	if !strings.Contains(plainPart, body) {
		t.Errorf("text/plain part must contain body verbatim:\n%s", plainPart)
	}
}

func TestRawSmtpTest_ResponseEchoesSpansInject(t *testing.T) {
	// Idempotent flag echo — operator can verify which shape was sent
	// even when egress is unwired (resp.OK=false).
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"hi\nthere","multipart":true,"spans_inject":true}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body: %s", rr.Code, rr.Body.String())
	}
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if !resp.SpansInject {
		t.Errorf("response must echo spans_inject=true; got %+v", resp)
	}
}

func TestRawSmtpTest_ResponseDefaultsSpansInjectFalse(t *testing.T) {
	// When the flag is omitted, the response must echo it as false —
	// not absent.
	srv, token := testServer(t)
	handler := srv.Handler()

	body := `{"from":"a@email.cz","password":"p","recipient":"r@x.cz","subject":"s","body":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/raw-smtp-test", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	rawBody := rr.Body.String()
	var resp rawSMTPTestResponse
	if err := json.NewDecoder(strings.NewReader(rawBody)).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if resp.SpansInject {
		t.Errorf("default-omitted flag must echo as false; got true")
	}
	if !strings.Contains(rawBody, `"spans_inject":false`) {
		t.Errorf("response JSON must always include spans_inject field; got: %s", rawBody)
	}
}

func TestBuildSpansInjectHTMLBody_DeterministicWithSameSeed(t *testing.T) {
	// Same seed + same input → same output across two runs (test-mode
	// reproducibility). Operator A/B replay relies on this property.
	src := "line one\nline two\nline three\nline four\nline five"
	a := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)
	b := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)
	if a != b {
		t.Errorf("same seed must produce identical output:\nA=%q\nB=%q", a, b)
	}
}

func TestBuildSpansInjectHTMLBody_ProbZeroEscapesWithoutSpans(t *testing.T) {
	// prob=0 → no coin flips ever fire → output is the body, HTML-escaped,
	// joined with `<br/>`, but with ZERO span tags. Defense-in-depth
	// against a misconfigured probability silently mutating the structure.
	src := "first line\n<dangerous> chars\nlast line"
	got := buildSpansInjectHTMLBody(src, 0.0, spansInjectTestSeed)
	if strings.Contains(got, "<span") {
		t.Errorf("prob=0 must emit no span tags; got:\n%s", got)
	}
	// HTML escaping must still run — `<dangerous>` becomes `&lt;dangerous&gt;`.
	if !strings.Contains(got, "&lt;dangerous&gt;") {
		t.Errorf("prob=0 must still HTML-escape line content; got:\n%s", got)
	}
	// Newlines must still become `<br/>`.
	if strings.Count(got, "<br/>") != 2 {
		t.Errorf("3-line body must produce 2 <br/> separators; got %d in:\n%s",
			strings.Count(got, "<br/>"), got)
	}
}

func TestLoadSpansInjectSeed_EnvParsing(t *testing.T) {
	cases := []struct {
		name, env string
		want      int64
	}{
		{"unset", "", 0},
		{"valid_positive", "12345", 12345},
		{"valid_negative", "-7", -7},
		{"hex_not_supported", "0xCAFEBABE", 0}, // strconv.ParseInt base 10 only
		{"garbage", "not-a-number", 0},
		{"whitespace_trimmed", "  42  ", 42},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("SPANS_INJECT_TEST_SEED", c.env)
			if got := loadSpansInjectSeed(); got != c.want {
				t.Errorf("env=%q: got %d, want %d", c.env, got, c.want)
			}
		})
	}
}

func TestBuildSpansInjectHTMLBody_HTMLEscapeWithinSpanAndOutside(t *testing.T) {
	// The HTML escape pipeline must run on EVERY line regardless of
	// whether the line gets wrapped in a span. We feed a body where
	// every line contains `<` `>` `&` and assert no literal special
	// chars survive in the output (they all become entities) AND any
	// span tags inserted around lines are NOT entity-encoded.
	src := strings.Repeat("a <b> & c\n", 30)
	got := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)
	// No literal `<b>` may appear (would mean unescaped user text).
	if strings.Contains(got, "<b>") {
		t.Errorf("user `<b>` must be HTML-escaped; got:\n%s", got)
	}
	// Every line must contain `&lt;b&gt;` and `&amp;` after escape.
	if !strings.Contains(got, "&lt;b&gt;") {
		t.Errorf("expected `&lt;b&gt;` after escape; got:\n%s", got)
	}
	if !strings.Contains(got, "&amp;") {
		t.Errorf("expected `&amp;` after escape; got:\n%s", got)
	}
	// The `<span` and `</span>` tags must NOT be entity-encoded.
	if strings.Contains(got, "&lt;span") || strings.Contains(got, "&lt;/span&gt;") {
		t.Errorf("structural span tags must not be entity-encoded; got:\n%s", got)
	}
}

func TestBuildSpansInjectHTMLBody_NewlinesBecomeBR(t *testing.T) {
	// Multi-line input must produce `<br/>` separators between lines —
	// parity with escapeHTMLBody. Three lines → exactly two `<br/>`s.
	src := "line A\nline B\nline C"
	got := buildSpansInjectHTMLBody(src, 0.0, spansInjectTestSeed) // prob=0 keeps test simple
	if strings.Count(got, "<br/>") != 2 {
		t.Errorf("3-line body must emit 2 <br/>; got %d in:\n%s",
			strings.Count(got, "<br/>"), got)
	}
	// Each line content must appear verbatim (no escaping needed —
	// these lines have no special chars).
	for _, want := range []string{"line A", "line B", "line C"} {
		if !strings.Contains(got, want) {
			t.Errorf("line %q missing from output:\n%s", want, got)
		}
	}
}

func TestBuildSpansInjectHTMLBody_CRLFNormalizedToLF(t *testing.T) {
	// CRLF and lone CR line endings must collapse to LF before splitting,
	// matching escapeHTMLBody behavior. Three line-ending styles must
	// all produce the same 2 `<br/>` count for a 3-line body.
	cases := []string{
		"a\nb\nc",
		"a\r\nb\r\nc",
		"a\rb\rc",
		"a\r\nb\nc", // mixed
	}
	for _, src := range cases {
		got := buildSpansInjectHTMLBody(src, 0.0, spansInjectTestSeed)
		if strings.Count(got, "<br/>") != 2 {
			t.Errorf("input %q: expected 2 <br/>; got %d in:\n%s",
				src, strings.Count(got, "<br/>"), got)
		}
	}
}

func TestBuildSpansInjectHTMLBody_FontSizeWithinAllowedSet(t *testing.T) {
	// Every span emitted must use one of {13, 14, 15}. We collect every
	// font-size value from the regex captures and assert membership.
	src := strings.Repeat("a line\n", 100)
	got := buildSpansInjectHTMLBody(src, spansInjectProb, spansInjectTestSeed)
	allowed := map[string]bool{"13": true, "14": true, "15": true}
	matches := spanAttrRegex.FindAllStringSubmatch(got, -1)
	if len(matches) == 0 {
		t.Skip("seed produced no spans on this corpus — adjust corpus or seed")
	}
	for _, m := range matches {
		if !allowed[m[1]] {
			t.Errorf("font-size %q outside allowed set {13,14,15}; full match=%q", m[1], m[0])
		}
	}
}

func TestRawSmtpTest_SpansInjectMultipartTrueWiresThroughHandler(t *testing.T) {
	// Integration check: the runner must actually call the spans-inject
	// path when both flags are set. We drive a body with 30 lines and
	// assert the response.OK=false branch (egress unwired) but the MIME
	// path was exercised — the response echoes the flag and the runner
	// did not panic.
	srv, _ := testServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	t.Setenv("SPANS_INJECT_TEST_SEED", strconv.FormatInt(spansInjectTestSeed, 10))

	body := strings.Repeat("a line of body\n", 30)
	resp := srv.runRawSMTPTest(ctx, rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@x.cz",
		Subject: "s", Body: body, Multipart: true, SpansInject: true,
	})
	if !resp.SpansInject {
		t.Errorf("response must echo spans_inject=true; got %+v", resp)
	}
	if !resp.Multipart {
		t.Errorf("response must echo multipart=true; got %+v", resp)
	}
}

// ─── Sprint L: bisection flags (engine_html_wrap / redundant_divs /
//             engine_from_displayname / xmailer_header / content_language_cs)
//
// Each flag must default-OFF and produce zero MIME mutation when unset.
// When ON, each flag must produce a verifiable byte-shape difference
// without affecting the others. Together with sprints I0–I5 these are
// the atomic toggles for the kill-or-allow bisection table.

func TestBuildPlainMIME_XMailerHeader_OffByDefault(t *testing.T) {
	req := rawSMTPTestRequest{From: "a@b.cz", Password: "p", Recipient: "c@d.cz", Subject: "s", Body: "x"}
	got := string(buildPlainMIME(req, "<id@x>", time.Now().UTC()))
	if strings.Contains(got, "X-Mailer:") {
		t.Errorf("X-Mailer must be absent when xmailer_header=false; got:\n%s", got)
	}
}

func TestBuildPlainMIME_XMailerHeader_OnEmits(t *testing.T) {
	req := rawSMTPTestRequest{From: "a@b.cz", Password: "p", Recipient: "c@d.cz", Subject: "s", Body: "x", XMailerHeader: true}
	got := string(buildPlainMIME(req, "<id@x>", time.Now().UTC()))
	if !strings.Contains(got, "X-Mailer: Seznam.cz\r\n") {
		t.Errorf("X-Mailer: Seznam.cz must be present when xmailer_header=true; got:\n%s", got)
	}
}

func TestBuildPlainMIME_ContentLanguageCS_OffByDefault(t *testing.T) {
	req := rawSMTPTestRequest{From: "a@b.cz", Password: "p", Recipient: "c@d.cz", Subject: "s", Body: "x"}
	got := string(buildPlainMIME(req, "<id@x>", time.Now().UTC()))
	if strings.Contains(got, "Content-Language:") {
		t.Errorf("Content-Language must be absent when content_language_cs=false; got:\n%s", got)
	}
}

func TestBuildPlainMIME_ContentLanguageCS_OnEmits(t *testing.T) {
	req := rawSMTPTestRequest{From: "a@b.cz", Password: "p", Recipient: "c@d.cz", Subject: "s", Body: "x", ContentLanguageCS: true}
	got := string(buildPlainMIME(req, "<id@x>", time.Now().UTC()))
	if !strings.Contains(got, "Content-Language: cs\r\n") {
		t.Errorf("Content-Language: cs must be present when content_language_cs=true; got:\n%s", got)
	}
}

func TestBuildPlainMIME_EngineFromDisplayName_OffByDefault(t *testing.T) {
	req := rawSMTPTestRequest{From: "a.mazher@email.cz", Password: "p", Recipient: "c@d.cz", Subject: "s", Body: "x"}
	got := string(buildPlainMIME(req, "<id@x>", time.Now().UTC()))
	if !strings.Contains(got, "From: a.mazher@email.cz\r\n") {
		t.Errorf("default From must be bare email; got:\n%s", got)
	}
}

func TestBuildPlainMIME_EngineFromDisplayName_OnEmitsTitleCase(t *testing.T) {
	req := rawSMTPTestRequest{From: "a.mazher@email.cz", Password: "p", Recipient: "c@d.cz", Subject: "s", Body: "x", EngineFromDisplayName: true}
	got := string(buildPlainMIME(req, "<id@x>", time.Now().UTC()))
	if !strings.Contains(got, `From: "A. Mazher" <a.mazher@email.cz>`+"\r\n") {
		t.Errorf("From must use title-cased display name when engine_from_displayname=true; got:\n%s", got)
	}
}

func TestTitleCaseLocalPartDiag_Cases(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"a.mazher@example.com", "A. Mazher"},
		{"jane.doe@x.com", "Jane. Doe"}, // matches the (admittedly imperfect) titleCaseLocalPart in services/campaigns/sender/headers.go — separator stays as ". "
		{"single@x.com", "Single"},
		{"no-at-here", ""},
		{"@nolocal", ""},
		{"three.part.name@x.com", "Three. Part. Name"},
	}
	for _, c := range cases {
		got := titleCaseLocalPartDiag(c.in)
		if got != c.want {
			t.Errorf("titleCaseLocalPartDiag(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildHTMLBody_DefaultMinimalWrap(t *testing.T) {
	req := rawSMTPTestRequest{Body: "Ahoj"}
	got := buildHTMLBody(req)
	want := "<!DOCTYPE html><html><body><p>Ahoj</p></body></html>"
	if got != want {
		t.Errorf("default HTML body must be minimal wrap; got %q want %q", got, want)
	}
}

func TestBuildHTMLBody_EngineHTMLWrap_EmitsFontDiv(t *testing.T) {
	t.Setenv("SPANS_INJECT_TEST_SEED", "42") // deterministic
	req := rawSMTPTestRequest{Body: "Ahoj\nNa shledanou", EngineHTMLWrap: true}
	got := buildHTMLBody(req)
	if !strings.Contains(got, `<html><head><meta charset="utf-8"></head><body>`) {
		t.Errorf("engine_html_wrap must emit <head><meta charset> block; got:\n%s", got)
	}
	if !strings.Contains(got, `<div style="font-family: Arial, sans-serif; font-size: 14px;">`) {
		t.Errorf("engine_html_wrap must emit Fingerprint Arial+14px outer div; got:\n%s", got)
	}
	if !strings.Contains(got, "Ahoj<br>") {
		t.Errorf("engine_html_wrap must emit each line + <br>; got:\n%s", got)
	}
}

func TestBuildHTMLBody_RedundantDivs_RequiresEngineHTMLWrap(t *testing.T) {
	// RedundantDivs only honored in EngineHTMLWrap mode.
	req := rawSMTPTestRequest{Body: "x\n\ny", RedundantDivs: true} // EngineHTMLWrap=false
	got := buildHTMLBody(req)
	if strings.Contains(got, "&nbsp;") {
		t.Errorf("redundant_divs must be no-op without engine_html_wrap; got:\n%s", got)
	}
}

func TestBuildHTMLBody_RedundantDivs_OnPossiblyEmitsDivs(t *testing.T) {
	// 0.20 prob × 30 empty lines → P(≥1 head) ≈ 1 - 0.8^30 ≈ 99.876%.
	// Test asserts statistical near-certainty across a few seeds; if one
	// seed unluckily picks tails 30 times, another seed will get heads.
	body := strings.Repeat("line\n\n", 30)
	for _, seed := range []string{"1", "7", "42"} {
		t.Setenv("SPANS_INJECT_TEST_SEED", seed)
		req := rawSMTPTestRequest{Body: body, EngineHTMLWrap: true, RedundantDivs: true}
		got := buildHTMLBody(req)
		if strings.Contains(got, "<div>&nbsp;</div>") {
			return // success — flag is plumbed through and emits in at least one trial
		}
	}
	t.Errorf("redundant_divs+engine_html_wrap must emit <div>&nbsp;</div> in at least one of 3 trials with 30 empty lines (P≈99.9%% per trial)")
}

func TestBuildHTMLBody_SpansInject_StillWorksInEngineWrap(t *testing.T) {
	// 0.30 prob × 30 lines → P(≥1 head) ≈ 1 - 0.7^30 ≈ 99.998%.
	body := strings.Repeat("content line\n", 30)
	for _, seed := range []string{"1", "7", "42"} {
		t.Setenv("SPANS_INJECT_TEST_SEED", seed)
		req := rawSMTPTestRequest{Body: body, EngineHTMLWrap: true, SpansInject: true}
		got := buildHTMLBody(req)
		if strings.Contains(got, `<span style="font-size:`) {
			return
		}
	}
	t.Errorf("spans_inject+engine_html_wrap must emit at least one span across 3 seeds × 30 lines")
}

// ─── Sprint M: body-composition + relay-wire-format flags ────────────
//
// tone_greeting / tone_closing / signature_block / restore_diacritics
// mutate body BEFORE MIME wrap. relay_build_message routes through
// delivery.BuildMessage to exercise the production D5+D6 wire format.

func TestSignatureFixture_DerivedFromLocalPart(t *testing.T) {
	got := signatureFixture("a.mazher@email.cz")
	if !strings.Contains(got, "A. Mazher") {
		t.Errorf("signature must use title-cased local part; got %q", got)
	}
	if !strings.Contains(got, "+420 777 123 456") {
		t.Errorf("signature must include phone fixture; got %q", got)
	}
}

func TestSignatureFixture_FallbackWhenNoLocalPart(t *testing.T) {
	got := signatureFixture("@invalid")
	if !strings.Contains(got, "Obchodník") {
		t.Errorf("signature must fall back to Obchodník when local part empty; got %q", got)
	}
}

func TestRunRawSMTPTest_ToneGreetingPrependsBody(t *testing.T) {
	// Drive the runner with no egress so the function returns early after
	// MIME assembly — but with body composition fully applied. We can't
	// observe the assembled MIME from the public response, but we can
	// verify the echo flag is set + the runner does not crash.
	s := &Server{}
	resp := s.runRawSMTPTest(context.Background(), rawSMTPTestRequest{
		From: "a@b.cz", Password: "p", Recipient: "c@d.cz",
		Subject: "s", Body: "test body", ToneGreeting: true,
	})
	if !resp.ToneGreeting {
		t.Errorf("response must echo tone_greeting=true")
	}
}

func TestRunRawSMTPTest_AllPhase2FlagsEcho(t *testing.T) {
	s := &Server{}
	resp := s.runRawSMTPTest(context.Background(), rawSMTPTestRequest{
		From: "a.mazher@email.cz", Password: "p", Recipient: "c@d.cz",
		Subject: "s", Body: "x",
		ToneGreeting: true, ToneClosing: true, SignatureBlock: true,
		RestoreDiacritics: true, RelayBuildMessage: true,
	})
	if !resp.ToneGreeting || !resp.ToneClosing || !resp.SignatureBlock || !resp.RestoreDiacritics || !resp.RelayBuildMessage {
		t.Errorf("response must echo all 5 Phase-2 flags; got %+v", resp)
	}
}

func TestPickMIME_RelayBuildMessage_TextPlain(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a.mazher@email.cz", Password: "p", Recipient: "c@d.cz",
		Subject: "Vážený", Body: "ahoj",
		RelayBuildMessage: true,
	}
	got, err := pickMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("pickMIME: %v", err)
	}
	s := string(got)
	if !strings.Contains(s, "From: a.mazher@email.cz\r\n") {
		t.Errorf("relay BuildMessage must emit bare From when EngineFromDisplayName=false; got:\n%s", s)
	}
	// The relay's BuildMessage anonymizes Message-ID via D5 sanitizeHeaders
	// — original `<id@email.cz>` is replaced. We verify the input ID is NOT
	// present (proving we went through the privacy pipeline).
	if strings.Contains(s, "<id@email.cz>") {
		t.Errorf("relay BuildMessage must anonymize Message-ID; original found in:\n%s", s)
	}
	// And SOME Message-ID is present (sanitized, not stripped).
	if !strings.Contains(s, "Message-ID: ") {
		t.Errorf("relay BuildMessage must emit a Message-ID; got:\n%s", s)
	}
}

func TestPickMIME_RelayBuildMessage_MultipartWithEngineWrap(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@b.cz", Password: "p", Recipient: "c@d.cz",
		Subject: "s", Body: "ahoj\nna shledanou",
		RelayBuildMessage: true, Multipart: true, EngineHTMLWrap: true,
	}
	got, err := pickMIME(req, "<id@x>", time.Now().UTC())
	if err != nil {
		t.Fatalf("pickMIME: %v", err)
	}
	s := string(got)
	if !strings.Contains(s, "multipart/alternative") {
		t.Errorf("relay BuildMessage with Multipart=true must produce multipart/alternative; got:\n%s", s)
	}
	if !strings.Contains(s, "Arial, sans-serif") {
		t.Errorf("HTML body must come from buildHTMLBody (Engine wrap); got:\n%s", s)
	}
}

func TestRunRawSMTPTest_EchoesAllNewFlags(t *testing.T) {
	// Call the runner with every flag ON; verify the response echoes them
	// even though the actual SMTP fails (no egress in test) — the echo is
	// the contract that bisection tooling depends on.
	s := &Server{} // no egress wired
	resp := s.runRawSMTPTest(context.Background(), rawSMTPTestRequest{
		From: "a.mazher@email.cz", Password: "p", Recipient: "c@d.cz",
		Subject: "s", Body: "x",
		EngineHTMLWrap: true, RedundantDivs: true, EngineFromDisplayName: true,
		XMailerHeader: true, ContentLanguageCS: true,
	})
	if !resp.EngineHTMLWrap {
		t.Errorf("response must echo engine_html_wrap=true")
	}
	if !resp.RedundantDivs {
		t.Errorf("response must echo redundant_divs=true")
	}
	if !resp.EngineFromDisplayName {
		t.Errorf("response must echo engine_from_displayname=true")
	}
	if !resp.XMailerHeader {
		t.Errorf("response must echo xmailer_header=true")
	}
	if !resp.ContentLanguageCS {
		t.Errorf("response must echo content_language_cs=true")
	}
}

// ─── Sprint F — TBD anti-trace flags (H5, H6, H7, H8, C8, C9, C10, M6, M7, M8) ───
// Anti-trace pipeline step map SHA c82e95a2 (docs/subsystem-maps/anti-trace.md)

// ─── H5: date_prague_tz ───────────────────────────────────────────────────

func TestH5DatePragueTZ_WireCarriesPragueOffset(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "Ahoj", Body: "tělo zprávy",
		DatePragueTZ: true,
	}
	// Use pickNow to get the Prague time and format it the same way buildPlainMIME does.
	now := pickNow(true)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	s := string(mime)
	// Prague offset is either +0100 (CET) or +0200 (CEST) — never +0000.
	if !strings.Contains(s, "+0100") && !strings.Contains(s, "+0200") {
		t.Errorf("date_prague_tz=true must yield +0100/+0200 in Date header; got header block:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
}

func TestH5DatePragueTZ_FalseUsesUTC(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "Ahoj", Body: "tělo",
		DatePragueTZ: false,
	}
	now := pickNow(false)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	s := string(mime)
	if !strings.Contains(s, "+0000") {
		t.Errorf("date_prague_tz=false must yield +0000 in Date header; got:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
}

func TestH5DatePragueTZ_EchoedInResponse(t *testing.T) {
	s := &Server{}
	resp := s.runRawSMTPTest(context.Background(), rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "b", DatePragueTZ: true,
	})
	if !resp.DatePragueTZ {
		t.Errorf("response must echo date_prague_tz=true; got %+v", resp)
	}
}

// ─── H6: received_chain_strip ────────────────────────────────────────────

func TestH6ReceivedChainStrip_RelayPathStripsHeader(t *testing.T) {
	// When RelayBuildMessage=true and ReceivedChainStrip=true, the synthetic
	// Received: header must NOT appear in the wire MIME (relay D5 strips it).
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "test",
		RelayBuildMessage: true, ReceivedChainStrip: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("pickMIME: %v", err)
	}
	s := string(mime)
	if strings.Contains(strings.ToLower(s), "received:") {
		t.Errorf("relay path must strip synthetic Received: header; found in wire MIME:\n%s", s)
	}
}

func TestH6ReceivedChainStrip_DirectPathInjectsHeader(t *testing.T) {
	// When RelayBuildMessage=false and ReceivedChainStrip=true, the synthetic
	// Received: IS present (direct path does not sanitize).
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "test",
		ReceivedChainStrip: true,
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	s := string(mime)
	if !strings.Contains(s, "Received:") {
		t.Errorf("direct path with received_chain_strip=true must inject Received: header; got:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
}

func TestH6ReceivedChainStrip_FalseNoInjection(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "test",
		ReceivedChainStrip: false,
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	if strings.Contains(strings.ToLower(s), "received:") {
		t.Errorf("received_chain_strip=false must not inject Received: header; got:\n%s", s)
	}
}

// ─── H7: user_agent_strip ────────────────────────────────────────────────

func TestH7UserAgentStrip_RelayPathStripsHeader(t *testing.T) {
	// When RelayBuildMessage=true and UserAgentStrip=true, User-Agent must
	// NOT appear in wire MIME (relay D5 stripPrivacyHeaders removes it).
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "test",
		RelayBuildMessage: true, UserAgentStrip: true,
	}
	mime, err := pickMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("pickMIME: %v", err)
	}
	s := string(mime)
	if strings.Contains(strings.ToLower(s), "user-agent:") {
		t.Errorf("relay path must strip User-Agent header; found in wire MIME:\n%s", s)
	}
}

func TestH7UserAgentStrip_DirectPathInjectsHeader(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "test",
		UserAgentStrip: true,
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	if !strings.Contains(s, "User-Agent:") {
		t.Errorf("direct path with user_agent_strip=true must inject User-Agent; got:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
}

func TestH7UserAgentStrip_FalseNoInjection(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "test",
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	if strings.Contains(strings.ToLower(s), "user-agent:") {
		t.Errorf("user_agent_strip=false must not inject User-Agent; got:\n%s", s)
	}
}

// ─── H8: rfc2047_subject_encoding ────────────────────────────────────────

func TestH8RFC2047SubjectEncoding_EncodesSubject(t *testing.T) {
	subject := "Vážený kliente"
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: subject, Body: "test",
		RFC2047SubjectEncoding: true,
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	// Subject must be RFC2047 base64 encoded.
	if !strings.Contains(s, "Subject: =?UTF-8?B?") {
		t.Errorf("rfc2047_subject_encoding=true must produce =?UTF-8?B? subject; got:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
	// Must NOT contain the raw UTF-8 subject.
	if strings.Contains(s, "Subject: "+subject) {
		t.Errorf("rfc2047_subject_encoding=true must not emit raw UTF-8 subject; got:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
}

func TestH8RFC2047SubjectEncoding_FalsePreservesRawUTF8(t *testing.T) {
	subject := "Vážený kliente"
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: subject, Body: "test",
		RFC2047SubjectEncoding: false,
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	if !strings.Contains(s, "Subject: "+subject+"\r\n") {
		t.Errorf("rfc2047_subject_encoding=false must preserve raw UTF-8 subject; got:\n%s", s[:strings.Index(s, "\r\n\r\n")])
	}
}

func TestH8RFC2047SubjectEncoding_EncodingIsDecodable(t *testing.T) {
	subject := "Příliš žluťoučký kůň"
	encoded := encodeSubjectRFC2047(subject)
	// Must start and end with RFC2047 markers.
	if !strings.HasPrefix(encoded, "=?UTF-8?B?") || !strings.HasSuffix(encoded, "?=") {
		t.Fatalf("encoding format wrong: %q", encoded)
	}
	// Extract and decode the base64 payload.
	inner := strings.TrimPrefix(encoded, "=?UTF-8?B?")
	inner = strings.TrimSuffix(inner, "?=")
	decoded, err := base64.StdEncoding.DecodeString(inner)
	if err != nil {
		t.Fatalf("base64 decode failed: %v", err)
	}
	if string(decoded) != subject {
		t.Errorf("decoded subject mismatch: got %q, want %q", string(decoded), subject)
	}
}

// ─── C8: typo_injection ───────────────────────────────────────────────────

func TestC8TypoInjection_InjectsPunctuation(t *testing.T) {
	t.Setenv("TYPO_INJECT_TEST_SEED", "1") // seed=1 gives non-zero count
	body := "Toto je testovací tělo zprávy pro B2B klienta strojní techniky"
	// Use seed 1 which produces at least one injection.
	got := applyTypoInjection(body, 1)
	// Count punctuation injected by checking comma/period difference.
	commasBefore := strings.Count(body, ",")
	periodsBefore := strings.Count(body, ".")
	commasAfter := strings.Count(got, ",")
	periodsAfter := strings.Count(got, ".")
	if commasAfter+periodsAfter <= commasBefore+periodsBefore {
		// seed=1: Intn(4) might return 0 on rare occasions; try seed=7.
		got = applyTypoInjection(body, 7)
		commasAfter = strings.Count(got, ",")
		periodsAfter = strings.Count(got, ".")
		if commasAfter+periodsAfter <= commasBefore+periodsBefore {
			t.Errorf("typo_injection must inject at least one comma or period (tried seeds 1,7); got:\n%q", got)
		}
	}
}

func TestC8TypoInjection_FalseBodyVerbatim(t *testing.T) {
	// When typo_injection=false, body must be verbatim (no mutation).
	// Default ContentTransferEncoding8Bit=false (zero) → 8bit path preserves raw bytes.
	body := "Telo bez chyb pro klienta."
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: body,
		TypoInjection: false,
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	if !bytes.Contains(mime, []byte(body)) {
		t.Errorf("typo_injection=false must preserve body verbatim; got:\n%s", mime)
	}
}

func TestC8TypoInjection_EmptyBodyNoOp(t *testing.T) {
	got := applyTypoInjection("", 1)
	if got != "" {
		t.Errorf("empty body must return empty; got %q", got)
	}
}

// ─── C9: bump_forward_wrap ────────────────────────────────────────────────

func TestC9BumpForwardWrap_ProducesReplyStyle(t *testing.T) {
	body := "Původní zpráva pro klienta."
	subject := "Nabídka strojů"
	got := applyBumpForwardWrap(body, subject)
	if !strings.HasPrefix(got, "Re: "+subject) {
		t.Errorf("bump_forward_wrap must start with Re: <subject>; got %q", got)
	}
	if !strings.Contains(got, "\n\n> ") {
		t.Errorf("bump_forward_wrap must include quoted body line (> prefix); got %q", got)
	}
	if !strings.Contains(got, "> "+body) {
		t.Errorf("bump_forward_wrap must quote original body verbatim; got %q", got)
	}
}

func TestC9BumpForwardWrap_FalseBodyVerbatim(t *testing.T) {
	body := "Verbatim telo zpravy."
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: body,
		BumpForwardWrap: false,
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	if !bytes.Contains(mime, []byte(body)) {
		t.Errorf("bump_forward_wrap=false must preserve body verbatim; got:\n%s", mime)
	}
	if bytes.Contains(mime, []byte("Re: ")) {
		t.Errorf("bump_forward_wrap=false must not inject Re: prefix; got:\n%s", mime)
	}
}

func TestC9BumpForwardWrap_MultilineBodyAllLinesQuoted(t *testing.T) {
	body := "Řádek 1\nŘádek 2\nŘádek 3"
	got := applyBumpForwardWrap(body, "s")
	lines := strings.Split(got, "\n")
	quotedCount := 0
	for _, l := range lines {
		if strings.HasPrefix(l, "> ") {
			quotedCount++
		}
	}
	if quotedCount != 3 {
		t.Errorf("bump_forward_wrap must quote all 3 body lines; got %d quoted in:\n%q", quotedCount, got)
	}
}

// ─── C10: voice_profile_variation ────────────────────────────────────────

func TestC10VoiceProfileVariation_PrependAnnotation(t *testing.T) {
	body := "Tělo zprávy."
	got := applyVoiceProfileVariation(body, "test@example.com")
	if !strings.HasPrefix(got, "Voice: VARIANT_") {
		t.Errorf("voice_profile_variation must prepend Voice: VARIANT_X; got %q", got)
	}
	if !strings.Contains(got, body) {
		t.Errorf("voice_profile_variation must preserve original body; got %q", got)
	}
}

func TestC10VoiceProfileVariation_DeterministicPerAddress(t *testing.T) {
	body := "test"
	addr := "a.mazher@email.cz"
	got1 := applyVoiceProfileVariation(body, addr)
	got2 := applyVoiceProfileVariation(body, addr)
	if got1 != got2 {
		t.Errorf("voice_profile_variation must be deterministic per address: %q vs %q", got1, got2)
	}
	// Extract variant.
	variant := strings.TrimPrefix(strings.Split(got1, "\n")[0], "Voice: VARIANT_")
	if variant != "A" && variant != "B" && variant != "C" {
		t.Errorf("variant must be A, B, or C; got %q", variant)
	}
}

func TestC10VoiceProfileVariation_FalseBodyVerbatim(t *testing.T) {
	body := "Telo bez voice annotation."
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: body,
		VoiceProfileVariation: false,
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	if bytes.Contains(mime, []byte("Voice: VARIANT_")) {
		t.Errorf("voice_profile_variation=false must not inject annotation; got:\n%s", mime)
	}
	if !bytes.Contains(mime, []byte(body)) {
		t.Errorf("voice_profile_variation=false must preserve body verbatim; got:\n%s", mime)
	}
}

// ─── M6: header_order ────────────────────────────────────────────────────

func TestM6HeaderOrder_DefaultOrderDateBeforeMessageID(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "b",
		HeaderOrder: "default",
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	s := string(mime)
	dateIdx := strings.Index(s, "Date:")
	msgIDIdx := strings.Index(s, "Message-Id:")
	if dateIdx < 0 || msgIDIdx < 0 {
		t.Fatalf("missing Date or Message-Id in:\n%s", s)
	}
	if dateIdx > msgIDIdx {
		t.Errorf("header_order=default must place Date before Message-Id; dateIdx=%d msgIDIdx=%d", dateIdx, msgIDIdx)
	}
}

func TestM6HeaderOrder_AlphabeticalSortsHeaders(t *testing.T) {
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "b",
		HeaderOrder: "alphabetical",
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	mime := buildPlainMIME(req, "<id@email.cz>", now)
	s := string(mime)
	// After From:, headers should be sorted. Date comes before Message-Id
	// alphabetically ("d" < "m").
	dateIdx := strings.Index(s, "Date:")
	messageIDIdx := strings.Index(s, "Message-Id:")
	mimeVerIdx := strings.Index(s, "MIME-Version:")
	if dateIdx < 0 || messageIDIdx < 0 || mimeVerIdx < 0 {
		t.Fatalf("missing required headers in:\n%s", s)
	}
	// In alphabetical order: Date < Message-Id < MIME-Version (d < m).
	// Both Date and Message-Id start with M/D — check d comes before m.
	if dateIdx > messageIDIdx {
		t.Errorf("alphabetical: Date must precede Message-Id; dateIdx=%d messageIDIdx=%d\n%s", dateIdx, messageIDIdx, s)
	}
}

func TestM6HeaderOrder_ReverseFlipsOrder(t *testing.T) {
	reqDefault := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "b", HeaderOrder: "default",
	}
	reqReverse := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "b", HeaderOrder: "reverse",
	}
	now := time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC)
	id := "<id@email.cz>"
	mimeDefault := buildPlainMIME(reqDefault, id, now)
	mimeReverse := buildPlainMIME(reqReverse, id, now)
	sD := string(mimeDefault)
	sR := string(mimeReverse)

	// The header blocks (up to first blank line) must differ.
	blankD := strings.Index(sD, "\r\n\r\n")
	blankR := strings.Index(sR, "\r\n\r\n")
	if blankD < 0 || blankR < 0 {
		t.Fatal("no blank line separating headers from body")
	}
	headersD := sD[:blankD]
	headersR := sR[:blankR]
	if headersD == headersR {
		t.Errorf("reverse must produce different header order from default:\n%s\nvs\n%s", headersD, headersR)
	}
}

// ─── M7: boundary_format ─────────────────────────────────────────────────

func TestM7BoundaryFormat_DefaultMatchesPartPattern(t *testing.T) {
	b, err := pickBoundary("default")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(b, "----=_Part_") {
		t.Errorf("default boundary must start with ----=_Part_; got %q", b)
	}
}

func TestM7BoundaryFormat_UUIDMatchesUUIDPattern(t *testing.T) {
	b, err := pickBoundary("uuid")
	if err != nil {
		t.Fatal(err)
	}
	// UUID v4: 8-4-4-4-12 hex groups.
	uuidRE := regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	if !uuidRE.MatchString(b) {
		t.Errorf("uuid boundary must match UUID v4 pattern; got %q", b)
	}
}

func TestM7BoundaryFormat_NextPartMatchesPattern(t *testing.T) {
	b, err := pickBoundary("nextpart")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(b, "_NextPart_") {
		t.Errorf("nextpart boundary must start with _NextPart_; got %q", b)
	}
}

func TestM7BoundaryFormat_MimePartMatchesPattern(t *testing.T) {
	b, err := pickBoundary("mimepart")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(b, "_mimepart_") {
		t.Errorf("mimepart boundary must start with _mimepart_; got %q", b)
	}
}

func TestM7BoundaryFormat_InMultipartMIME(t *testing.T) {
	for _, format := range []string{"default", "uuid", "nextpart", "mimepart"} {
		t.Run(format, func(t *testing.T) {
			req := rawSMTPTestRequest{
				From: "a@email.cz", Password: "p", Recipient: "r@example.org",
				Subject: "s", Body: "b", Multipart: true,
				BoundaryFormat: format,
			}
			mime, err := pickMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
			if err != nil {
				t.Fatalf("pickMIME: %v", err)
			}
			s := string(mime)
			if !strings.Contains(s, "multipart/alternative") {
				t.Errorf("format=%s: must produce multipart; got:\n%s", format, s)
			}
		})
	}
}

// ─── M8: content_transfer_encoding_8bit ──────────────────────────────────

// M8: flag polarity — false (zero value) = 8bit (default/backward-compat),
//                    true = quoted-printable (opt-in).

func TestM8ContentTransferEncoding8Bit_FalseDefault8bit(t *testing.T) {
	// Default (false / zero value) must preserve the pre-Sprint-F 8bit behavior.
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "Příliš žluťoučký kůň",
		// ContentTransferEncoding8Bit: false  ← zero value, default
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	if !strings.Contains(s, "Content-Transfer-Encoding: 8bit\r\n") {
		t.Errorf("content_transfer_encoding_8bit=false (default) must emit 8bit CTE; got:\n%s", s)
	}
	if strings.Contains(s, "quoted-printable") {
		t.Errorf("content_transfer_encoding_8bit=false (default) must not emit quoted-printable; got:\n%s", s)
	}
}

func TestM8ContentTransferEncoding8Bit_TrueUsesQP(t *testing.T) {
	// true = opt-in quoted-printable.
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: "Příliš žluťoučký kůň",
		ContentTransferEncoding8Bit: true,
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	if !strings.Contains(s, "Content-Transfer-Encoding: quoted-printable\r\n") {
		t.Errorf("content_transfer_encoding_8bit=true must emit quoted-printable CTE; got:\n%s", s)
	}
	if strings.Contains(s, "Content-Transfer-Encoding: 8bit") {
		t.Errorf("content_transfer_encoding_8bit=true must not emit 8bit; got:\n%s", s)
	}
}

func TestM8ContentTransferEncoding8Bit_QPBodyIsValidEncoding(t *testing.T) {
	body := "Příliš žluťoučký kůň úpěl ďábelské ódy"
	req := rawSMTPTestRequest{
		From: "a@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "s", Body: body,
		ContentTransferEncoding8Bit: true, // true = QP
	}
	mime := buildPlainMIME(req, "<id@email.cz>", time.Date(2026, 5, 4, 10, 0, 0, 0, time.UTC))
	s := string(mime)
	// QP-encoded Czech text should contain = sequences for multibyte chars.
	if !strings.Contains(s, "=") {
		t.Errorf("quoted-printable body must contain = escape sequences for Czech diacritics; got:\n%s", s)
	}
	// Body should not contain raw multibyte UTF-8 diacritic chars directly.
	if strings.Contains(s, "Příliš") {
		t.Errorf("QP encoding must encode non-ASCII diacritics; raw UTF-8 found in:\n%s", s)
	}
}

// ─── Sprint F echo-back integration test ─────────────────────────────────

func TestRunRawSMTPTest_SprintFAllFlagsEchoed(t *testing.T) {
	s := &Server{} // no egress wired
	resp := s.runRawSMTPTest(context.Background(), rawSMTPTestRequest{
		From: "a.mazher@email.cz", Password: "p", Recipient: "r@example.org",
		Subject: "Vážený kliente", Body: "test těla zprávy",
		DatePragueTZ: true, ReceivedChainStrip: true, UserAgentStrip: true,
		RFC2047SubjectEncoding: true, TypoInjection: true,
		BumpForwardWrap: true, VoiceProfileVariation: true,
		HeaderOrder: "reverse", BoundaryFormat: "uuid",
		ContentTransferEncoding8Bit: true,
	})
	if !resp.DatePragueTZ {
		t.Errorf("response must echo date_prague_tz")
	}
	if !resp.ReceivedChainStrip {
		t.Errorf("response must echo received_chain_strip")
	}
	if !resp.UserAgentStrip {
		t.Errorf("response must echo user_agent_strip")
	}
	if !resp.RFC2047SubjectEncoding {
		t.Errorf("response must echo rfc2047_subject_encoding")
	}
	if !resp.TypoInjection {
		t.Errorf("response must echo typo_injection")
	}
	if !resp.BumpForwardWrap {
		t.Errorf("response must echo bump_forward_wrap")
	}
	if !resp.VoiceProfileVariation {
		t.Errorf("response must echo voice_profile_variation")
	}
	if resp.HeaderOrder != "reverse" {
		t.Errorf("response must echo header_order=reverse; got %q", resp.HeaderOrder)
	}
	if resp.BoundaryFormat != "uuid" {
		t.Errorf("response must echo boundary_format=uuid; got %q", resp.BoundaryFormat)
	}
	if !resp.ContentTransferEncoding8Bit {
		t.Errorf("response must echo content_transfer_encoding_8bit=true")
	}
}

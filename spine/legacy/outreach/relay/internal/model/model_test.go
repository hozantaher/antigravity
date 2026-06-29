package model

import (
	"encoding/json"
	"testing"
)

// ---------------------------------------------------------------------------
// InlineSMTPCreds.IsComplete
// ---------------------------------------------------------------------------

func TestInlineSMTPCredsIsComplete_AllPresent(t *testing.T) {
	c := InlineSMTPCreds{SMTPHost: "smtp.example.com", SMTPUsername: "user@example.com", SMTPPassword: "secret"}
	if !c.IsComplete() {
		t.Fatal("expected IsComplete()=true when all three fields are set")
	}
}

func TestInlineSMTPCredsIsComplete_MissingHost(t *testing.T) {
	c := InlineSMTPCreds{SMTPHost: "", SMTPUsername: "user@example.com", SMTPPassword: "secret"}
	if c.IsComplete() {
		t.Fatal("expected IsComplete()=false when SMTPHost is empty")
	}
}

func TestInlineSMTPCredsIsComplete_MissingUsername(t *testing.T) {
	c := InlineSMTPCreds{SMTPHost: "smtp.example.com", SMTPUsername: "", SMTPPassword: "secret"}
	if c.IsComplete() {
		t.Fatal("expected IsComplete()=false when SMTPUsername is empty")
	}
}

func TestInlineSMTPCredsIsComplete_MissingPassword(t *testing.T) {
	c := InlineSMTPCreds{SMTPHost: "smtp.example.com", SMTPUsername: "user@example.com", SMTPPassword: ""}
	if c.IsComplete() {
		t.Fatal("expected IsComplete()=false when SMTPPassword is empty")
	}
}

func TestInlineSMTPCredsIsComplete_Zero(t *testing.T) {
	var c InlineSMTPCreds
	if c.IsComplete() {
		t.Fatal("zero value InlineSMTPCreds must not be complete")
	}
}

// ---------------------------------------------------------------------------
// IntakeRequest marshal / unmarshal with SMTP fields
// ---------------------------------------------------------------------------

func TestIntakeRequestMarshalSMTPFields(t *testing.T) {
	req := IntakeRequest{
		Recipient:    "dest@example.com",
		Subject:      "Hello",
		Body:         "body",
		SMTPHost:     "smtp.example.com",
		SMTPPort:     465,
		SMTPUsername: "user@example.com",
		SMTPPassword: "hunter2",
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got IntakeRequest
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.SMTPHost != req.SMTPHost {
		t.Errorf("SMTPHost: got %q, want %q", got.SMTPHost, req.SMTPHost)
	}
	if got.SMTPPort != req.SMTPPort {
		t.Errorf("SMTPPort: got %d, want %d", got.SMTPPort, req.SMTPPort)
	}
	if got.SMTPUsername != req.SMTPUsername {
		t.Errorf("SMTPUsername: got %q, want %q", got.SMTPUsername, req.SMTPUsername)
	}
	if got.SMTPPassword != req.SMTPPassword {
		t.Errorf("SMTPPassword: got %q, want %q", got.SMTPPassword, req.SMTPPassword)
	}
}

func TestIntakeRequestMarshalOmitemptyWhenAbsent(t *testing.T) {
	req := IntakeRequest{Recipient: "dest@example.com", Subject: "S", Body: "b"}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	for _, field := range []string{"smtp_host", "smtp_port", "smtp_username", "smtp_password"} {
		if contains(s, `"`+field+`"`) {
			t.Errorf("field %q must be omitted when empty, got JSON: %s", field, s)
		}
	}
}

// ---------------------------------------------------------------------------
// IntakeRequest.InlineCreds
// ---------------------------------------------------------------------------

func TestIntakeRequestInlineCreds_Complete(t *testing.T) {
	req := IntakeRequest{
		SMTPHost:     "smtp.example.com",
		SMTPPort:     587,
		SMTPUsername: "u",
		SMTPPassword: "p",
	}
	c := req.InlineCreds()
	if !c.IsComplete() {
		t.Fatal("InlineCreds() should return complete creds")
	}
	if c.SMTPHost != "smtp.example.com" {
		t.Errorf("host mismatch: %q", c.SMTPHost)
	}
	if c.SMTPPort != 587 {
		t.Errorf("port mismatch: %d", c.SMTPPort)
	}
}

func TestIntakeRequestInlineCreds_Incomplete(t *testing.T) {
	req := IntakeRequest{SMTPHost: "smtp.example.com"} // no username/password
	c := req.InlineCreds()
	if c.IsComplete() {
		t.Fatal("partial creds must not be complete")
	}
}

func TestIntakeRequestInlineCreds_ZeroRequest(t *testing.T) {
	var req IntakeRequest
	c := req.InlineCreds()
	if c.IsComplete() {
		t.Fatal("zero IntakeRequest must yield incomplete creds")
	}
}

// ---------------------------------------------------------------------------
// Envelope carries InlineCreds through serialisation
// ---------------------------------------------------------------------------

func TestEnvelopeInlineCredsRoundtrip(t *testing.T) {
	env := Envelope{
		ID:          "env_abc",
		FromAddress: "user@example.com",
		InlineCreds: InlineSMTPCreds{
			SMTPHost:     "smtp.example.com",
			SMTPPort:     465,
			SMTPUsername: "user@example.com",
			SMTPPassword: "s3cr3t",
		},
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Envelope
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.InlineCreds.SMTPHost != env.InlineCreds.SMTPHost {
		t.Errorf("host: got %q, want %q", got.InlineCreds.SMTPHost, env.InlineCreds.SMTPHost)
	}
	if got.InlineCreds.SMTPPort != env.InlineCreds.SMTPPort {
		t.Errorf("port: got %d, want %d", got.InlineCreds.SMTPPort, env.InlineCreds.SMTPPort)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && stringContains(s, sub))
}

func stringContains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestSelectSizeClass(t *testing.T) {
	cases := []struct {
		length int
		want   int
	}{
		{10, SizeClass512},
		{500, SizeClass512},
		{513, SizeClass2K},
		{2000, SizeClass2K},
		{2049, SizeClass8K},
		{8000, SizeClass8K},
		{8193, SizeClass32K},
		{30000, SizeClass32K},
		{99999, SizeClass32K},
	}

	for _, tc := range cases {
		got := SelectSizeClass(tc.length)
		if got != tc.want {
			t.Errorf("SelectSizeClass(%d) = %d, want %d", tc.length, got, tc.want)
		}
	}
}

func TestSizeClasses(t *testing.T) {
	classes := SizeClasses()
	if len(classes) != 4 {
		t.Fatalf("expected 4 size classes, got %d", len(classes))
	}
	for i := 1; i < len(classes); i++ {
		if classes[i] <= classes[i-1] {
			t.Fatal("size classes should be ascending")
		}
	}
}

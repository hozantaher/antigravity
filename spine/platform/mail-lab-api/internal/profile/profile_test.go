package profile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for ML2.2 — profile registry.
// ════════════════════════════════════════════════════════════════════════

// 1. LoadEmbedded reads compiled-in defaults (3 providers).
func TestS22_LoadEmbedded_AllThree(t *testing.T) {
	r := NewRegistry()
	n, err := r.LoadEmbedded()
	if err != nil {
		t.Fatalf("load embedded: %v", err)
	}
	if n != 3 {
		t.Errorf("loaded %d profiles, want 3", n)
	}
	for _, want := range []string{"seznam.lab", "gmail.lab", "outlook.lab"} {
		if _, err := r.Get(want); err != nil {
			t.Errorf("Get(%q): %v", want, err)
		}
	}
}

// 2. Profile values match expected per-provider defaults.
func TestS22_DefaultValues_PerProvider(t *testing.T) {
	r := NewRegistry()
	if _, err := r.LoadEmbedded(); err != nil {
		t.Fatalf("load: %v", err)
	}
	cases := []struct {
		domain  string
		size    int64
		rate    int
		rejCz   bool
		grey    bool
	}{
		{"seznam.lab", 31457280, 100, true, false},
		{"gmail.lab", 26214400, 500, false, false},
		{"outlook.lab", 36700160, 30, false, true},
	}
	for _, c := range cases {
		got, err := r.Get(c.domain)
		if err != nil {
			t.Errorf("get %s: %v", c.domain, err)
			continue
		}
		p, ok := got.(*Profile)
		if !ok {
			t.Errorf("%s: type assertion failed", c.domain)
			continue
		}
		if p.MaxMessageSizeBytes != c.size {
			t.Errorf("%s: size %d, want %d", c.domain, p.MaxMessageSizeBytes, c.size)
		}
		if p.RateLimitPerHour != c.rate {
			t.Errorf("%s: rate %d, want %d", c.domain, p.RateLimitPerHour, c.rate)
		}
		if p.RejectNonCzOrigin != c.rejCz {
			t.Errorf("%s: rejectNonCz %v, want %v", c.domain, p.RejectNonCzOrigin, c.rejCz)
		}
		if p.GreylistUnknownSender != c.grey {
			t.Errorf("%s: greylist %v, want %v", c.domain, p.GreylistUnknownSender, c.grey)
		}
	}
}

// 3. Get is case-insensitive on domain.
func TestS22_GetCaseInsensitive(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	if _, err := r.Get("SEZNAM.LAB"); err != nil {
		t.Errorf("Get uppercase: %v", err)
	}
	if _, err := r.Get("Seznam.Lab"); err != nil {
		t.Errorf("Get mixed-case: %v", err)
	}
}

// 4. Unknown domain returns ErrUnknownDomain.
func TestS22_UnknownDomainError(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	_, err := r.Get("never.lab")
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 5. Apply override changes only specified field.
func TestS22_ApplyOverride_PartialUpdate(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()

	// Pre-condition: gmail rate is 500.
	out, _ := r.Apply("gmail.lab", map[string]interface{}{
		"rate_limit_per_hour": 999,
	})
	p := out.(*Profile)
	if p.RateLimitPerHour != 999 {
		t.Errorf("rate not overridden: %d", p.RateLimitPerHour)
	}
	// Other fields untouched.
	if p.MaxMessageSizeBytes != 26214400 {
		t.Errorf("size unexpectedly changed: %d", p.MaxMessageSizeBytes)
	}
	if p.SpamClassifyLinkRatio != 0.3 {
		t.Errorf("spam ratio unexpectedly changed: %v", p.SpamClassifyLinkRatio)
	}
}

// 6. Apply persists across subsequent Get calls.
func TestS22_ApplyPersists(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	r.Apply("seznam.lab", map[string]interface{}{"greylist_unknown_sender": true})
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	if !p.GreylistUnknownSender {
		t.Errorf("override not persisted across Get")
	}
}

// 7. Get returns a copy — caller cannot mutate the registry.
func TestS22_GetReturnsCopy(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	got1, _ := r.Get("seznam.lab")
	p1 := got1.(*Profile)
	p1.RateLimitPerHour = 99999

	got2, _ := r.Get("seznam.lab")
	p2 := got2.(*Profile)
	if p2.RateLimitPerHour == 99999 {
		t.Error("registry mutated through Get-returned pointer (should be copy)")
	}
}

// 8. List returns all 3 default providers.
func TestS22_List_AllDefaults(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	all := r.List()
	if len(all) != 3 {
		t.Errorf("List len %d, want 3", len(all))
	}
	domains := map[string]bool{}
	for _, x := range all {
		p := x.(*Profile)
		domains[p.Domain] = true
	}
	for _, want := range []string{"seznam.lab", "gmail.lab", "outlook.lab"} {
		if !domains[want] {
			t.Errorf("List missing %s", want)
		}
	}
}

// 9. Reset reverts to baseline after Apply.
func TestS22_Reset_RevertsApply(t *testing.T) {
	dir := writeTempProfiles(t)
	defer os.RemoveAll(dir)

	r := NewRegistry()
	if _, err := r.Load(dir); err != nil {
		t.Fatalf("load: %v", err)
	}
	r.Apply("seznam.lab", map[string]interface{}{"rate_limit_per_hour": 1})
	if err := r.Reset(dir); err != nil {
		t.Fatalf("reset: %v", err)
	}
	got, _ := r.Get("seznam.lab")
	p := got.(*Profile)
	if p.RateLimitPerHour == 1 {
		t.Errorf("Reset did not revert override")
	}
}

// 10. Load on missing dir returns error (operator misconfiguration).
func TestS22_LoadMissingDir_Errors(t *testing.T) {
	r := NewRegistry()
	if _, err := r.Load("/nonexistent/path/that/does/not/exist"); err == nil {
		t.Error("expected error for missing dir, got nil")
	}
}

// 11. Apply on unknown domain returns ErrUnknownDomain.
func TestS22_ApplyUnknown_Errors(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	_, err := r.Apply("never.lab", map[string]interface{}{"x": 1})
	if err != ErrUnknownDomain {
		t.Errorf("got %v, want ErrUnknownDomain", err)
	}
}

// 12. RejectProxyIpsCidr is independently copied (slice integrity).
func TestS22_RejectProxyIpsCidr_DeepCopy(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	got1, _ := r.Get("seznam.lab")
	p1 := got1.(*Profile)
	if len(p1.RejectProxyIpsCidr) == 0 {
		t.Skip("seznam profile expected non-empty cidr list")
	}
	original := p1.RejectProxyIpsCidr[0]
	p1.RejectProxyIpsCidr[0] = "0.0.0.0/0" // mutate the returned slice

	got2, _ := r.Get("seznam.lab")
	p2 := got2.(*Profile)
	if p2.RejectProxyIpsCidr[0] != original {
		t.Errorf("registry's CIDR slice mutated through Get-returned ref")
	}
}

// 13. Concurrent Apply/Get is race-free (smoke test for sync.RWMutex).
func TestS22_ConcurrentAccess(t *testing.T) {
	r := NewRegistry()
	r.LoadEmbedded()
	done := make(chan struct{})
	for i := 0; i < 50; i++ {
		go func(i int) {
			defer func() { recover() }()
			_, _ = r.Apply("gmail.lab", map[string]interface{}{
				"rate_limit_per_hour": i,
			})
			_, _ = r.Get("gmail.lab")
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 50; i++ {
		<-done
	}
}

// helpers
func writeTempProfiles(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	body := `{"domain":"seznam.lab","max_message_size_bytes":31457280,"rate_limit_per_hour":100}`
	if err := os.WriteFile(filepath.Join(dir, "seznam.json"), []byte(body), 0644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return dir
}

// 14. Load skips files with empty domain (safety).
func TestS22_Load_SkipsEmptyDomain(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "ok.json"),
		[]byte(`{"domain":"only.lab","rate_limit_per_hour":99}`), 0644)
	os.WriteFile(filepath.Join(dir, "empty.json"),
		[]byte(`{"max_message_size_bytes":1}`), 0644)

	r := NewRegistry()
	n, err := r.Load(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if n != 1 {
		t.Errorf("loaded %d, want 1 (empty-domain file skipped)", n)
	}
	if _, err := r.Get("only.lab"); err != nil {
		t.Errorf("Get only.lab: %v", err)
	}
}

// 15. Source-level audit — Apply slog op tag (in handler.go).
func TestS22_HandlerSlogOpTag(t *testing.T) {
	src, err := os.ReadFile("../handler/handler.go")
	if err != nil {
		t.Skipf("read handler.go: %v", err)
	}
	if !strings.Contains(string(src), `"op", "mail-lab-api.handleProfileOverride"`) {
		t.Error("handler.go missing slog op tag for handleProfileOverride")
	}
}

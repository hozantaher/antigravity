package enrich

import (
	"testing"
)

// ══════════════════════════════════════════
//  E2E: Full Enrichment Pipeline
// ══════════════════════════════════════════

func TestE2E_EnrichPipeline_ValidMachineryContact(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery", "metalwork"},
		MinTargetingScore:  0.2,
	})

	raw := RawContact{
		Email:       "jan.novak@firma.cz",
		Name:        "Ing. Jan Novák",
		ICO:         "12345678",
		Phone:       "+420773123456",
		Website:     "https://firma.cz",
		Region:      "Praha",
		CompanySize: "25 - 49 zaměstnanců",
		LegalForm:   "s.r.o.",
		Description: "Výroba strojů, CNC obráběním, fréz a soustruhů pro průmysl.",
		FirmyCzID:   5000,
	}

	enriched, reason := pipeline.Enrich(raw)

	if enriched == nil {
		t.Fatalf("expected enriched contact, got nil (reason: %s)", reason)
	}
	if reason != "" {
		t.Errorf("expected empty reason, got %q", reason)
	}

	// Email processing
	if enriched.Email != "jan.novak@firma.cz" {
		t.Errorf("email: %s", enriched.Email)
	}
	if enriched.EmailHash == "" {
		t.Error("email hash should be set")
	}

	// Domain classification
	if enriched.Domain != "firma.cz" {
		t.Errorf("domain: %s", enriched.Domain)
	}
	if enriched.DomainType != DomainCorporate {
		t.Errorf("domain type: %s, want corporate", enriched.DomainType)
	}

	// First name extraction
	if enriched.FirstName != "Jan" {
		t.Errorf("first name: %q, want 'Jan'", enriched.FirstName)
	}

	// Industry classification
	if len(enriched.IndustryTags) == 0 {
		t.Fatal("expected industry tags from machinery description")
	}
	hasMachinery := false
	for _, tag := range enriched.IndustryTags {
		if tag == "machinery" {
			hasMachinery = true
		}
	}
	if !hasMachinery {
		t.Errorf("expected 'machinery' tag, got %v", enriched.IndustryTags)
	}
	if enriched.IndustryConfidence < 0.1 {
		t.Errorf("confidence too low: %f", enriched.IndustryConfidence)
	}

	// Consent score — should be high for machinery company
	// base 0.5 + industry ~0.24 + corporate 0.1 + company size 0.2 = ~1.0 (clamped)
	if enriched.TargetingScore < 0.7 {
		t.Errorf("targeting score too low for ideal target: %f", enriched.TargetingScore)
	}

	// Source tracking
	if enriched.Source != "firmy-cz" {
		t.Errorf("source: %s", enriched.Source)
	}
	if enriched.FirmyCzID != 5000 {
		t.Errorf("firmy_cz_id: %d", enriched.FirmyCzID)
	}

	// No honeypot signals
	if len(enriched.HoneypotSignals) != 0 {
		t.Errorf("clean email should have 0 honeypot signals, got %d", len(enriched.HoneypotSignals))
	}
}

func TestE2E_EnrichPipeline_FreemailLowScore(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.2,
	})

	raw := RawContact{
		Email:       "random.osoba@seznam.cz",
		Name:        "Právní poradenství Brno",
		Description: "Nabízíme právní poradenství a účetní služby.",
	}

	enriched, _ := pipeline.Enrich(raw)

	if enriched == nil {
		t.Fatal("should still enrich (above 0.2 threshold)")
	}

	// Freemail penalty
	if enriched.DomainType != DomainFreemail {
		t.Errorf("domain type: %s, want freemail", enriched.DomainType)
	}

	// No industry match
	if len(enriched.IndustryTags) != 0 {
		t.Errorf("legal/accounting should not match machinery tags: %v", enriched.IndustryTags)
	}

	// Lower score than corporate machinery
	if enriched.TargetingScore > 0.6 {
		t.Errorf("freemail + no industry = should be lower score: %f", enriched.TargetingScore)
	}
}

func TestE2E_EnrichPipeline_RoleBasedEmail(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
	})

	raw := RawContact{
		Email:       "noreply@firma.cz",
		Name:        "Firma s.r.o.",
		Description: "Strojírenská výroba",
	}

	enriched, _ := pipeline.Enrich(raw)
	if enriched == nil {
		t.Fatal("should enrich despite role-based (low threshold)")
	}

	// Should have honeypot signal for role-based
	hasRoleBased := false
	for _, s := range enriched.HoneypotSignals {
		if s.Type == "role_based" {
			hasRoleBased = true
		}
	}
	if !hasRoleBased {
		t.Error("should detect role-based email")
	}
}

func TestE2E_EnrichPipeline_TypoDomainFix(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.1,
	})

	raw := RawContact{
		Email:       "user@gmial.com",
		Name:        "Test",
		Description: "Výroba strojů",
	}

	enriched, _ := pipeline.Enrich(raw)
	if enriched == nil {
		t.Fatal("should enrich with corrected domain")
	}

	// Domain should be corrected
	if enriched.Email != "user@gmail.com" {
		t.Errorf("email should be corrected: %s", enriched.Email)
	}
	if enriched.Domain != "gmail.com" {
		t.Errorf("domain should be gmail.com: %s", enriched.Domain)
	}
}

func TestE2E_EnrichPipeline_NoEmail(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{MinTargetingScore: 0.1})
	enriched, reason := pipeline.Enrich(RawContact{Name: "No Email Corp"})

	if enriched != nil {
		t.Error("should skip contact without email")
	}
	if reason != "no_email" {
		t.Errorf("reason: %s, want no_email", reason)
	}
}

func TestE2E_EnrichPipeline_BelowThreshold(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.9, // very high threshold
	})

	raw := RawContact{
		Email:       "someone@seznam.cz",
		Name:        "Random",
		Description: "Kadeřnictví a kosmetika",
	}

	enriched, reason := pipeline.Enrich(raw)
	if enriched != nil {
		t.Errorf("should be below 0.9 threshold, got score that passed")
	}
	if reason != "below_threshold" {
		t.Errorf("reason: %s, want below_threshold", reason)
	}
}

func TestE2E_EnrichPipeline_DescriptionSnippet(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{MinTargetingScore: 0.1})

	longDesc := ""
	for i := 0; i < 100; i++ {
		longDesc += "Dlouhý popis firmy. "
	}

	raw := RawContact{Email: "a@b.cz", Name: "X", Description: longDesc}
	enriched, _ := pipeline.Enrich(raw)
	if enriched == nil {
		t.Fatal("should enrich")
	}
	if len(enriched.DescriptionSnippet) > 500 {
		t.Errorf("snippet should be max 500 chars, got %d", len(enriched.DescriptionSnippet))
	}
}

func TestE2E_EnrichPipeline_MultipleIndustries(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery", "construction"},
		MinTargetingScore:  0.1,
	})

	raw := RawContact{
		Email:       "info@stavebniny-stroje.cz",
		Name:        "StavStroj s.r.o.",
		Description: "Prodej stavebních strojů, bagry, buldozery, CNC soustruhy a frézky. Stavební materiál a izolace.",
	}

	enriched, _ := pipeline.Enrich(raw)
	if enriched == nil {
		t.Fatal("should enrich")
	}
	if len(enriched.IndustryTags) < 2 {
		t.Errorf("expected 2+ industry tags for multi-industry desc, got %v", enriched.IndustryTags)
	}
}

func TestE2E_EnrichPipeline_GovDomainHardBlocked(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.01,
	})

	raw := RawContact{
		Email:       "info@mzp.gov.cz",
		Name:        "Ministerstvo",
		Description: "Strojírenská výroba",
	}

	enriched, reason := pipeline.Enrich(raw)
	if enriched != nil {
		t.Fatal("gov domain with ministry name should be hard-blocked by exclusion")
	}
	if reason != "exclusion_hard_block" {
		t.Errorf("reason should be exclusion_hard_block, got %s", reason)
	}
}

func TestE2E_EnrichPipeline_CommercialPassesExclusion(t *testing.T) {
	pipeline := NewPipeline(PipelineConfig{
		TargetIndustries: []string{"machinery"},
		MinTargetingScore:  0.01,
	})

	raw := RawContact{
		Email:       "info@firma.cz",
		Name:        "Městské lesy s.r.o.",
		LegalForm:   "Společnost s ručením omezeným",
		Description: "Strojírenská výroba",
	}

	enriched, _ := pipeline.Enrich(raw)
	if enriched == nil {
		t.Fatal("commercial entity should pass exclusion regardless of name")
	}
}

// ── Helper assertions ──

func TestE2E_HashEmail_Consistency(t *testing.T) {
	h1 := hashEmail("TEST@FIRMA.CZ")
	h2 := hashEmail("test@firma.cz")
	h3 := hashEmail("  test@firma.cz  ")
	if h1 != h2 || h2 != h3 {
		t.Error("hashEmail should normalize case and whitespace")
	}
}

func TestE2E_PgArray(t *testing.T) {
	tests := []struct {
		in   []string
		want string
	}{
		{nil, "{}"},
		{[]string{}, "{}"},
		{[]string{"a"}, "{a}"},
		{[]string{"a", "b", "c"}, "{a,b,c}"},
	}
	for _, tt := range tests {
		if got := pgArray(tt.in); got != tt.want {
			t.Errorf("pgArray(%v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestE2E_ExtractFirstName(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{"Ing. Jan Novák", "Jan"},
		{"Mgr. Marie Dvořáková", "Marie"},
		{"Jan Novák", "Jan"},
		{"BIONA s.r.o.", ""},
		{"TEMA Klášterec", ""},
		{"prof. doc. Petr Svoboda", "Petr"},
		{"A", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := extractFirstName(tt.name); got != tt.want {
			t.Errorf("extractFirstName(%q) = %q, want %q", tt.name, got, tt.want)
		}
	}
}

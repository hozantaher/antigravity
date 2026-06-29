package enrichment

import (
	"reflect"
	"testing"
)

// TestMerge covers the per-field authority matrix from the KT-A9 design doc.
// At least 10 cases per the project's `feedback_extreme_testing` rule.
func TestMerge(t *testing.T) {
	tests := []struct {
		name             string
		payloads         []SourcePayload
		wantICO          string
		wantName         string
		wantPravniForma  string
		wantStreet       string
		wantPostalCode   string
		wantEmail        string
		wantPhone        string
		wantWebsite      string
		wantVelikost     string
		wantDescription  string
		wantNACEPrimary  string
		wantNACECodes    []string
		wantConflictsLen int
		wantOutcome      EnrichmentOutcome
	}{
		{
			name:        "all sources empty → outcome none",
			payloads:    []SourcePayload{},
			wantOutcome: OutcomeNone,
		},
		{
			name: "ares only — no conflicts, ares_only outcome",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:           "12345678",
					Name:          "Stavby Novák s.r.o.",
					PravniForma:   "112",
					StreetAddress: "Hlavní 1",
					City:          "Praha",
					PostalCode:    "11000",
					NACEPrimary:   "41.20",
					NACECodes:     []string{"41.20", "43.99"},
				}},
			},
			wantICO:          "12345678",
			wantName:         "Stavby Novák s.r.o.",
			wantPravniForma:  "112",
			wantStreet:       "Hlavní 1",
			wantPostalCode:   "11000",
			wantNACEPrimary:  "41.20",
			wantNACECodes:    []string{"41.20", "43.99"},
			wantConflictsLen: 0,
			wantOutcome:      OutcomeARESOnly,
		},
		{
			name: "firmy.cz only — fills email + phone, firmy_cz_only outcome",
			payloads: []SourcePayload{
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:     "87654321",
					Name:    "Agro Health",
					Email:   "info@agrohealth.cz",
					Phone:   "+420 777 111 222",
					Website: "https://agrohealth.cz",
				}},
			},
			wantICO:          "87654321",
			wantName:         "Agro Health",
			wantEmail:        "info@agrohealth.cz",
			wantPhone:        "+420 777 111 222",
			wantWebsite:      "https://agrohealth.cz",
			wantConflictsLen: 0,
			wantOutcome:      OutcomeFirmyOnly,
		},
		{
			name: "ares + firmy.cz no conflicts — merged outcome, ares fills registry, firmy fills contact",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:           "11111111",
					Name:          "Heavy Iron a.s.",
					PravniForma:   "121",
					StreetAddress: "Průmyslová 5",
					City:          "Brno",
					PostalCode:    "60200",
					NACEPrimary:   "28.92",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:     "11111111",
					Email:   "obchod@heavyiron.cz",
					Phone:   "+420 555 000 111",
					Website: "https://heavyiron.cz",
				}},
			},
			wantICO:          "11111111",
			wantName:         "Heavy Iron a.s.",
			wantPravniForma:  "121",
			wantStreet:       "Průmyslová 5",
			wantPostalCode:   "60200",
			wantEmail:        "obchod@heavyiron.cz",
			wantPhone:        "+420 555 000 111",
			wantWebsite:      "https://heavyiron.cz",
			wantNACEPrimary:  "28.92",
			wantConflictsLen: 0,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "ares + firmy.cz with pravni_forma conflict — ARES wins, conflict logged",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:         "22222222",
					Name:        "Test s.r.o.",
					PravniForma: "112",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:         "22222222",
					Name:        "Test s.r.o.",
					PravniForma: "Společnost s ručením omezeným",
					Email:       "kontakt@test.cz",
				}},
			},
			wantICO:          "22222222",
			wantName:         "Test s.r.o.",
			wantPravniForma:  "112",
			wantEmail:        "kontakt@test.cz",
			wantConflictsLen: 1,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "postal_code conflict — ARES authoritative",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:        "33333333",
					Name:       "Foo",
					PostalCode: "110 00",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:        "33333333",
					PostalCode: "11000",
				}},
			},
			wantICO:          "33333333",
			wantName:         "Foo",
			wantPostalCode:   "110 00",
			wantConflictsLen: 1,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "name conflict — ARES authoritative (registry wins)",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:  "44444444",
					Name: "AGRO HEALTH a.s.",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:  "44444444",
					Name: "Agro Health",
				}},
			},
			wantICO:          "44444444",
			wantName:         "AGRO HEALTH a.s.",
			wantConflictsLen: 1,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "ARES empty name + firmy non-empty → no conflict, firmy fills",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:         "55555555",
					PravniForma: "112",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:  "55555555",
					Name: "Záložní jméno",
				}},
			},
			wantICO:          "55555555",
			wantName:         "Záložní jméno",
			wantPravniForma:  "112",
			wantConflictsLen: 0,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "NACE codes union-merged unique",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:         "66666666",
					NACECodes:   []string{"41.20", "43.99"},
					NACEPrimary: "41.20",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:       "66666666",
					NACECodes: []string{"43.99", "47.30"},
				}},
			},
			wantICO:          "66666666",
			wantNACEPrimary:  "41.20",
			wantNACECodes:    []string{"41.20", "43.99", "47.30"},
			wantConflictsLen: 0,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "email conflict — firmy.cz authoritative (kontakty)",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:   "77777777",
					Email: "ares-mistakenly@example.cz",
					Name:  "Foo",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:   "77777777",
					Email: "real@example.cz",
				}},
			},
			wantICO:          "77777777",
			wantName:         "Foo",
			wantEmail:        "real@example.cz",
			wantConflictsLen: 1,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "justice.cz fallback when both primaries empty",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: nil},
				{Source: SourceFirmyCZ, Data: nil},
				{Source: SourceJusticeCZ, Data: &CompanyData{
					ICO:         "88888888",
					Name:        "Justice Match",
					PravniForma: "112",
				}},
			},
			wantICO:          "88888888",
			wantName:         "Justice Match",
			wantPravniForma:  "112",
			wantConflictsLen: 0,
			wantOutcome:      OutcomeJusticeFallback,
		},
		{
			name: "agreement on field — no conflict logged",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:        "99999999",
					Name:       "Stejné jméno",
					PostalCode: "11000",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:        "99999999",
					Name:       "Stejné jméno",
					PostalCode: "11000",
					Email:      "x@y.cz",
				}},
			},
			wantICO:          "99999999",
			wantName:         "Stejné jméno",
			wantPostalCode:   "11000",
			wantEmail:        "x@y.cz",
			wantConflictsLen: 0,
			wantOutcome:      OutcomeMerged,
		},
		{
			name: "all-empty payloads → none outcome",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{}},
				{Source: SourceFirmyCZ, Data: &CompanyData{}},
			},
			wantOutcome: OutcomeNone,
		},
		{
			name: "ARES-only sídlo + firmy-only kontakt — no conflict, both populated",
			payloads: []SourcePayload{
				{Source: SourceARES, Data: &CompanyData{
					ICO:           "10101010",
					Name:          "X",
					StreetAddress: "Ulice 1",
					City:          "Praha",
					PostalCode:    "11000",
				}},
				{Source: SourceFirmyCZ, Data: &CompanyData{
					ICO:           "10101010",
					Email:         "kontakt@x.cz",
					Phone:         "111",
					Website:       "https://x.cz",
					VelikostFirmy: "10-19",
					Description:   "Stavební firma",
				}},
			},
			wantICO:          "10101010",
			wantName:         "X",
			wantStreet:       "Ulice 1",
			wantPostalCode:   "11000",
			wantEmail:        "kontakt@x.cz",
			wantPhone:        "111",
			wantWebsite:      "https://x.cz",
			wantVelikost:     "10-19",
			wantDescription:  "Stavební firma",
			wantConflictsLen: 0,
			wantOutcome:      OutcomeMerged,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, conflicts, outcome := Merge(tt.payloads)

			if got.ICO != tt.wantICO {
				t.Errorf("ICO = %q want %q", got.ICO, tt.wantICO)
			}
			if got.Name != tt.wantName {
				t.Errorf("Name = %q want %q", got.Name, tt.wantName)
			}
			if got.PravniForma != tt.wantPravniForma {
				t.Errorf("PravniForma = %q want %q", got.PravniForma, tt.wantPravniForma)
			}
			if got.StreetAddress != tt.wantStreet {
				t.Errorf("StreetAddress = %q want %q", got.StreetAddress, tt.wantStreet)
			}
			if got.PostalCode != tt.wantPostalCode {
				t.Errorf("PostalCode = %q want %q", got.PostalCode, tt.wantPostalCode)
			}
			if got.Email != tt.wantEmail {
				t.Errorf("Email = %q want %q", got.Email, tt.wantEmail)
			}
			if got.Phone != tt.wantPhone {
				t.Errorf("Phone = %q want %q", got.Phone, tt.wantPhone)
			}
			if got.Website != tt.wantWebsite {
				t.Errorf("Website = %q want %q", got.Website, tt.wantWebsite)
			}
			if got.VelikostFirmy != tt.wantVelikost {
				t.Errorf("VelikostFirmy = %q want %q", got.VelikostFirmy, tt.wantVelikost)
			}
			if got.Description != tt.wantDescription {
				t.Errorf("Description = %q want %q", got.Description, tt.wantDescription)
			}
			if got.NACEPrimary != tt.wantNACEPrimary {
				t.Errorf("NACEPrimary = %q want %q", got.NACEPrimary, tt.wantNACEPrimary)
			}
			if tt.wantNACECodes != nil && !reflect.DeepEqual(got.NACECodes, tt.wantNACECodes) {
				t.Errorf("NACECodes = %v want %v", got.NACECodes, tt.wantNACECodes)
			}
			if len(conflicts) != tt.wantConflictsLen {
				t.Errorf("conflicts len = %d want %d (got %+v)", len(conflicts), tt.wantConflictsLen, conflicts)
			}
			if outcome != tt.wantOutcome {
				t.Errorf("outcome = %q want %q", outcome, tt.wantOutcome)
			}
		})
	}
}

func TestMergeConflictResolutionAuthority(t *testing.T) {
	// For each declared field, verify that when ARES + firmy.cz disagree,
	// the authoritative source value is the one returned.
	cases := []struct {
		field   string
		set     func(d *CompanyData, v string)
		ares    string
		firmy   string
		expect  string
		wantSrc SourceName
	}{
		{"ico", func(d *CompanyData, v string) { d.ICO = v }, "1", "2", "1", SourceARES},
		{"name", func(d *CompanyData, v string) { d.Name = v }, "Areski", "Firmy", "Areski", SourceARES},
		{"pravni_forma", func(d *CompanyData, v string) { d.PravniForma = v }, "112", "Sro", "112", SourceARES},
		{"datum_vzniku", func(d *CompanyData, v string) { d.DatumVzniku = v }, "2003-08-26", "2003", "2003-08-26", SourceARES},
		{"street_address", func(d *CompanyData, v string) { d.StreetAddress = v }, "Hlavní 1", "Hlavni 1", "Hlavní 1", SourceARES},
		{"city", func(d *CompanyData, v string) { d.City = v }, "Praha", "Prague", "Praha", SourceARES},
		{"postal_code", func(d *CompanyData, v string) { d.PostalCode = v }, "110 00", "11000", "110 00", SourceARES},
		{"email", func(d *CompanyData, v string) { d.Email = v }, "old@x.cz", "new@x.cz", "new@x.cz", SourceFirmyCZ},
		{"phone", func(d *CompanyData, v string) { d.Phone = v }, "111", "222", "222", SourceFirmyCZ},
		{"website", func(d *CompanyData, v string) { d.Website = v }, "http://a", "https://a", "https://a", SourceFirmyCZ},
		{"velikost_firmy", func(d *CompanyData, v string) { d.VelikostFirmy = v }, "10", "10-19", "10-19", SourceFirmyCZ},
		{"description", func(d *CompanyData, v string) { d.Description = v }, "ARES popis", "Firmy popis", "Firmy popis", SourceFirmyCZ},
	}

	for _, c := range cases {
		t.Run(c.field, func(t *testing.T) {
			ares := &CompanyData{ICO: "X"}
			firmy := &CompanyData{ICO: "X"}
			c.set(ares, c.ares)
			c.set(firmy, c.firmy)

			_, conflicts, _ := Merge([]SourcePayload{
				{Source: SourceARES, Data: ares},
				{Source: SourceFirmyCZ, Data: firmy},
			})

			if len(conflicts) != 1 {
				t.Fatalf("expected exactly one conflict for %s, got %d (%+v)", c.field, len(conflicts), conflicts)
			}
			if conflicts[0].Field != c.field {
				t.Errorf("conflict field = %q want %q", conflicts[0].Field, c.field)
			}
			if conflicts[0].Resolved != c.wantSrc {
				t.Errorf("resolved source = %q want %q", conflicts[0].Resolved, c.wantSrc)
			}
		})
	}
}

func TestCompanyDataIsEmpty(t *testing.T) {
	tests := []struct {
		name string
		data *CompanyData
		want bool
	}{
		{"nil pointer", nil, true},
		{"zero value", &CompanyData{}, true},
		{"only ICO", &CompanyData{ICO: "1"}, false},
		{"only NACE codes", &CompanyData{NACECodes: []string{"x"}}, false},
		{"only email", &CompanyData{Email: "e"}, false},
		{"populated", &CompanyData{ICO: "1", Name: "n"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.data.IsEmpty(); got != tt.want {
				t.Errorf("IsEmpty() = %v want %v", got, tt.want)
			}
		})
	}
}

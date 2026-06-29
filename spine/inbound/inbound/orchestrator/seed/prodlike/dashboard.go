package prodlike

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// DashboardResult captures counts inserted by SeedDashboard.
type DashboardResult struct {
	Categories   int
	Personas     int
	Segments     int
	FeatureFlags int
	Users        int
}

// SeedDashboard populates the tables the Nuxt dashboard reads for
// navigation, filtering and multi-mailbox operation: categories
// hierarchy, personas, segments, feature_flags, and non-admin users.
//
// All rows are tagged so ClearProdLike removes them. Idempotent: a
// second call does nothing because of ON CONFLICT clauses.
func SeedDashboard(ctx context.Context, db *sql.DB) (*DashboardResult, error) {
	res := &DashboardResult{}
	now := time.Now().UTC()

	// --- Categories ----------------------------------------------------
	// Synthetic slice of the real firmy.cz hierarchy. Uses public
	// taxonomy, not real company data. Ordered parents-first so the
	// parent_path column resolves cleanly.
	cats := dashboardCategories()
	for _, c := range cats {
		depth := strings.Count(c.Path, " > ")
		parentPath := ""
		if depth > 0 {
			parentPath = c.Path[:strings.LastIndex(c.Path, " > ")]
		}
		_, err := db.ExecContext(ctx, `
			INSERT INTO categories (path, slug, name, parent_path, depth, company_count)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (path) DO UPDATE SET
				company_count = EXCLUDED.company_count, updated_at = now()`,
			c.Path, c.Slug, c.Name, nullableString(parentPath), depth, c.Count,
		)
		if err != nil {
			return res, fmt.Errorf("insert category %q: %w", c.Path, err)
		}
		res.Categories++
	}

	// --- Personas ------------------------------------------------------
	personas := []struct {
		Mailbox, Name, Role, Company, Region, Tone, Bio string
		Active                                          bool
	}{
		{"jan.novak@outreach.test", "Jan Novák", "Sales Director", "Stroje s.r.o.", "Praha", "professional", "20 let v odvětví strojírenství.", true},
		{"petra.vesela@outreach.test", "Petra Veselá", "Account Manager", "Stroje s.r.o.", "Brno", "friendly", "Specializuje se na agri segmenty.", true},
		{"marek.horak@outreach.test", "Marek Horák", "Business Developer", "Stroje s.r.o.", "Ostrava", "direct", "Pracoval v banking před přechodem do B2B sales.", true},
		{"tomas.benes@outreach.test", "Tomáš Beneš", "(inactive)", "Stroje s.r.o.", "Plzeň", "professional", "Odchod do důchodu.", false},
	}
	for _, p := range personas {
		_, err := db.ExecContext(ctx, `
			INSERT INTO personas (mailbox, name, role, company, region, tone, bio, active)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (mailbox) DO UPDATE SET
				name=EXCLUDED.name, active=EXCLUDED.active, updated_at=now()`,
			p.Mailbox, p.Name, p.Role, p.Company, p.Region, p.Tone, p.Bio, p.Active,
		)
		if err != nil {
			return res, fmt.Errorf("insert persona %q: %w", p.Mailbox, err)
		}
		res.Personas++
	}

	// --- Segments ------------------------------------------------------
	segments := []struct {
		Name, Description string
		Query             map[string]any
		Count             int
		LastBuilt         time.Time
	}{
		{
			Name:        "ICP: High-tier strojírenství",
			Description: "Firmy s ICP skóre ≥ 0.65 a sector=machinery",
			Query:       map[string]any{"icp_score": map[string]any{"gte": 0.65}, "sector_primary": "machinery"},
			Count:       82,
			LastBuilt:   now.Add(-24 * time.Hour),
		},
		{
			Name:        "Geografický: Praha metropole",
			Description: "Firmy v Praze a jejích čtvrtích",
			Query:       map[string]any{"region": "Praha"},
			Count:       153,
			LastBuilt:   now.Add(-12 * time.Hour),
		},
		{
			Name:        "Sektor: construction ∪ metalwork",
			Description: "Stavební a kovovýroba",
			Query:       map[string]any{"sector_primary": []string{"construction", "metalwork"}},
			Count:       291,
			LastBuilt:   now.Add(-6 * time.Hour),
		},
		{
			Name:        "Prázdný segment (draft)",
			Description: "Práce v progresu",
			Query:       map[string]any{},
			Count:       0,
			LastBuilt:   time.Time{}, // never built
		},
		{
			Name:        "Kombinovaný: ICP + Brno",
			Description: "Brněnské firmy s vysokým ICP",
			Query:       map[string]any{"icp_score": map[string]any{"gte": 0.5}, "region": "Brno"},
			Count:       47,
			LastBuilt:   now.Add(-48 * time.Hour),
		},
	}
	for _, s := range segments {
		qBytes, _ := json.Marshal(s.Query)
		var lastBuilt any
		if !s.LastBuilt.IsZero() {
			lastBuilt = s.LastBuilt
		}
		_, err := db.ExecContext(ctx, `
			INSERT INTO segments (name, description, query, company_count, last_built_at)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (name) DO UPDATE SET
				description=EXCLUDED.description, query=EXCLUDED.query,
				company_count=EXCLUDED.company_count, last_built_at=EXCLUDED.last_built_at,
				updated_at=now()`,
			s.Name, s.Description, qBytes, s.Count, lastBuilt,
		)
		if err != nil {
			return res, fmt.Errorf("insert segment %q: %w", s.Name, err)
		}
		res.Segments++
	}

	// --- Feature flags ------------------------------------------------
	flags := []struct {
		Key         string
		Enabled     bool
		Description string
	}{
		{"ui.dashboard.new_widgets", true, "New analytics widgets on /index"},
		{"ui.inbox.bulk_actions", true, "Bulk close / reclassify on /inbox"},
		{"ui.campaigns.wizard_v2", false, "Campaign wizard v2 (WIP)"},
		{"ui.segments.advanced_query", false, "Advanced segment query builder"},
		{"intel.ollama_classification", true, "LLM reply classification via Ollama"},
		{"intel.auto_suppress_bounces", true, "Auto-suppress domain on bounce_rate > 10%"},
		{"intel.domain_health_daily", true, "Daily domain-health MX recheck"},
		{"campaigns.humanize_enabled", true, "Seznam.cz humanize fingerprint"},
		{"campaigns.calendar_check", true, "Skip sends on Czech holidays"},
		{"experimental.multi_tenant", false, "Multi-tenant isolation (alpha)"},
	}
	for _, f := range flags {
		_, err := db.ExecContext(ctx, `
			INSERT INTO feature_flags (key, enabled, description)
			VALUES ($1, $2, $3)
			ON CONFLICT (key) DO UPDATE SET
				enabled=EXCLUDED.enabled, description=EXCLUDED.description, updated_at=now()`,
			f.Key, f.Enabled, f.Description,
		)
		if err != nil {
			return res, fmt.Errorf("insert feature_flag %q: %w", f.Key, err)
		}
		res.FeatureFlags++
	}

	// --- Users --------------------------------------------------------
	// Dashboard needs a mix of operator roles (not just the bootstrap
	// admin). Password hash is a static bcrypt('prodlike-test-2026')
	// value so reset-free testing is possible.
	//
	// We never overwrite existing admin users.
	const testPasswordHash = "$2a$10$abcdefghijklmnopqrstuuGwH9eg0cVsa9Pvb7yv/h1Qx4DkXkrR.K" // bcrypt placeholder
	users := []struct {
		Email      string
		Role       string
		Disabled   bool
	}{
		{"operator1@prodlike.test", "operator", false},
		{"operator2@prodlike.test", "operator", false},
		{"viewer@prodlike.test", "viewer", false},
		{"disabled-user@prodlike.test", "operator", true},
	}
	for _, u := range users {
		var disabledAt any
		if u.Disabled {
			disabledAt = now.Add(-14 * 24 * time.Hour)
		}
		_, err := db.ExecContext(ctx, `
			INSERT INTO users (email, password_hash, role, disabled_at)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (email) DO NOTHING`,
			u.Email, testPasswordHash, u.Role, disabledAt,
		)
		if err != nil {
			return res, fmt.Errorf("insert user %q: %w", u.Email, err)
		}
		res.Users++
	}

	return res, nil
}

// categoryDraft is a minimal struct for the hard-coded hierarchy.
type categoryDraft struct {
	Path, Slug, Name string
	Count            int
}

// dashboardCategories returns a 50+ node hierarchy based on the public
// firmy.cz taxonomy. Parent nodes come before their children — the
// insertion order matters for the parent_path FK semantics.
func dashboardCategories() []categoryDraft {
	return []categoryDraft{
		// Level 0 (top-level)
		{"Remesla-a-sluzby", "remesla-a-sluzby", "Řemesla a služby", 321752},
		{"Obchody-a-obchudky", "obchody-a-obchudky", "Obchody a obchůdky", 165615},
		{"Cestovni-sluzby", "cestovni-sluzby", "Cestovní služby", 92340},
		{"Prvni-pomoc-a-zdravotnictvi", "prvni-pomoc-a-zdravotnictvi", "První pomoc a zdravotnictví", 68166},
		{"Restauracni-a-pohostinske-sluzby", "restauracni-a-pohostinske-sluzby", "Restaurační a pohostinské služby", 66277},
		{"Instituce-a-urady", "instituce-a-urady", "Instituce a úřady", 53107},
		{"Banky-a-financni-sluzby", "banky-a-financni-sluzby", "Banky a finanční služby", 45791},
		{"Auto-moto", "auto-moto", "Auto-moto", 44332},
		{"Velkoobchod-a-vyroba", "velkoobchod-a-vyroba", "Velkoobchod a výroba", 43846},
		{"Vse-pro-firmy", "vse-pro-firmy", "Vše pro firmy", 36977},
		{"Elektro-mobily-a-pocitace", "elektro-mobily-a-pocitace", "Elektro, mobily a počítače", 16929},
		{"Dum-byt-a-zahrada", "dum-byt-a-zahrada", "Dům, byt a zahrada", 7386},

		// Level 1 under Remesla-a-sluzby
		{"Remesla-a-sluzby > Stavebni-sluzby", "remesla-a-sluzby-stavebni-sluzby", "Stavební služby", 40000},
		{"Remesla-a-sluzby > Pravni-sluzby", "remesla-a-sluzby-pravni-sluzby", "Právní služby", 10533},
		{"Remesla-a-sluzby > Reality", "remesla-a-sluzby-reality", "Reality", 10208},
		{"Remesla-a-sluzby > Sportovni-sluzby", "remesla-a-sluzby-sportovni-sluzby", "Sportovní služby", 18237},
		{"Remesla-a-sluzby > Sluzby-pece-o-telo", "remesla-a-sluzby-sluzby-pece-o-telo", "Služby péče o tělo", 15224},

		// Level 2 under Stavebni-sluzby
		{"Remesla-a-sluzby > Stavebni-sluzby > Stavebne-remeslne-prace", "stavebne-remeslne-prace", "Stavebně řemeslné práce", 19040},
		{"Remesla-a-sluzby > Stavebni-sluzby > Stavebni-firmy", "stavebni-firmy", "Stavební firmy", 9399},

		// Level 2 under Sportovni-sluzby
		{"Remesla-a-sluzby > Sportovni-sluzby > Sportovni-centra-a-spo", "sportovni-centra", "Sportovní centra", 10957},
		{"Remesla-a-sluzby > Sportovni-sluzby > Sportovni-kluby-a-muzs", "sportovni-kluby", "Sportovní kluby", 7280},

		// Level 2 under Sluzby-pece-o-telo
		{"Remesla-a-sluzby > Sluzby-pece-o-telo > Kadernictvi", "kadernictvi", "Kadeřnictví", 8107},
		{"Remesla-a-sluzby > Sluzby-pece-o-telo > Kosmeticke-salony", "kosmeticke-salony", "Kosmetické salony", 7117},

		// Level 1 under Obchody-a-obchudky
		{"Obchody-a-obchudky > Nakupovani-na-internetu", "nakupovani-internet", "Nakupování na internetu", 56945},
		{"Obchody-a-obchudky > Prodejci-textilu-odevu-a-obuvi", "prodejci-textilu", "Prodejci textilu, oděvů a obuvi", 13877},
		{"Obchody-a-obchudky > Prodejci-potravin", "prodejci-potravin", "Prodejci potravin", 8559},
		{"Obchody-a-obchudky > Prodejci-stavebnin", "prodejci-stavebnin", "Prodejci stavebnin", 8170},

		// Level 2 under Nakupovani-na-internetu
		{"Obchody-a-obchudky > Nakupovani-na-internetu > Online-prodej", "online-prodej", "Online prodej", 39342},
		{"Obchody-a-obchudky > Nakupovani-na-internetu > On-line-prode", "on-line-prodejci", "On-line prodejci", 17603},

		// Level 1 under Cestovni-sluzby
		{"Cestovni-sluzby > Doprava-a-preprava", "doprava-a-preprava", "Doprava a přeprava", 31579},
		{"Cestovni-sluzby > Ubytovaci-sluzby", "ubytovaci-sluzby", "Ubytovací služby", 19016},

		// Level 2 under Doprava-a-preprava
		{"Cestovni-sluzby > Doprava-a-preprava > Postovni-a-dorucovate", "postovni-sluzby", "Poštovní a doručovatelské služby", 22269},
		{"Cestovni-sluzby > Doprava-a-preprava > Nakladni-silnicni-pre", "nakladni-preprava", "Nákladní silniční přeprava", 9310},

		// Level 2 under Ubytovaci-sluzby
		{"Cestovni-sluzby > Ubytovaci-sluzby > Ubytovani-v-bytovych-ap", "ubytovani-apartmany", "Ubytování v bytových apartmánech", 11225},
		{"Cestovni-sluzby > Ubytovaci-sluzby > Penziony", "penziony", "Penziony", 7791},

		// Level 1 under Auto-moto
		{"Auto-moto > Auto-moto-sluzby", "auto-moto-sluzby", "Auto-moto služby", 18000},
		// Level 2
		{"Auto-moto > Auto-moto-sluzby > Autoservisy", "autoservisy", "Autoservisy", 9774},

		// Level 1 under Vse-pro-firmy
		{"Vse-pro-firmy > Sluzby-pro-firmy", "sluzby-pro-firmy", "Služby pro firmy", 30000},
		{"Vse-pro-firmy > Prodejci-vybaveni-a-techniky-pro-firmy", "prodejci-vybaveni", "Prodejci vybavení a techniky pro firmy", 12000},

		// Level 2
		{"Vse-pro-firmy > Sluzby-pro-firmy > Poradenske-sluzby-pro-fir", "poradenske-sluzby", "Poradenské služby pro firmy", 8588},
		{"Vse-pro-firmy > Sluzby-pro-firmy > Reklamni-a-marketingove-s", "reklamni-sluzby", "Reklamní a marketingové služby", 7485},
		{"Vse-pro-firmy > Prodejci-vybaveni-a-techniky-pro-firmy > Pro", "prodejci-prumyslove-techniky", "Prodejci průmyslové techniky", 8647},

		// Level 1 under Prvni-pomoc-a-zdravotnictvi
		{"Prvni-pomoc-a-zdravotnictvi > Zdravotnicke-sluzby", "zdravotnicke-sluzby", "Zdravotnické služby", 58000},
		// Level 2
		{"Prvni-pomoc-a-zdravotnictvi > Zdravotnicke-sluzby > Zdravotn", "zdravotnictvi-praxe", "Zdravotnická praxe", 50551},
		{"Prvni-pomoc-a-zdravotnictvi > Prodejci-zdravotnickeho-zbozi-", "prodejci-zdravotnickeho-zbozi", "Prodejci zdravotnického zboží", 8924},

		// Level 1 under Banky-a-financni-sluzby
		{"Banky-a-financni-sluzby > Bankovni-a-sporitelni-sluzby", "bankovni-sluzby", "Bankovní a spořitelní služby", 10000},
		// Level 2
		{"Banky-a-financni-sluzby > Bankovni-a-sporitelni-sluzby > Ban", "banky-pobocky", "Banky (pobočky)", 9440},

		// Level 1 under Restauracni-a-pohostinske-sluzby
		{"Restauracni-a-pohostinske-sluzby > Restaurace", "restaurace", "Restaurace", 20727},
	}
}

// nullableString returns SQL NULL for empty strings so parent_path
// stays clean for top-level categories.
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

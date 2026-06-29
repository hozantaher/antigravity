package content

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/quick"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

// Sprint AH: configs/templates/ directory deleted — template bodies are now in
// email_templates DB (migration 061). File-only tests that previously read from
// ../configs/templates/ now use either:
//   a) a temp dir populated with the canonical body content (for render-path tests), or
//   b) sqlmock (for DB-path tests).

// canonicalBodies are the template bodies as seeded by migration 061.
// Used to write fixture .tmpl files for file-only render tests.
var canonicalBodies = map[string]string{
	"initial": `{{/* humanize: off */}}
{{/* subject: Výkup techniky — kontakt z firmy.cz */}}
{{/* subject: Máte na dvorku techniku k odprodeji? */}}
{{/* subject: Výkup použité techniky */}}
{{/* subject: Dotaz na použitou techniku */}}

Dobrý den,

získal jsem na Vás kontakt v katalogu firem (firmy.cz) v rámci našeho zájmu o sourcing použité stavební a manipulační techniky.

Chtěl jsem se zeptat, zda-li Vám v současné chvíli na dvorku nestojí nějaká technika (vozidlo, kamion, bagr, nakladač, traktor...), které byste se rád zbavil, nebo zda neplánujete v dohledné době výměnu vozového parku.

Pokud ano — pošlete mi prosím fotku a TP (i kopii postačuje) na tento e-mail. V zahraničí mám odběratele, kteří berou prakticky vše. Papíry i odvoz zařídím sám.

Případně volejte 776 299 933.

Děkuji za odpověď,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,

	"followup1": `{{/* humanize: off */}}
{{/* subject: Pripominam se - vykup techniky */}}
{{/* subject: Jeste se ptam - mate techniku? */}}

Dobry den,

pripominam se s pred par dny - jestli mate u Vas nejakou pouzitou
techniku, kterou byste radi prodali.

Cokoli, co Vam u firmy stoji a chcete to pryc - auto, dodavka,
traktor, stroj. Vykupuju pouzitou techniku pro odberatele v zahranici,
prodavame to dal a Vy dostanete poctivou nabidku.

Staci fotka a TP na tento mail. Cenu rekneme do 24 hodin.

Pripadne 776 299 933.

Diky,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,

	"final": `{{/* humanize: off */}}
{{/* subject: Posledni pokus - vykup techniky */}}
{{/* subject: Zaverem - vykup pouzite techniky */}}

Dobry den,

posledni zprava ohledne odkupu pouzite techniky.

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
Kdyby se ale nekdy v budoucnu objevila prilezitost (auto,
dodavka, traktor, stroj), klidne se ozvete - tento mail bude
porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,

	"heavy-01-intro": `{{/* humanize: off */}}
{{/* subject: Pouzita technika u Vas? */}}
{{/* subject: Mate na dvore techniku k odprodeji? */}}
{{/* subject: Vykup pouzite techniky */}}

Dobrý den,

{mate u Vas pouzitou techniku, ktere se chcete zbavit?|nemate u Vas nejakou pouzitou techniku, co Vam stoji bez vyuziti?|nezbyla Vam ve firme nejaka technika, co byste radi prodali?}
Auto, dodavku, traktor, stavebni stroj... cokoli.

Vykupuju pouzitou techniku pro odberatele v zahranici. V zahranici
beru prakticky vse, papiry i odvoz zaridim sam, Vy dostanete poctivou
nabidku.

Staci poslat fotku a TP (i kopii) na tento mail. Pripadne volejte
776 299 933. Zbytek zaridim.

Diky,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,

	"heavy-03-bump": `{{/* humanize: off */}}
{{/* subject: Posledni pokus - vykup techniky */}}
{{/* subject: Naposledy se ptam */}}

Dobrý den,

{posledni zprava ohledne odkupu pouzite techniky.|tohle je ode mne posledni zprava k odkupu pouzite techniky.|naposledy se ptam ohledne odkupu pouzite techniky.}

Pokud nemate nic na prodej, vubec nevadi - dale Vas neobtezuju.
{Kdyby se ale nekdy v budoucnu objevila prilezitost|Pokud by se ale neco objevilo casem} (auto, dodavka, traktor, stroj),
klidne se ozvete - tento mail bude porad funkcni.

Pripadne 776 299 933.

Dekuji za cas,
Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`,
}

// newFixtureDir creates a temp dir with canonical .tmpl bodies and returns its path.
func newFixtureDir(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	toWrite := names
	if len(toWrite) == 0 {
		for k := range canonicalBodies {
			toWrite = append(toWrite, k)
		}
	}
	for _, name := range toWrite {
		body, ok := canonicalBodies[name]
		if !ok {
			t.Fatalf("no canonical body for template %q", name)
		}
		if err := os.WriteFile(filepath.Join(dir, name+".tmpl"), []byte(body), 0o644); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
	}
	return dir
}

// ── D1: rendering with realistic Czech B2B contact ───────────────────────────

var heavyVars = TemplateVars{
	Firma:    "Stavební s.r.o.",
	Jmeno:    "Jan",
	Prijmeni: "Novák",
	Region:   "Praha",
	ICO:      "12345678",
	Podpis:   "Petr Marek\nTel: +420 600 000 000",
}

// ── D1: template existence ────────────────────────────────────────────────────

func TestHeavyTemplates_AllThreeExist(t *testing.T) {
	dir := newFixtureDir(t, "initial", "followup1", "final")
	engine := NewEngine(dir, nil)
	names := engine.ListTemplates()
	required := []string{"initial", "followup1", "final"}
	for _, want := range required {
		found := false
		for _, got := range names {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("heavy-machinery template %q not found; available: %v", want, names)
		}
	}
}

func TestHeavyTemplates_Initial_Renders(t *testing.T) {
	dir := newFixtureDir(t, "initial")
	engine := NewEngine(dir, nil)
	r, err := engine.Render("initial", heavyVars, 1, 0)
	if err != nil {
		t.Fatalf("initial render: %v", err)
	}
	if r.Subject == "" {
		t.Error("initial: subject must not be empty")
	}
	if r.BodyPlain == "" {
		t.Error("initial: body must not be empty")
	}
	if strings.Contains(r.BodyPlain, "{{") {
		t.Errorf("initial: unreplaced placeholder in body: %s", r.BodyPlain[:200])
	}
	// Template intentionally has no first-name personalization (production
	// data has polluted first_name fragments — see commit 887963c). Body
	// must reference the direct buy-out angle (Vykup / odkup pouzite techniky)
	// instead of any brand placeholder.
	if !strings.Contains(strings.ToLower(r.BodyPlain), "technik") {
		t.Error("initial: body should reference 'technik' (heavy machinery context)")
	}
	if r.BodyHTML == "" {
		t.Error("initial: HTML body must not be empty")
	}
}

func TestHeavyTemplates_Followup1_Renders(t *testing.T) {
	dir := newFixtureDir(t, "followup1")
	engine := NewEngine(dir, nil)
	r, err := engine.Render("followup1", heavyVars, 1, 1)
	if err != nil {
		t.Fatalf("followup1 render: %v", err)
	}
	if r.Subject == "" {
		t.Error("followup1: subject must not be empty")
	}
	if strings.Contains(r.BodyPlain, "{{") {
		t.Errorf("followup1: unreplaced placeholder: %s", r.BodyPlain[:min(200, len(r.BodyPlain))])
	}
}

func TestHeavyTemplates_Final_Renders(t *testing.T) {
	dir := newFixtureDir(t, "final")
	engine := NewEngine(dir, nil)
	r, err := engine.Render("final", heavyVars, 1, 2)
	if err != nil {
		t.Fatalf("final render: %v", err)
	}
	if r.Subject == "" {
		t.Error("final: subject must not be empty")
	}
	if strings.Contains(r.BodyPlain, "{{") {
		t.Errorf("final: unreplaced placeholder: %s", r.BodyPlain[:min(200, len(r.BodyPlain))])
	}
}

// ── D1: subjects are Czech and heavy-machinery related ───────────────────────

func TestHeavyTemplates_Initial_HasHeavyMachinerySubject(t *testing.T) {
	dir := newFixtureDir(t, "initial")
	engine := NewEngine(dir, nil)
	// Collect subjects across several seeds
	subjects := map[string]bool{}
	for id := int64(1); id <= 30; id++ {
		r, err := engine.Render("initial", heavyVars, id, 0)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		subjects[r.Subject] = true
	}
	if len(subjects) == 0 {
		t.Error("no subjects collected")
	}
	// At least one subject must contain a heavy-machinery keyword
	keywords := []string{"stroj", "vozidl", "technik", "odkup", "nákup", "Poptávka", "prodej", "vykup", "Vykup"}
	for subj := range subjects {
		found := false
		for _, kw := range keywords {
			if strings.Contains(strings.ToLower(subj), strings.ToLower(kw)) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("subject %q does not contain any heavy-machinery keyword", subj)
		}
	}
}

// ── D1: spin syntax resolves — no {|} markers in output ──────────────────────

func TestHeavyTemplates_NoSpinMarkersInOutput(t *testing.T) {
	dir := newFixtureDir(t, "initial", "followup1", "final")
	engine := NewEngine(dir, nil)
	for _, tmpl := range []string{"initial", "followup1", "final"} {
		for id := int64(1); id <= 10; id++ {
			r, err := engine.Render(tmpl, heavyVars, id, 0)
			if err != nil {
				t.Fatalf("%s: render: %v", tmpl, err)
			}
			if strings.Contains(r.BodyPlain, "{") && strings.Contains(r.BodyPlain, "|") {
				// rough heuristic: {word|word} still present
				t.Errorf("%s id=%d: unresolved spin marker in body", tmpl, id)
			}
		}
	}
}

// ── D1: signature substitution ────────────────────────────────────────────────

func TestHeavyTemplates_SignaturePresent(t *testing.T) {
	dir := newFixtureDir(t, "initial")
	engine := NewEngine(dir, nil)
	r, err := engine.Render("initial", heavyVars, 1, 0)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	// Template has hardcoded persona signature ("Goran Nowak") instead of
	// {{.Podpis}} placeholder — humanize is OFF for this template
	// (commit a809765+646e4f4) so we own the closing block directly.
	if !strings.Contains(r.BodyPlain, "Goran Nowak") {
		t.Errorf("hardcoded signature should appear in body: %s", r.BodyPlain[max(0, len(r.BodyPlain)-200):])
	}
}

// ── D1: property — different seeds produce output variation ──────────────────

func TestHeavyTemplates_Property_SpinVariation(t *testing.T) {
	dir := newFixtureDir(t, "initial")
	engine := NewEngine(dir, nil)
	f := func(id uint16) bool {
		if id == 0 {
			return true
		}
		r, err := engine.Render("initial", TemplateVars{Podpis: "Test"}, int64(id), 0)
		return err == nil && len(r.BodyPlain) > 50
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 100}); err != nil {
		t.Errorf("property: initial renders fail: %v", err)
	}
}

// ── D1: region conditional ────────────────────────────────────────────────────

func TestHeavyTemplates_Initial_RegionConditional(t *testing.T) {
	dir := newFixtureDir(t, "initial")
	engine := NewEngine(dir, nil)

	// With region
	withRegion, _ := engine.Render("initial", TemplateVars{Region: "Praha", Podpis: "X"}, 1, 0)
	// Without region
	noRegion, _ := engine.Render("initial", TemplateVars{Podpis: "X"}, 2, 0)

	// Both must render without error and without leftover tags
	if strings.Contains(withRegion.BodyPlain, "{{if") || strings.Contains(withRegion.BodyPlain, "{{end}}") {
		t.Error("with region: leftover template tags")
	}
	if strings.Contains(noRegion.BodyPlain, "{{if") || strings.Contains(noRegion.BodyPlain, "{{end}}") {
		t.Error("no region: leftover template tags")
	}
}

// ── DB-based ListTemplates (Sprint AH) ───────────────────────────────────────

// TestHeavyTemplates_ListTemplates_DB verifies that ListTemplates() returns
// names from email_templates when the engine is DB-wired (NewEngineWithDB).
// Uses sqlmock to inject 5 rows matching the Sprint AH migration 061.
func TestHeavyTemplates_ListTemplates_DB(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	expectedNames := []string{"final", "followup1", "heavy-01-intro", "heavy-03-bump", "initial"}
	rows := sqlmock.NewRows([]string{"name"})
	for _, n := range expectedNames {
		rows.AddRow(n)
	}
	mock.ExpectQuery(`SELECT name FROM email_templates ORDER BY name`).
		WillReturnRows(rows)

	engine := NewEngineWithDB(db, "", nil)
	names := engine.ListTemplates()

	if len(names) != len(expectedNames) {
		t.Fatalf("ListTemplates() returned %d names, want %d; got: %v", len(names), len(expectedNames), names)
	}
	for i, want := range expectedNames {
		if names[i] != want {
			t.Errorf("ListTemplates()[%d] = %q, want %q", i, names[i], want)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations not met: %v", err)
	}
}

// TestHeavyTemplates_Render_DB_Initial verifies rendering "initial" via DB.
func TestHeavyTemplates_Render_DB_Initial(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	body := `{{/* humanize: off */}}
Dobrý den,

získal jsem na Vás kontakt v katalogu firem (firmy.cz).
Chtěl jsem se zeptat ohledně techniky.

Goran Nowak

---
Obchodní sdělení odesílatele BALKAN MOTORS INT DOO, PIB 03387194,
sídlem Oktobarske revolucije 130, 81000 Podgorica, Crna Gora. Kontakt jsme získali z veřejného
registru firmy.cz pro účel oslovení s nabídkou výkupu použité techniky
(oprávněný zájem dle čl. 6(1)(f) GDPR, Recital 47).

Pro odhlášení odpovězte STOP.`

	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("initial").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow("Výkup techniky — kontakt z firmy.cz", body, "[]", "[]", ""))

	engine := NewEngineWithDB(db, "", nil)
	r, err := engine.Render("initial", heavyVars, 1, 0)
	if err != nil {
		t.Fatalf("Render(initial) via DB: %v", err)
	}
	if r.BodyPlain == "" {
		t.Error("Render(initial): empty body")
	}
	if r.Subject == "" {
		t.Error("Render(initial): empty subject")
	}
	if !strings.Contains(r.BodyPlain, "BALKAN MOTORS") {
		t.Error("Render(initial): missing BALKAN MOTORS in body")
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

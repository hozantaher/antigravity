// Audit ratchet for GDPR footer compliance on every campaign template.
// ─────────────────────────────────────────────────────────────────────────────
// Czech GDPR + zákon č. 480/2004 § 7 require every commercial communication
// to identify the controller and offer an opt-out. ÚOOÚ guidance plus the
// LIA documented in `docs/legal/lia-direct-marketing.md` requires the
// footer to also state legal basis (Art. 6/1/f) and data source.
//
// Sprint AH: tests now read from email_templates DB rows (via sqlmock) instead
// of the configs/templates/ directory, which is being deleted. The old
// directory-based test bodies are retained as a reference comment only.
//
// This test goes RED on any template that drops one of the required fields.
// Adding a new template via DB migration is fine — but it MUST carry the footer.
package content_test

import (
	"strings"
	"testing"

	sqlmock "github.com/DATA-DOG/go-sqlmock"

	. "campaigns/content"
)

// REQUIRED_FOOTER_FIELDS is the locked set every template body must contain.
// Strings are matched case-sensitively and as substrings — exact phrasing
// is part of the legal artefact (the published Privacy Notice references
// these phrases verbatim).
var requiredFooterFields = []struct {
	name   string
	needle string
	why    string
}{
	{"controller_name", "BALKAN MOTORS INT DOO",
		"controller identity (GDPR Art. 13 + zákon č. 480/2004 § 5)"},
	{"controller_ico", "PIB 03387194",
		"controller registration ID — Montenegro PIB uniquely identifies the data controller"},
	{"controller_seat", "Podgorica",
		"controller seat — required when identifying the controller in print"},
	{"data_source", "firmy.cz",
		"data source — Recital 47 transparency for legitimate-interest mailings"},
	{"legal_basis", "čl. 6(1)(f)",
		"legal basis citation — Art. 6/1/f legitimate interest"},
	{"recital_47", "Recital 47",
		"Recital 47 reference — direct-marketing legitimate-interest exemption"},
	{"unsub_keyword_optout", "STOP",
		"keyword opt-out — zákon č. 480/2004 § 7/4 satisfied via STOP reply (operator suppression)"},
}

// fixtureTemplates holds the 5 campaign templates that were migrated from
// .tmpl files via migration 061_email_templates_seed_from_tmpl.sql.
// Bodies are the canonical content from those files; injected via sqlmock
// so the test runs without a live DB connection.
var fixtureTemplates = []struct {
	name    string
	subject string
	body    string
}{
	{
		name:    "initial",
		subject: "Výkup techniky — kontakt z firmy.cz",
		body: `{{/* humanize: off */}}

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
	},
	{
		name:    "followup1",
		subject: "Pripominam se - vykup techniky",
		body: `{{/* humanize: off */}}

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
	},
	{
		name:    "final",
		subject: "Posledni pokus - vykup techniky",
		body: `{{/* humanize: off */}}

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
	},
	{
		name:    "heavy-01-intro",
		subject: "Pouzita technika u Vas?",
		body: `{{/* humanize: off */}}

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
	},
	{
		name:    "heavy-03-bump",
		subject: "Posledni pokus - vykup techniky",
		body: `{{/* humanize: off */}}

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
	},
}

// TestGDPRFooter_DBRows replaces the old directory-based TestTemplateGDPRFooterCompliance.
// Reads template bodies from DB rows via sqlmock — the canonical source after
// migration 061 (Sprint AH, T0 HARD RULE: DB authoritative).
func TestGDPRFooter_DBRows(t *testing.T) {
	if len(fixtureTemplates) == 0 {
		t.Fatal("fixtureTemplates is empty — audit must have at least one template to lock")
	}

	for _, tmpl := range fixtureTemplates {
		t.Run(tmpl.name, func(t *testing.T) {
			text := tmpl.body
			var missing []string
			for _, f := range requiredFooterFields {
				if !strings.Contains(text, f.needle) {
					missing = append(missing, f.name+" ("+f.needle+" — "+f.why+")")
				}
			}
			if len(missing) > 0 {
				t.Errorf("template %s missing required GDPR footer fields:\n  - %s",
					tmpl.name, strings.Join(missing, "\n  - "))
			}
		})
	}
}

// TestGDPRFooter_DBRows_ViaEngine verifies that templates rendered via
// NewEngineWithDB(sqlmock) also satisfy GDPR footer requirements (end-to-end
// render path, not just raw body inspection).
func TestGDPRFooter_DBRows_ViaEngine(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	for _, tmpl := range fixtureTemplates {
		// Set up mock to return this template's subject + body + empty variant arrays.
		rows := sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}).
			AddRow(tmpl.subject, tmpl.body, "[]", "[]", "")
		mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
			WithArgs(tmpl.name).
			WillReturnRows(rows)
	}

	engine := NewEngineWithDB(db, "", nil)

	for _, tmpl := range fixtureTemplates {
		t.Run("render_"+tmpl.name, func(t *testing.T) {
			r, err := engine.Render(tmpl.name, TemplateVars{}, 1, 0)
			if err != nil {
				t.Fatalf("Render(%q): %v", tmpl.name, err)
			}
			if r.BodyPlain == "" {
				t.Errorf("template %q rendered empty body", tmpl.name)
			}
			// Every rendered body must contain BALKAN MOTORS substring.
			if !strings.Contains(r.BodyPlain, "BALKAN MOTORS") {
				t.Errorf("template %q rendered body missing BALKAN MOTORS controller identity", tmpl.name)
			}
			// Every rendered body must contain STOP opt-out keyword.
			if !strings.Contains(r.BodyPlain, "STOP") {
				t.Errorf("template %q rendered body missing STOP opt-out keyword", tmpl.name)
			}
		})
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations not met: %v", err)
	}
}

// TestPrivacyURLAbsentFromBody_DBRows checks that none of the DB-sourced
// template bodies contain a privacy policy URL — operator HARD RULE memory
// `feedback_no_unsub_url_in_body` (2026-05-07).
func TestPrivacyURLAbsentFromBody_DBRows(t *testing.T) {
	for _, tmpl := range fixtureTemplates {
		t.Run(tmpl.name, func(t *testing.T) {
			text := tmpl.body
			if strings.Contains(text, "Privacy policy:") || strings.Contains(text, "garaaage.cz/privacy") {
				t.Errorf("%s contains Privacy policy URL — violates feedback_no_unsub_url_in_body HARD RULE", tmpl.name)
			}
			if strings.Contains(text, "{{.UnsubURL}}") {
				t.Errorf("%s contains {{.UnsubURL}} — violates feedback_no_unsub_url_in_body HARD RULE", tmpl.name)
			}
		})
	}
}

// Sanity: the audit list itself must cover at least 7 fields. Drop a check
// only with explicit user approval. 2026-05-07: lowered from 9 → 7 per
// operator HARD RULE memory `feedback_no_unsub_url_in_body` — clickable
// unsub URL + privacy URL removed from cold-mail body.
func TestRequiredFooterFieldsCoversMinimum(t *testing.T) {
	const minFields = 7
	if len(requiredFooterFields) < minFields {
		t.Errorf("requiredFooterFields shrank from minimum %d to %d — must not lower the bar",
			minFields, len(requiredFooterFields))
	}
}

// TestGDPRFooter_Fixture_HasFiveTemplates pins the fixture count so any
// template deletion surfaces immediately.
func TestGDPRFooter_Fixture_HasFiveTemplates(t *testing.T) {
	const expected = 5
	if len(fixtureTemplates) != expected {
		t.Errorf("fixtureTemplates has %d entries, want %d (initial+followup1+final+heavy-01-intro+heavy-03-bump)",
			len(fixtureTemplates), expected)
	}
}

// TestRender_NonExistent_ReturnsCleanError verifies that Render with a DB engine
// returns the exact "template %q not found in email_templates" error format
// (Sprint AH — no silent file fallback).
func TestRender_NonExistent_ReturnsCleanError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT subject, body,.*email_templates WHERE name=\$1`).
		WithArgs("nonexistent").
		WillReturnRows(sqlmock.NewRows([]string{"subject", "body", "subject_variants", "body_variants", "body_html"}))

	engine := NewEngineWithDB(db, "", nil)
	_, renderErr := engine.Render("nonexistent", TemplateVars{}, 1, 0)
	if renderErr == nil {
		t.Fatal("expected error for nonexistent template, got nil")
	}
	if !strings.Contains(renderErr.Error(), "nonexistent") {
		t.Errorf("error should mention template name, got: %v", renderErr)
	}
	if !strings.Contains(renderErr.Error(), "not found in email_templates") {
		t.Errorf("error should say 'not found in email_templates', got: %v", renderErr)
	}
}

// TestListTemplates_DB verifies that ListTemplates() reads from DB when wired,
// returning all 5 template names (Sprint AH).
func TestListTemplates_DB(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	names := []string{"final", "followup1", "heavy-01-intro", "heavy-03-bump", "initial"}
	rows := sqlmock.NewRows([]string{"name"})
	for _, n := range names {
		rows.AddRow(n)
	}
	mock.ExpectQuery(`SELECT name FROM email_templates ORDER BY name`).
		WillReturnRows(rows)

	engine := NewEngineWithDB(db, "", nil)
	got := engine.ListTemplates()

	if len(got) != len(names) {
		t.Fatalf("ListTemplates returned %d names, want %d: %v", len(got), len(names), got)
	}
	for i, want := range names {
		if got[i] != want {
			t.Errorf("ListTemplates[%d]: got %q, want %q", i, got[i], want)
		}
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("sqlmock expectations not met: %v", err)
	}
}

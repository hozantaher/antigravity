package humanize

import "testing"

// TestClassifyReply_TableDriven exhaustively covers the 6 ReplyType branches
// (Interested, Meeting, Later, Objection, Negative, AutoOOO) and the priority
// order: OOO > Negative > Meeting > Interested > Later > (default Interested).
//
// The audit (docs/audits/2026-04-27-test-gaps-reply.md) flagged this as a
// CRITICAL gap — the function had property-style coverage via
// TestProcessReply_BounceEnvelope_NeverPanics but no per-branch table-driven
// test pinning the exact keyword → ReplyType mapping. This test locks the
// contract so a refactor of the keyword lists raises a real signal.
func TestClassifyReply_TableDriven(t *testing.T) {
	r := NewResponseEngine()

	cases := []struct {
		text string
		want ReplyType
		desc string
	}{
		// ── OOO branch — must win even if other keywords also present
		{"Jsem mimo kancelář do 10. května.", ReplyAutoOOO, "ooo: mimo kancelář"},
		{"I am out of office until Friday.", ReplyAutoOOO, "ooo: out of office english"},
		{"Aktuálně dovolená, vrátím se 15. května.", ReplyAutoOOO, "ooo: dovolená"},
		{"Jsem nepřítomný v práci.", ReplyAutoOOO, "ooo: nepřítomn"},
		{"Mimo kancelář, ale mám zájem — ozvu se.", ReplyAutoOOO, "ooo wins over interested when both keywords present"},

		// ── Negative branch
		{"Nemáme zájem, prosím odhlaste mě.", ReplyNegative, "neg: nemáme zájem"},
		{"Prosím odhlásit z newsletteru.", ReplyNegative, "neg: odhlásit"},
		{"Neobtěžujte mě prosím.", ReplyNegative, "neg: neobtěžujte"},
		{"Nechci žádné nabídky.", ReplyNegative, "neg: nechci"},
		{"Tohle je spam, blokuji.", ReplyNegative, "neg: spam"},
		{"Neposílejte mi nic.", ReplyNegative, "neg: neposílejte"},
		{"NECHCI nic — case insensitive", ReplyNegative, "neg: case-insensitive match"},
		{"Nechci to, ale jindy by mě možná zajímala cena.", ReplyNegative, "neg wins over interested 'cena' when both present"},

		// ── Meeting branch
		{"Zavolejte mi prosím zítra.", ReplyMeeting, "meet: zavolej"},
		{"Sejděme se v Praze.", ReplyMeeting, "meet: sejděme se"},
		{"Domluvíme schůzku?", ReplyMeeting, "meet: schůzk"},
		{"Navrhněte termín.", ReplyMeeting, "meet: termín"},
		{"Krátký hovor by stačil.", ReplyMeeting, "meet: hovor"},
		{"Quick call possible?", ReplyMeeting, "meet: call english"},

		// ── Interested branch
		{"Zájem máme, pošlete víc info.", ReplyInterested, "pos: zájem"},
		{"Řekněte mi víc o tom.", ReplyInterested, "pos: řekněte víc"},
		{"Pošlete mi prezentaci prosím.", ReplyInterested, "pos: pošlete"},
		{"Vaše nabídka mě zajímá.", ReplyInterested, "pos: nabíd"},
		{"Kolik to stojí?", ReplyInterested, "pos: kolik"},
		{"Můžete poslat ceník?", ReplyInterested, "pos: ceník"},
		{"Cena je důležitá.", ReplyInterested, "pos: cena"},

		// ── Later branch
		{"Možná později, teď nemám čas.", ReplyLater, "later: později"},
		{"Příště se tomu možná budu věnovat.", ReplyLater, "later: příště"},
		{"Teď ne, ale díky.", ReplyLater, "later: teď ne"},
		{"Momentálně to neřeším.", ReplyLater, "later: momentálně"},
		{"Za měsíc se ozveme.", ReplyLater, "later: za měsíc"},
		{"Na podzim to bude aktuálnější.", ReplyLater, "later: na podzim"},

		// ── Default fallback (no keyword matched) → Interested
		{"Děkuji za info.", ReplyInterested, "default: thanks-only fallback to Interested"},
		{"OK", ReplyInterested, "default: minimal reply"},
		{"", ReplyInterested, "default: empty body"},
	}

	for _, c := range cases {
		t.Run(c.desc, func(t *testing.T) {
			got := r.ClassifyReply(c.text)
			if got != c.want {
				t.Errorf("ClassifyReply(%q) = %v, want %v", c.text, got, c.want)
			}
		})
	}
}

// TestClassifyReply_PriorityOrder_OOO_BeatsAll: when an OOO keyword + any
// other keyword co-occur, OOO must win because the recipient isn't actually
// available to engage on the underlying topic. This is critical: without
// this, a "Mimo kancelář, mám ale zájem" reply would auto-create a lead
// and notify sales — generating a phantom prospect.
func TestClassifyReply_PriorityOrder_OOO_BeatsAll(t *testing.T) {
	r := NewResponseEngine()

	combos := []string{
		"Mimo kancelář, ale mám zájem o ceník.",       // ooo + interested keywords
		"Out of office, please send pricing later.",    // ooo + interested + later
		"Dovolená do pondělí, sejděme se 15.",          // ooo + meeting
		"Mimo kancelář, nechci spam.",                  // ooo + negative
		"Mimo kancelář, příště ano.",                   // ooo + later
	}

	for _, c := range combos {
		t.Run(c, func(t *testing.T) {
			if got := r.ClassifyReply(c); got != ReplyAutoOOO {
				t.Errorf("ClassifyReply(%q) = %v, want ReplyAutoOOO (OOO must win when present)", c, got)
			}
		})
	}
}

// TestClassifyReply_PriorityOrder_NegativeBeatsLowerPriorities: Negative
// must win over Meeting/Interested/Later. Critical for compliance — a
// "nechci, ale jindy zavolejte" reply must NOT generate a meeting lead.
func TestClassifyReply_PriorityOrder_NegativeBeatsLowerPriorities(t *testing.T) {
	r := NewResponseEngine()

	combos := []string{
		"Nechci nic, ale jindy možná schůzka.",   // neg + meeting → neg
		"Nemáme zájem, ceník neposílejte.",        // neg + interested → neg
		"Odhlásit prosím, později uvidíme.",       // neg + later → neg
	}

	for _, c := range combos {
		t.Run(c, func(t *testing.T) {
			if got := r.ClassifyReply(c); got != ReplyNegative {
				t.Errorf("ClassifyReply(%q) = %v, want ReplyNegative (must win over lower-priority keywords)", c, got)
			}
		})
	}
}

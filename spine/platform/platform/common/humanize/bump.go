package humanize

import (
	"fmt"
	"time"
)

// BumpEngine generates self-forward follow-ups instead of new emails.
// A real person forwards their own email as a "bump" with a one-line addition.
type BumpEngine struct{}

// NewBumpEngine creates a bump engine.
func NewBumpEngine() *BumpEngine {
	return &BumpEngine{}
}

// WrapAsForward wraps the original email as a forwarded message.
// Returns subject and body for the follow-up.
func (b *BumpEngine) WrapAsForward(originalSubject, originalBody, originalFrom string, originalDate time.Time, step int) (subject, body string) {
	// Subject: Fwd: Original Subject
	subject = "Fwd: " + originalSubject

	// One-line intro based on step
	var intro string
	switch step {
	case 1:
		intros := []string{
			"Jen se vracím k tomuhle -- stále aktuální?",
			"Navazuji na svůj předchozí email:",
			"Promiňte že píšu znovu, ale chtěl jsem se ujistit že jste to dostal/a:",
		}
		intro = intros[randMinute(0, len(intros))]
	default:
		intros := []string{
			"Poslední pokus -- omlouvám se za opakované psaní:",
			"Naposledy se vracím k tomuhle:",
		}
		intro = intros[randMinute(0, len(intros))]
	}

	// Build forwarded message body
	dateFmt := originalDate.Format("2. 1. 2006")
	body = fmt.Sprintf(`%s

---------- Přeposlaná zpráva ----------
Od: %s
Datum: %s
Předmět: %s

%s`, intro, originalFrom, dateFmt, originalSubject, originalBody)

	return subject, body
}

// ShouldUseBump decides whether to use forward-bump or fresh email.
// Step 1: 60% bump, 40% fresh. Step 2+: 80% bump, 20% fresh.
func (b *BumpEngine) ShouldUseBump(step int) bool {
	switch step {
	case 1:
		return cryptoRandFloat() < 0.60
	default:
		return cryptoRandFloat() < 0.80
	}
}

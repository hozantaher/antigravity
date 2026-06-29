package humanize

import (
	"time"

	"common/envconfig"
)

// safeProfileEnabled returns true when HUMANIZE_DIACRITICS_DEGRADE=false.
// Default (true) preserves the legacy fingerprint behavior. Operator flips
// the flag on Railway to opt into the SAFE profile that ships diacritics
// verbatim — required for Seznam-class recipient delivery (J3 audit, I4
// sprint EXPECTED FAIL on diacritics random-degrade).
func safeProfileEnabled() bool {
	return !envconfig.BoolOr("HUMANIZE_DIACRITICS_DEGRADE", true)
}

// Engine is the master orchestrator that coordinates all humanization modules.
// It decides WHEN to send (circadian), WHAT to send (tone, imperfections),
// HOW it looks (fingerprint, signature), and HOW to react (response, bump).
type Engine struct {
	Circadian   *CircadianEngine
	Imperfect   *ImperfectEngine
	Tone        *ToneEngine
	Calendar    *CzechCalendar
	Fingerprint *FingerprintEngine
	Signature   *SignatureEngine
	Bump        *BumpEngine
	Response    *ResponseEngine

	// Voice is the per-sender voice profile applied at PrepareEmail
	// time. Defaults to DefaultVoiceProfile() when not bound. Set via
	// WithVoice after NewEngine — keeps the constructor surface stable.
	Voice VoiceProfile
}

// Persona holds the identity details for the simulated sender.
type Persona struct {
	Name    string
	Role    string
	Company string
	Phone   string
	Email   string
	Website string
	Region  string
}

// NewEngine creates a fully configured humanization engine.
//
// The Imperfect subengine respects HUMANIZE_DIACRITICS_DEGRADE: when
// explicitly set to "false", NewImperfectEngineSAFE is used (diacritics
// preserved verbatim). Default keeps the legacy fingerprint.
func NewEngine(persona Persona) *Engine {
	domain := ""
	if at := searchStr(persona.Email, "@"); at >= 0 {
		domain = persona.Email[at+1:]
	}

	imperfect := NewImperfectEngine()
	if safeProfileEnabled() {
		imperfect = NewImperfectEngineSAFE()
	}

	return &Engine{
		Circadian:   NewCircadianEngine(),
		Imperfect:   imperfect,
		Tone:        NewToneEngine(),
		Calendar:    NewCzechCalendar(),
		Fingerprint: NewFingerprintEngine(domain),
		Signature:   NewSignatureEngine(persona.Name, persona.Role, persona.Phone, persona.Email, persona.Website),
		Bump:        NewBumpEngine(),
		Response:    NewResponseEngine(),
		Voice:       DefaultVoiceProfile(),
	}
}

// WithVoice binds a VoiceProfile to this engine. Returns the receiver
// so the call can chain after NewEngine. Passing a fully zero-value
// VoiceProfile literal (ID=0, Name="", no greetings) is a no-op — the
// engine retains DefaultVoiceProfile(). A profile with a non-empty
// Name (e.g. DefaultVoiceProfile() with field overrides such as
// DiacriticsRestoreProb=0) is always applied, so callers can disable
// individual behaviours without being silently ignored.
func (e *Engine) WithVoice(v VoiceProfile) *Engine {
	if v.ID == 0 && v.Name == "" && len(v.GreetingsStep0) == 0 && len(v.GreetingsStep1) == 0 && len(v.GreetingsStep2) == 0 {
		return e
	}
	e.Voice = v
	return e
}

// PlanCampaignDay generates a complete sending plan for a day.
// Returns nil if the day is a dead day or skip day.
func (e *Engine) PlanCampaignDay(date time.Time, baseEmailCount int) *DayPlan {
	// Check Czech calendar first
	calMult := e.Calendar.VolumeMultiplier(date)
	if calMult == 0 {
		return nil // Dead day
	}

	adjusted := int(float64(baseEmailCount) * calMult)
	if adjusted < 1 {
		adjusted = 1
	}

	plan := e.Circadian.PlanDay(date, adjusted)
	if plan.SkipDay {
		return nil
	}

	return &plan
}

// HumanizeEmail applies all humanization to an email before sending.
type HumanizedEmail struct {
	Subject   string
	Body      string
	BodyHTML  string
	Headers   map[string]string
	Signature string
	SendAt    time.Time
	IsBump    bool
}

// PrepareEmail humanizes a raw email for sending.
func (e *Engine) PrepareEmail(
	rawSubject, rawBody string,
	step int,
	sendTime time.Time,
	contactName string,
	originalSubject, originalBody, originalFrom string,
	originalDate time.Time,
) *HumanizedEmail {
	// Decide: bump or fresh?
	isBump := step > 0 && e.Bump.ShouldUseBump(step)

	var subject, body string
	if isBump {
		subject, body = e.Bump.WrapAsForward(originalSubject, originalBody, originalFrom, originalDate, step)
	} else {
		// Fresh email. Voice profile, when bound, overrides the default
		// greeting set so per-sender histograms cluster apart (see
		// voice_profile_test.go property test).
		var greeting string
		if g, ok := e.Voice.SelectGreeting(step, contactName, sendTime); ok {
			greeting = g
		} else {
			greeting = e.Tone.GreetingForStep(step, contactName)
		}
		closing := e.Tone.ClosingForStep(step)

		subject = rawSubject
		body = greeting + ",\n\n" + rawBody + "\n\n" + closing
	}

	// Apply imperfections (degrades diacritics probabilistically per line)
	subject = e.Imperfect.ApplyToSubject(subject)
	body = e.Imperfect.ApplyToBody(body)

	// Restore diacritics on canonical Czech words. Runs AFTER
	// imperfections so it observes (and counters) the strip pass — the
	// body comes out with realistic diacritic density rather than
	// ASCII-only. Probability from the bound VoiceProfile so different
	// senders sit at different points on the diacritic gradient.
	if e.Voice.DiacriticsRestoreProb > 0 {
		subject = RestoreDiacritics(subject, e.Voice.DiacriticsRestoreProb)
		body = RestoreDiacritics(body, e.Voice.DiacriticsRestoreProb)
	}

	// Generate signature; prepend voice-profile closing when present.
	sigType := e.Signature.Select(sendTime)
	signature := e.Signature.Render(sigType)
	if closing, ok := e.Voice.SelectClosing(sendTime); ok {
		signature = closing + ",\n" + signature
	}

	// Full body with signature
	fullBody := body + "\n\n" + signature

	// Generate fingerprint
	messageID := e.Fingerprint.MessageID(sendTime)
	headers := e.Fingerprint.Headers("", "", subject, messageID, sendTime)
	bodyHTML := e.Fingerprint.WrapBodyHTML(fullBody)

	return &HumanizedEmail{
		Subject:   subject,
		Body:      fullBody,
		BodyHTML:  bodyHTML,
		Headers:   headers,
		Signature: signature,
		SendAt:    sendTime,
		IsBump:    isBump,
	}
}

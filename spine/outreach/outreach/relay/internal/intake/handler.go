package intake

import (
	"relay/internal/abuse"
	"relay/internal/audit"
	"relay/internal/delivery/contentenc"
	"relay/internal/identity"
	"relay/internal/transport/metamin"
	"relay/internal/minlog"
	"relay/internal/model"
	"relay/internal/msgbus"
	"relay/internal/delivery/sanitizer"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
)

// seam variables — overridden in tests to inject failures.
var (
	jsonMarshal = json.Marshal
	randRead    = rand.Read
)

// Pipeline orchestrates the full intake flow:
// sanitize -> identity separation -> metadata minimization -> seal -> publish to bus.
type Pipeline struct {
	sanitizer *sanitizer.Service
	identity  *identity.Service
	minimizer *metamin.Minimizer
	sealer    *contentenc.Sealer
	bus       msgbus.Bus
	audit     *audit.Service
	limiter   *abuse.Limiter
	log       *minlog.Logger
}

// NewPipeline creates the intake processing pipeline.
func NewPipeline(
	san *sanitizer.Service,
	id *identity.Service,
	min *metamin.Minimizer,
	seal *contentenc.Sealer,
	bus msgbus.Bus,
	aud *audit.Service,
	lim *abuse.Limiter,
	log *minlog.Logger,
) *Pipeline {
	return &Pipeline{
		sanitizer: san,
		identity:  id,
		minimizer: min,
		sealer:    seal,
		bus:       bus,
		audit:     aud,
		limiter:   lim,
		log:       log,
	}
}

// ProcessResult contains the result of processing an intake request.
type ProcessResult struct {
	EnvelopeID string `json:"envelope_id"`
	Status     string `json:"status"`
	SizeClass  int    `json:"size_class"`
}

// Process runs a submission through the complete intake pipeline.
func (p *Pipeline) Process(ctx context.Context, actor model.Actor, req model.IntakeRequest, intakeChannel string) (ProcessResult, error) {
	// Step 0: Rate limiting
	if err := p.limiter.Check(actor.ID); err != nil {
		p.log.Info("rate_limited", minlog.F("actor_id", actor.ID))
		return ProcessResult{}, err
	}

	// Step 1: Sanitize content and metadata
	sanResult := p.sanitizer.SanitizeIntake(req)
	if sanResult.Status == "blocked" {
		p.log.Info("intake_blocked", minlog.F("reason", "blocked_content"))
		return ProcessResult{Status: model.StatusBlocked}, nil
	}

	// Step 2: Identity separation -- issue opaque alias token
	aliasToken, err := p.identity.IssueAlias(ctx, actor.TenantID, actor.ID, "intake-submission")
	if err != nil {
		p.log.Error("identity_issue_failed", minlog.F("error_type", "vault_error"))
		return ProcessResult{}, err
	}

	// Step 3: Create envelope
	envID, err := generateEnvelopeID()
	if err != nil {
		return ProcessResult{}, err
	}

	// Prepare content for sealing — include HTML part and fingerprint headers when provided
	// so the relay can build a properly humanized multipart/alternative message.
	content := struct {
		Recipient string            `json:"recipient"`
		Subject   string            `json:"subject"`
		Body      string            `json:"body"`
		BodyHTML  string            `json:"body_html,omitempty"`
		Headers   map[string]string `json:"headers,omitempty"`
	}{
		Recipient: req.Recipient,
		Subject:   sanResult.NormalizedSubject,
		Body:      sanResult.NormalizedBody,
		BodyHTML:  req.BodyHTML,
		Headers:   req.Headers,
	}
	plaintext, err := jsonMarshal(content)
	if err != nil {
		return ProcessResult{}, err
	}

	// Step 4: Metadata minimization -- pad to size class
	padded, sizeClass := p.minimizer.PadToSizeClass(plaintext)

	// Step 5: Content encryption (if recipient key provided)
	var sealed []byte
	if len(req.RecipientKey) == 32 {
		sealed, err = p.sealer.Seal(padded, req.RecipientKey)
		if err != nil {
			p.log.Error("seal_failed", minlog.F("error_type", "encryption_error"))
			return ProcessResult{}, err
		}
	} else {
		// No recipient key -- store padded content (still encrypted at rest via filestore codec)
		sealed = padded
	}

	env := model.Envelope{
		ID:               envID,
		AliasToken:       aliasToken,
		TenantID:         actor.TenantID,
		SealedContent:    sealed,
		SizeClass:        sizeClass,
		IntakeChannel:    intakeChannel,
		Status:           model.StatusSealed,
		Recipient:        req.Recipient,
		Subject:          sanResult.NormalizedSubject,
		FromAddress:      req.FromAddress,
		InlineCreds:      req.InlineCreds(),
		PreferredCountry: req.PreferredCountry,
		MailboxID:        req.MailboxID,
	}

	// Step 6: Apply metadata minimization to envelope
	p.minimizer.MinimizeEnvelope(&env)

	// Step 7: Audit (minimal -- no content, no identity)
	p.audit.Record(ctx, actor.TenantID, model.EventIntakeAccepted, envID)

	// Step 8: Publish to message bus
	if err := p.bus.Publish(ctx, msgbus.TopicSealed, env); err != nil {
		p.log.Error("bus_publish_failed", minlog.F("error_type", "bus_error"))
		return ProcessResult{}, err
	}

	p.log.Info("intake_accepted",
		minlog.F("envelope_id", envID),
		minlog.F("size_class", intToStr(sizeClass)),
		minlog.F("channel", intakeChannel),
	)

	return ProcessResult{
		EnvelopeID: envID,
		Status:     model.StatusSealed,
		SizeClass:  sizeClass,
	}, nil
}

func generateEnvelopeID() (string, error) {
	b := make([]byte, 12)
	if _, err := randRead(b); err != nil {
		return "", err
	}
	return "env_" + hex.EncodeToString(b), nil
}

func intToStr(n int) string {
	return hex.EncodeToString([]byte{byte(n >> 8), byte(n)})
}

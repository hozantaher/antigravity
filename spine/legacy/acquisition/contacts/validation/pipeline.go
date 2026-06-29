package validation

import (
	"context"
	"contacts/contact"
)

// Validator checks one aspect of an email address.
type Validator interface {
	Name() string
	Validate(ctx context.Context, email string) (passed bool, detail string, err error)
}

// Pipeline runs validators in sequence, short-circuits on failure.
type Pipeline struct {
	validators []Validator
}

// NewPipeline creates a validation pipeline with all standard checks.
func NewPipeline() *Pipeline {
	return &Pipeline{
		validators: []Validator{
			&SyntaxValidator{},
			&DuplicateValidator{seen: make(map[string]bool)},
			&DisposableValidator{},
			&MXValidator{},
		},
	}
}

// Run executes all validators against the email, building a ValidationResult.
func (p *Pipeline) Run(ctx context.Context, email string) *contact.ValidationResult {
	result := &contact.ValidationResult{
		RiskLevel: "low",
	}

	for _, v := range p.validators {
		passed, _, err := v.Validate(ctx, email)
		if err != nil {
			continue
		}

		switch v.Name() {
		case "syntax":
			result.SyntaxValid = passed
			if !passed {
				result.RiskLevel = "high"
				return result
			}
		case "mx":
			result.MXExists = passed
			if !passed {
				result.RiskLevel = "high"
				return result
			}
		case "disposable":
			result.IsDisposable = !passed
			if !passed {
				result.RiskLevel = "high"
				return result
			}
		case "duplicate":
			if !passed {
				result.RiskLevel = "high"
				return result
			}
		}
	}

	return result
}

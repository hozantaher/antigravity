package humanize

import "time"

// SignatureEngine rotates email signatures based on context.
type SignatureEngine struct {
	name    string
	role    string
	phone   string
	email   string
	website string
}

// NewSignatureEngine creates a signature engine with the persona's details.
func NewSignatureEngine(name, role, phone, email, website string) *SignatureEngine {
	return &SignatureEngine{
		name:    name,
		role:    role,
		phone:   phone,
		email:   email,
		website: website,
	}
}

// SignatureType determines which signature variant to use.
type SignatureType int

const (
	SignatureDesktop SignatureType = iota // Full formatted signature
	SignatureMobile                       // "Odesláno z mého telefonu"
	SignatureShort                        // Just initials
)

// Select picks a signature type based on time of day and randomness.
func (s *SignatureEngine) Select(sendTime time.Time) SignatureType {
	hour := sendTime.Hour()

	// Evening (19-22) = mobile signature
	if hour >= 19 && hour <= 22 {
		return SignatureMobile
	}

	// 5% chance of short signature (tired, rushed)
	if cryptoRandFloat() < 0.05 {
		return SignatureShort
	}

	// 15% chance of mobile (sent from phone during break)
	if cryptoRandFloat() < 0.15 {
		return SignatureMobile
	}

	return SignatureDesktop
}

// Render produces the signature text.
func (s *SignatureEngine) Render(sigType SignatureType) string {
	switch sigType {
	case SignatureDesktop:
		sig := s.name
		if s.role != "" {
			sig += "\n" + s.role
		}
		if s.phone != "" {
			sig += "\nTel: " + s.phone
		}
		if s.email != "" {
			sig += "\nEmail: " + s.email
		}
		if s.website != "" {
			sig += "\n" + s.website
		}
		return sig

	case SignatureMobile:
		options := []string{
			"Odesláno z mého telefonu\n" + s.name,
			s.name + "\n(odesláno z mobilu)",
			s.name,
		}
		return options[randMinute(0, len(options))]

	case SignatureShort:
		// Just initials
		if len(s.name) > 0 {
			parts := splitWords(s.name)
			initials := ""
			for _, p := range parts {
				if len(p) > 0 {
					initials += string([]rune(p)[0])
				}
			}
			return initials
		}
		return s.name

	default:
		return s.name
	}
}

func splitWords(s string) []string {
	var words []string
	word := ""
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if word != "" {
				words = append(words, word)
				word = ""
			}
		} else {
			word += string(r)
		}
	}
	if word != "" {
		words = append(words, word)
	}
	return words
}

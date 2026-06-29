package content

import (
	"math/rand"
	"strings"
)

// ResolveSpin resolves spin syntax in text.
// Spin syntax: {option1|option2|option3}
// Nested spins supported: {We {buy|purchase}|We're looking to {acquire|buy}}
// The seed ensures deterministic selection for the same contact+step.
func ResolveSpin(input string, seed int64) string {
	rng := rand.New(rand.NewSource(seed))
	return resolveSpinRecursive(input, rng)
}

func resolveSpinRecursive(input string, rng *rand.Rand) string {
	for strings.Contains(input, "{") {
		start := -1
		resolved := false
		for i, c := range input {
			if c == '{' {
				start = i
			}
			if c == '}' && start >= 0 {
				group := input[start+1 : i]
				options := splitPipes(group)
				chosen := options[rng.Intn(len(options))]
				input = input[:start] + chosen + input[i+1:]
				resolved = true
				break
			}
		}
		if !resolved {
			break
		}
	}
	return input
}

// splitPipes splits on | but respects nested braces.
func splitPipes(s string) []string {
	var parts []string
	var current strings.Builder
	depth := 0
	for _, c := range s {
		if c == '{' {
			depth++
			current.WriteRune(c)
		} else if c == '}' {
			depth--
			current.WriteRune(c)
		} else if c == '|' && depth == 0 {
			parts = append(parts, current.String())
			current.Reset()
		} else {
			current.WriteRune(c)
		}
	}
	parts = append(parts, current.String())
	return parts
}

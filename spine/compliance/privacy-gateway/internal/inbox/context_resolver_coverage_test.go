package inbox

import (
	"testing"
)

// TestNormalizeCorrelationSubjectStripsPrefixes exercises all prefix branches
// and the trivial cases of normalizeCorrelationSubject.
func TestNormalizeCorrelationSubjectStripsPrefixes(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"plain subject", "Hello world", "hello world"},
		{"re prefix", "Re: Hello", "hello"},
		{"fw prefix", "fw: Hello", "hello"},
		{"fwd prefix", "Fwd: Hello", "hello"},
		{"double re", "Re: Re: Hello", "hello"},
		{"mixed prefixes", "Re: Fwd: Hello", "hello"},
		{"just prefix", "Re:", ""},
		{"empty", "", ""},
		{"lowercase", "re: HELLO", "hello"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeCorrelationSubject(tc.input); got != tc.want {
				t.Fatalf("normalizeCorrelationSubject(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestNewContextResolverReturnsNilForMissingDeps exercises the nil-dep branches.
func TestNewContextResolverReturnsNilForMissingDeps(t *testing.T) {
	if NewContextResolver(nil, nil) != nil {
		t.Fatal("expected nil resolver when both deps are nil")
	}
}

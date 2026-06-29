package blockdetect

import (
	"math/rand"
	"net/http"
	"strconv"
	"testing"
	"testing/quick"
)

// TestProperty_DeterministicClassification verifies that DetectBlock is a pure
// function: identical (status, headers, body) inputs ALWAYS produce the same
// BlockType output. This is the foundational property the healing audit
// depends on — without determinism, the healing_log row written for an event
// might disagree with a re-classification on operator review, and
// after-the-fact replay against a debug fixture could not be trusted.
//
// Property: ∀ x ∈ HTTPResponse. DetectBlock(x) == DetectBlock(x).
//
// Implementation: 1000 randomly generated responses, each classified twice
// with isolated header copies, asserted equal.
//
// Seed range: rand.New(rand.NewSource(seed)) where seed iterates [1..1000].
// Reproducible — failure prints the seed for replay.
func TestProperty_DeterministicClassification(t *testing.T) {
	t.Parallel()

	const iterations = 1000
	const seedBase = int64(1)

	for i := 0; i < iterations; i++ {
		seed := seedBase + int64(i)
		i := i
		t.Run("seed="+strconv.FormatInt(seed, 10), func(t *testing.T) {
			t.Parallel()

			r := rand.New(rand.NewSource(seed))
			status, headersA, body := randomResponse(r)
			headersB := cloneHeaders(headersA)

			gotA := DetectBlock(status, headersA, body)
			gotB := DetectBlock(status, headersB, append([]byte(nil), body...))

			if gotA != gotB {
				t.Fatalf("nedeterministická klasifikace na seed=%d (iter=%d): A=%s B=%s\n  status=%d headers=%v body[0..80]=%q",
					seed, i, gotA, gotB, status, headersA, truncate(body, 80))
			}
		})
	}
}

// TestProperty_NeverPanics confirms DetectBlock is panic-free across the
// random response space. Healing log writers run in production hot paths
// (every ARES + firmy.cz fetch); a panic would crash the worker loop.
func TestProperty_NeverPanics(t *testing.T) {
	t.Parallel()

	f := func(status int, contentType string, body []byte) bool {
		// quick.Check generates arbitrary ints; we coerce to a valid HTTP
		// status range (0..999) via modulo so the test exercises both legal
		// codes and the surrounding noise space.
		s := abs(status) % 1000
		h := http.Header{}
		if contentType != "" {
			h.Set("Content-Type", contentType)
		}

		defer func() {
			if r := recover(); r != nil {
				t.Errorf("DetectBlock panic: %v\n  status=%d body[0..40]=%q", r, s, truncate(body, 40))
			}
		}()
		_ = DetectBlock(s, h, body)
		return true
	}
	cfg := &quick.Config{MaxCount: 500}
	if err := quick.Check(f, cfg); err != nil {
		t.Fatalf("quick.Check: %v", err)
	}
}

// TestProperty_ConservativeBias asserts the design contract: detector NEVER
// false-positives on plain JSON success (200 + valid JSON + no Cf-* headers).
// Healing log MUST stay clean on the 95%+ daily traffic that is nominal —
// otherwise the audit channel becomes noise and recovery actions misfire.
func TestProperty_ConservativeBias(t *testing.T) {
	t.Parallel()

	const iterations = 200
	for i := 0; i < iterations; i++ {
		i := i
		t.Run("iter="+strconv.Itoa(i), func(t *testing.T) {
			t.Parallel()

			r := rand.New(rand.NewSource(int64(10_000 + i)))
			body := randomLegitimateJSON(r)
			h := http.Header{"Content-Type": []string{"application/json"}}

			got := DetectBlock(http.StatusOK, h, body)
			if got != BlockTypeNone {
				t.Fatalf("false-positive na legitní 200 JSON (iter=%d): %s\n  body=%q", i, got, body)
			}
		})
	}
}

// FuzzDetectBlock — Go native fuzz harness. Run with:
//
//	go test -fuzz=FuzzDetectBlock -fuzztime=10s ./services/contacts/internal/blockdetect/
//
// The fuzzer randomly mutates (status, contentType, body) inputs from a
// seed corpus drawn from the four block classes + nominal success. The
// invariant under fuzz is panic-free + deterministic: corpus discovery
// of either failure mode is a hard regression.
func FuzzDetectBlock(f *testing.F) {
	// Seed corpus — one example per class + edge.
	seeds := []struct {
		status      int
		contentType string
		body        []byte
	}{
		{200, "application/json", []byte(`{"ico":"12345678"}`)},
		{429, "application/json", []byte(`{"error":"rate limit"}`)},
		{200, "text/html", []byte(`<html><title>Just a moment...</title></html>`)},
		{200, "text/html", []byte(`<div class="g-recaptcha"></div>`)},
		{403, "text/html", []byte(`<h1>Forbidden</h1>`)},
		{503, "text/plain", []byte(`overloaded`)},
		{200, "", nil},
		{200, "text/html", []byte(`<html><body>Too Many Requests</body></html>`)},
	}
	for _, s := range seeds {
		f.Add(s.status, s.contentType, s.body)
	}

	f.Fuzz(func(t *testing.T, status int, contentType string, body []byte) {
		// Coerce to legal HTTP status range — keeps fuzz fast and
		// exercises the full classifier path without status-validation
		// overhead.
		s := abs(status) % 1000
		h := http.Header{}
		if contentType != "" {
			h.Set("Content-Type", contentType)
		}
		// Property 1: never panics.
		gotA := DetectBlock(s, h, body)
		// Property 2: deterministic — second call (cloned inputs) must
		// agree.
		hClone := cloneHeaders(h)
		bodyClone := append([]byte(nil), body...)
		gotB := DetectBlock(s, hClone, bodyClone)
		if gotA != gotB {
			t.Fatalf("fuzz: nedeterministická klasifikace status=%d ct=%q body[0..40]=%q : A=%s B=%s",
				s, contentType, truncate(body, 40), gotA, gotB)
		}
	})
}

// randomResponse builds a synthetic HTTP response that exercises the four
// classifier branches with non-zero probability:
//
//	~25% block (random class) ; ~75% nominal — biased to nominal because
//	in production blocks are <5% of traffic and the property must hold on
//	the dominant path.
//
// Each block class draws from real-shape header/body fragments so the
// scenario stays close to observed traffic.
func randomResponse(r *rand.Rand) (int, http.Header, []byte) {
	pick := r.Intn(8)
	switch pick {
	case 0:
		// 200 + Cloudflare body marker.
		return http.StatusOK,
			http.Header{"Cf-Ray": []string{"abc-PRG"}, "Content-Type": []string{"text/html"}},
			[]byte(`<html><title>Just a moment...</title></html>`)
	case 1:
		// 403 + Server: cloudflare.
		return http.StatusForbidden,
			http.Header{"Server": []string{"cloudflare"}},
			[]byte(`<html>Sorry, you have been blocked</html>`)
	case 2:
		// 200 + reCAPTCHA widget.
		return http.StatusOK,
			http.Header{"Content-Type": []string{"text/html"}},
			[]byte(`<form><div class="g-recaptcha" data-sitekey="x"></div></form>`)
	case 3:
		// 429 + Retry-After.
		return http.StatusTooManyRequests,
			http.Header{"Retry-After": []string{"30"}},
			[]byte(`{"error":"too many"}`)
	case 4:
		// 401 unauthorized.
		return http.StatusUnauthorized,
			http.Header{},
			[]byte(`{"error":"unauthorized"}`)
	case 5:
		// 503 overload (not block — no Retry-After).
		return http.StatusServiceUnavailable,
			http.Header{"Server": []string{"nginx"}},
			[]byte(`<h1>Service Unavailable</h1>`)
	default:
		// Nominal 200.
		body := randomLegitimateJSON(r)
		return http.StatusOK,
			http.Header{"Content-Type": []string{"application/json"}},
			body
	}
}

// randomLegitimateJSON produces a real-shape ARES-style JSON envelope. We
// intentionally constrain the alphabet to safe content so the fuzz never
// drifts into "the random body happened to contain just a moment" land —
// the conservative-bias property would then be vacuous.
func randomLegitimateJSON(r *rand.Rand) []byte {
	icoOptions := []string{"23219700", "12345678", "87654321", "11111111", "26168685"}
	nameOptions := []string{
		"Garaaage s.r.o.",
		"Bagry Praha s.r.o.",
		"Jeřáby Brno a.s.",
		"Stavební technika Plzeň s.r.o.",
		"Lopaty CZ a.s.",
	}
	regionOptions := []string{"Praha", "Brno", "Ostrava", "Plzeň", "Liberec"}

	ico := icoOptions[r.Intn(len(icoOptions))]
	name := nameOptions[r.Intn(len(nameOptions))]
	region := regionOptions[r.Intn(len(regionOptions))]

	return []byte(`{"ico":"` + ico + `","obchodniJmeno":"` + name + `","sidlo":{"nazevObce":"` + region + `"}}`)
}

func cloneHeaders(h http.Header) http.Header {
	out := make(http.Header, len(h))
	for k, vv := range h {
		clone := make([]string, len(vv))
		copy(clone, vv)
		out[k] = clone
	}
	return out
}

func abs(x int) int {
	if x < 0 {
		// Avoid overflow on math.MinInt by clamping.
		if x == minInt {
			return maxInt
		}
		return -x
	}
	return x
}

const (
	minInt = -1 << 63
	maxInt = 1<<63 - 1
)

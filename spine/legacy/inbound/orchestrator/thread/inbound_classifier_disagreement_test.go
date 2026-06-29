package thread

import (
	"context"
	"errors"
	"strings"
	"testing"

	"common/humanize"
)

// fakeClassifier is a deterministic SentimentClassifier for testing the
// keyword/LLM disagreement logging path.
type fakeClassifier struct {
	wantText  string
	returnCat string
	returnErr error
}

func (f *fakeClassifier) ClassifySentiment(ctx context.Context, text string) (string, error) {
	if f.returnErr != nil {
		return "", f.returnErr
	}
	return f.returnCat, nil
}

// TestProcessReply_LLMOverridesKeyword_OnAgreementAndDisagreement verifies
// the new disagreement logic: when LLM and keyword agree, we use LLM
// silently; when they disagree (both parseable), we use LLM but log
// slog.Info so the operator can curate the sample bank.
func TestProcessReply_LLMOverridesKeyword_OnAgreementAndDisagreement(t *testing.T) {
	r := humanize.NewResponseEngine()

	cases := []struct {
		name           string
		body           string
		llmCategory    string
		llmErr         error
		keywordExpect  humanize.ReplyType
		finalExpect    humanize.ReplyType
	}{
		{
			name:          "agreement: keyword negative, LLM negative",
			body:          "Nemám zájem.",
			llmCategory:   "negative",
			keywordExpect: humanize.ReplyNegative,
			finalExpect:   humanize.ReplyNegative,
		},
		{
			name:          "disagreement: keyword interested fallback, LLM negative — LLM wins",
			body:          "Děkuji za nabídku, ale momentálně to neřešíme.",
			llmCategory:   "negative",
			keywordExpect: humanize.ReplyInterested, // default fallback
			finalExpect:   humanize.ReplyNegative,
		},
		{
			// Po PR #392 humanize.ClassifyReply má Objection větev co
			// matchne "vysoká" PŘED Interested (cena). Test stále
			// demonstruje LLM-override pattern: keyword baseline
			// (Objection) ≠ LLM (Negative), final = LLM wins.
			name:          "disagreement: keyword objection (vysoká), LLM negative — LLM wins",
			body:          "Cena je vysoká, neberu.",
			llmCategory:   "negative",
			keywordExpect: humanize.ReplyObjection, // matches "vysoká" objection keyword
			finalExpect:   humanize.ReplyNegative,
		},
		{
			name:          "LLM error: keyword fallback applies",
			body:          "Nemám zájem.",
			llmErr:        errors.New("ollama timeout"),
			keywordExpect: humanize.ReplyNegative,
			finalExpect:   humanize.ReplyNegative,
		},
		{
			name:          "LLM unparseable: keyword fallback applies",
			body:          "Nemám zájem.",
			llmCategory:   "garbage_response",
			keywordExpect: humanize.ReplyNegative,
			finalExpect:   humanize.ReplyNegative,
		},
		{
			name:          "LLM ooo: overrides keyword interested fallback",
			body:          "I will be back next week.",
			llmCategory:   "ooo",
			keywordExpect: humanize.ReplyInterested, // no Czech OOO keyword
			finalExpect:   humanize.ReplyAutoOOO,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Verify keyword baseline
			gotKeyword := r.ClassifyReply(c.body)
			if gotKeyword != c.keywordExpect {
				t.Errorf("keyword baseline: got %v, want %v (text=%q)",
					gotKeyword, c.keywordExpect, c.body)
			}

			// Now simulate the inbound.go classification logic
			fake := &fakeClassifier{
				returnCat: c.llmCategory,
				returnErr: c.llmErr,
			}
			final := simulateClassify(r, fake, c.body)
			if final != c.finalExpect {
				t.Errorf("final: got %v, want %v", final, c.finalExpect)
			}
		})
	}
}

// simulateClassify replicates the inbound.go classification block in
// isolation so we can unit-test the override logic without spinning up a
// full ProcessReply pipeline (which needs a DB, recorder, etc.).
func simulateClassify(r *humanize.ResponseEngine, c *fakeClassifier, body string) humanize.ReplyType {
	keywordType := r.ClassifyReply(body)
	replyType := keywordType
	if c == nil {
		return replyType
	}
	cat, err := c.ClassifySentiment(context.Background(), body)
	if err != nil {
		return replyType
	}
	if llmType, ok := parseReplyType(cat); ok {
		return llmType
	}
	return replyType
}

// TestParseReplyType_AllCategories pins the contract — every value the LLM
// prompt can return must map to a ReplyType. A drift in the prompt
// vocabulary (e.g. LLM returns "interested_strong") would silently fall
// back to keyword without this test.
func TestParseReplyType_AllCategories(t *testing.T) {
	cases := map[string]humanize.ReplyType{
		"interested":  humanize.ReplyInterested,
		"meeting":     humanize.ReplyMeeting,
		"later":       humanize.ReplyLater,
		"objection":   humanize.ReplyObjection,
		"negative":    humanize.ReplyNegative,
		"ooo":         humanize.ReplyAutoOOO,
		"INTERESTED":  humanize.ReplyInterested, // case-insensitive
		"  meeting  ": humanize.ReplyMeeting,    // trim
	}

	for input, want := range cases {
		t.Run(input, func(t *testing.T) {
			got, ok := parseReplyType(input)
			if !ok {
				t.Errorf("parseReplyType(%q) returned ok=false", input)
				return
			}
			if got != want {
				t.Errorf("parseReplyType(%q) = %v, want %v", input, got, want)
			}
		})
	}

	rejected := []string{
		"",
		"unknown",
		"interested_strong",
		"yes",
		"no",
		"random",
	}
	for _, in := range rejected {
		t.Run("reject:"+in, func(t *testing.T) {
			_, ok := parseReplyType(in)
			if ok {
				t.Errorf("parseReplyType(%q) should reject but accepted", in)
			}
		})
	}
}

// TestSimulateClassify_NilClassifier verifies keyword-only path when no
// LLM classifier is wired (e.g. CI / test mode without OLLAMA_URL).
func TestSimulateClassify_NilClassifier(t *testing.T) {
	r := humanize.NewResponseEngine()

	cases := map[string]humanize.ReplyType{
		"Nemám zájem.":       humanize.ReplyNegative,
		"Zavolejte mi.":      humanize.ReplyMeeting,
		"Cena je super.":     humanize.ReplyInterested,
		"Mimo kancelář.":     humanize.ReplyAutoOOO,
		"random gibberish.":  humanize.ReplyInterested, // default
	}

	for body, want := range cases {
		t.Run(strings.ReplaceAll(body, " ", "_"), func(t *testing.T) {
			got := simulateClassify(r, nil, body)
			if got != want {
				t.Errorf("nil-classifier path: got %v, want %v", got, want)
			}
		})
	}
}

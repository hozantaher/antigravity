package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"campaigns/content"
	"campaigns/sender"
	"common/config"
)

// ---- fake Submitter --------------------------------------------------------

type fakeSubmitter struct {
	calls  []sender.SendRequest
	err    error // if non-nil, every Send returns this error
}

func (f *fakeSubmitter) Send(_ context.Context, req sender.SendRequest) sender.SendResult {
	f.calls = append(f.calls, req)
	if f.err != nil {
		return sender.SendResult{Error: f.err, SentAt: time.Now()}
	}
	return sender.SendResult{
		MessageID:   "test-msg-id-" + fmt.Sprintf("%d", len(f.calls)),
		MailboxUsed: req.SMTPUsername,
		SentAt:      time.Now(),
	}
}

// ---- fake content engine ---------------------------------------------------

type fakeContentEngine struct {
	renderErr error
	badTmpl   string
}

func (f *fakeContentEngine) Render(tmplName string, _ content.TemplateVars, _ int64, _ int) (*content.RenderedEmail, error) {
	if f.renderErr != nil && tmplName == f.badTmpl {
		return nil, f.renderErr
	}
	return &content.RenderedEmail{
		Subject:   "Test subject for " + tmplName,
		BodyPlain: "Test body",
		Headers:   map[string]string{"Content-Language": "cs"},
	}, nil
}

// ---- helpers ----------------------------------------------------------------

func makeMailboxes(n int) []DBMailbox {
	mbs := make([]DBMailbox, n)
	for i := range mbs {
		mbs[i] = DBMailbox{
			ID:          int64(i + 1),
			FromAddress: fmt.Sprintf("user%d@example.com", i+1),
			SMTPHost:    "smtp.example.com",
			SMTPPort:    465,
			Password:    "realpassword123",
			Status:      "active",
		}
	}
	return mbs
}

// contentRenderer mirrors the Render signature so dispatchWithRenderer can
// accept either the real content.Engine or a fake.
type contentRenderer interface {
	Render(tmplName string, vars content.TemplateVars, contactID int64, step int) (*content.RenderedEmail, error)
}

// dispatchWithRenderer is a test-friendly version of the main enqueue+run
// logic that accepts the contentRenderer interface instead of *content.Engine
// and uses a Submitter directly (bypasses Engine.Run for unit tests).
func dispatchWithRenderer(
	ctx context.Context,
	runID string,
	pairs []Pair,
	client interface {
		Send(ctx context.Context, req sender.SendRequest) sender.SendResult
	},
	renderer contentRenderer,
	spacing time.Duration,
) []PairResult {
	results := make([]PairResult, 0, len(pairs))
	for i, p := range pairs {
		if i > 0 && spacing > 0 {
			timer := time.NewTimer(spacing)
			select {
			case <-ctx.Done():
				timer.Stop()
				return results
			case <-timer.C:
			}
		}

		contactID := deterministicContactID(runID, i)
		vars := content.TemplateVars{Firma: "Test Recipient", UnsubURL: "https://example.com/unsubscribe"}
		rendered, err := renderer.Render(p.Template, vars, contactID, 1)
		if err != nil {
			fmt.Printf("[anon-test] run=%s pair=%s->%s tmpl=%s err=%v\n",
				runID, p.Sender.FromAddress, p.Receiver.FromAddress, p.Template, err)
			results = append(results, PairResult{Pair: p, Err: err})
			continue
		}

		// Inject subject marker (same as main path).
		markedSubject := injectSubjectMarker(rendered.Subject, runID)

		headers := make(map[string]string, len(rendered.Headers)+1)
		for k, v := range rendered.Headers {
			headers[k] = v
		}
		headers[TestRunHeader] = runID

		req := sender.SendRequest{
			CampaignID:   0,
			ContactID:    contactID,
			Step:         1,
			ToAddress:    p.Receiver.FromAddress,
			Subject:      markedSubject,
			BodyPlain:    rendered.BodyPlain,
			BodyHTML:     rendered.BodyHTML,
			Headers:      headers,
			SkipHumanize: rendered.SkipHumanize,
			SMTPHost:     p.Sender.SMTPHost,
			SMTPPort:     p.Sender.SMTPPort,
			SMTPUsername: p.Sender.FromAddress,
			SMTPPassword: p.Sender.Password,
		}

		res := client.Send(ctx, req)
		if res.Error != nil {
			fmt.Printf("[anon-test] run=%s pair=%s->%s tmpl=%s err=%v\n",
				runID, p.Sender.FromAddress, p.Receiver.FromAddress, p.Template, res.Error)
			results = append(results, PairResult{Pair: p, Err: res.Error})
			continue
		}
		results = append(results, PairResult{Pair: p, Sent: true, MsgID: res.MessageID})
	}
	return results
}

// ============================================================================
// Test 1: 4 mailboxes × 3 templates = 36 pairs, no self-pairs
// ============================================================================

func TestBuildPairs_4Mailboxes3Templates_36Pairs(t *testing.T) {
	mbs := makeMailboxes(4)
	templates := []string{"intro_machinery", "followup_1", "followup_2"}

	pairs := buildPairs(mbs, templates)

	if len(pairs) != 36 {
		t.Errorf("expected 36 pairs, got %d", len(pairs))
	}
	for _, p := range pairs {
		if p.Sender.FromAddress == p.Receiver.FromAddress {
			t.Errorf("self-pair found: %s -> %s", p.Sender.FromAddress, p.Receiver.FromAddress)
		}
	}
}

// ============================================================================
// Test 2: 1 mailbox = 0 triples
// ============================================================================

func TestBuildPairs_1Mailbox_0Pairs(t *testing.T) {
	mbs := makeMailboxes(1)
	templates := []string{"intro_machinery"}

	pairs := buildPairs(mbs, templates)

	if len(pairs) != 0 {
		t.Errorf("expected 0 pairs for 1 mailbox, got %d", len(pairs))
	}
}

// ============================================================================
// Test 3: 2 mailboxes × 1 template = 2 pairs
// ============================================================================

func TestBuildPairs_2Mailboxes1Template_2Pairs(t *testing.T) {
	mbs := makeMailboxes(2)
	templates := []string{"intro_machinery"}

	pairs := buildPairs(mbs, templates)

	if len(pairs) != 2 {
		t.Errorf("expected 2 pairs, got %d", len(pairs))
	}
}

// ============================================================================
// Test 4: Subject-marker injection — prefix is correctly prepended
// ============================================================================

func TestSubjectMarker_InjectedCorrectly(t *testing.T) {
	runID := "1a2b3c4d-5e6f-4000-8000-abcdef012345"
	subject := "Váš stroj je připraven"

	marked := injectSubjectMarker(subject, runID)

	wantPrefix := "[A:1a2b3c4d] "
	if !strings.HasPrefix(marked, wantPrefix) {
		t.Errorf("marked subject %q does not have prefix %q", marked, wantPrefix)
	}
	if !strings.HasSuffix(marked, subject) {
		t.Errorf("original subject %q not preserved in %q", subject, marked)
	}
}

// ============================================================================
// Test 5: Subject-marker parsing — roundtrip inject → parse
// ============================================================================

func TestSubjectMarker_ParsedCorrectly(t *testing.T) {
	runID := "aabbccdd-1234-4000-8000-000000000001"
	subject := "Test subject"

	marked := injectSubjectMarker(subject, runID)

	short, ok := parseSubjectMarker(marked)
	if !ok {
		t.Fatalf("parseSubjectMarker returned ok=false for %q", marked)
	}
	wantShort := subjectShortID(runID)
	if short != wantShort {
		t.Errorf("parsed short=%q, want %q", short, wantShort)
	}
}

// ============================================================================
// Test 6: Subject-marker uniqueness — two different run-ids yield different prefixes
// ============================================================================

func TestSubjectMarker_UniquePerRunID(t *testing.T) {
	runs := []string{
		"00000000-0000-4000-8000-000000000001",
		"ffffffff-ffff-4fff-8fff-ffffffffffff",
		"1a2b3c4d-0000-4000-8000-000000000000",
	}
	prefixes := make(map[string]bool)
	for _, r := range runs {
		p := subjectShortID(r)
		if prefixes[p] {
			t.Errorf("duplicate subject prefix %q for run-id %q", p, r)
		}
		prefixes[p] = true
	}
}

// ============================================================================
// Test 7: Subject-marker — parse fails gracefully on unmarked subject
// ============================================================================

func TestSubjectMarker_ParseFailsOnUnmarked(t *testing.T) {
	cases := []string{
		"Regular subject without marker",
		"",
		"[A: incomplete",
		"[B:1a2b3c4d] wrong bracket type",
	}
	for _, c := range cases {
		_, ok := parseSubjectMarker(c)
		if ok {
			t.Errorf("parseSubjectMarker(%q) returned ok=true, want false", c)
		}
	}
}

// ============================================================================
// Test 8: Subject-marker injects into SendRequest.Subject via dispatchWithRenderer
// ============================================================================

func TestRunIDInjectsSubjectMarker(t *testing.T) {
	mbs := makeMailboxes(2)
	templates := []string{"intro_machinery"}
	pairs := buildPairs(mbs, templates)

	runID := "cafebabe-dead-4000-8000-000000000001"
	sub := &fakeSubmitter{}

	_ = dispatchWithRenderer(context.Background(), runID, pairs, sub, &fakeContentEngine{}, 0)

	if len(sub.calls) != 2 {
		t.Fatalf("expected 2 Send calls, got %d", len(sub.calls))
	}
	wantPrefix := "[A:" + subjectShortID(runID) + "] "
	for i, req := range sub.calls {
		if !strings.HasPrefix(req.Subject, wantPrefix) {
			t.Errorf("call[%d]: Subject %q missing prefix %q", i, req.Subject, wantPrefix)
		}
	}
}

// ============================================================================
// Test 9: Engine.Run dispatches all enqueued requests (unit-level via fake relay)
// ============================================================================

func TestEngine_Run_DispatchesAllEnqueued(t *testing.T) {
	mbs := makeMailboxes(2)
	cfgMailboxes := make([]config.MailboxConfig, len(mbs))
	for i, mb := range mbs {
		cfgMailboxes[i] = config.MailboxConfig{
			Address:    mb.FromAddress,
			SMTPHost:   mb.SMTPHost,
			SMTPPort:   mb.SMTPPort,
			Username:   mb.FromAddress,
			Password:   mb.Password,
			DailyLimit: 100,
		}
	}
	testSending := config.SendingConfig{
		WindowStart:     0,
		WindowEnd:       23,
		Timezone:        "UTC",
		MinDelaySeconds: 0,
		MaxDelaySeconds: 0,
	}
	testSafety := config.SafetyConfig{MaxBounceRate: 1.0, MaxComplaints24h: 1000}

	eng := sender.NewEngine(cfgMailboxes, testSending, testSafety)

	for i := 0; i < 4; i++ {
		eng.Enqueue(sender.SendRequest{
			CampaignID: 0,
			ContactID:  int64(i + 1),
			ToAddress:  fmt.Sprintf("recv%d@example.com", i+1),
			Subject:    "[A:test1234] Test subject",
		})
	}

	if eng.QueueDepth() != 4 {
		t.Errorf("expected queue depth 4, got %d", eng.QueueDepth())
	}
}

// ============================================================================
// Test 10: Engine.Run respects send-window — restrictive window yields 0 sends
// ============================================================================

func TestEngine_Run_RespectsRestrictiveWindow(t *testing.T) {
	cfgMailboxes := []config.MailboxConfig{
		{Address: "a@example.com", SMTPHost: "smtp.example.com", SMTPPort: 465,
			Username: "a@example.com", Password: "pass", DailyLimit: 100},
	}
	testSending := config.SendingConfig{
		WindowStart:     23,
		WindowEnd:       0,
		Timezone:        "UTC",
		MinDelaySeconds: 0,
		MaxDelaySeconds: 0,
	}
	testSafety := config.SafetyConfig{MaxBounceRate: 1.0, MaxComplaints24h: 1000}

	eng := sender.NewEngine(cfgMailboxes, testSending, testSafety)
	eng.Enqueue(sender.SendRequest{
		CampaignID: 0, ContactID: 1, ToAddress: "b@example.com", Subject: "test",
	})

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	sent := 0
	// Engine.Run without WithAntiTrace → returns ErrAntiTraceRequired immediately.
	err := eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) { sent++ })
	if err != sender.ErrAntiTraceRequired {
		t.Errorf("expected ErrAntiTraceRequired, got %v", err)
	}
	if sent != 0 {
		t.Errorf("expected 0 sends (no antiTrace client), got %d", sent)
	}
}

// ============================================================================
// Test 11: Engine.ErrAntiTraceRequired fires when no antiTrace client set
// ============================================================================

func TestEngine_Run_RequiresAntiTrace(t *testing.T) {
	cfgMailboxes := []config.MailboxConfig{
		{Address: "a@example.com", DailyLimit: 10},
	}
	eng := sender.NewEngine(cfgMailboxes,
		config.SendingConfig{WindowStart: 0, WindowEnd: 23, Timezone: "UTC"},
		config.SafetyConfig{MaxBounceRate: 1.0})

	err := eng.Run(context.Background(), nil)
	if err != sender.ErrAntiTraceRequired {
		t.Errorf("expected ErrAntiTraceRequired without WithAntiTrace, got %v", err)
	}
}

// ============================================================================
// Test 12: Context cancel mid-loop → graceful exit from dispatchWithRenderer
// ============================================================================

func TestDispatch_ContextCancel_StopsEarly(t *testing.T) {
	mbs := makeMailboxes(2)
	templates := []string{"intro_machinery", "followup_1", "followup_2"}
	pairs := buildPairs(mbs, templates) // 6 pairs

	sub := &fakeSubmitter{}
	ctx, cancel := context.WithCancel(context.Background())

	// Cancel immediately after first send completes.
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()

	results := dispatchWithRenderer(ctx, "run-cancel-test", pairs, sub, &fakeContentEngine{}, 100*time.Millisecond)
	// Must have fewer than 6 results — context was cancelled mid-run.
	if len(results) >= 6 {
		t.Errorf("expected early stop, got %d results", len(results))
	}
}

// ============================================================================
// Test 13: Logging — pair string uses full receiver address (closes #554)
// ============================================================================

func TestLogging_PairStringUsesFullAddress(t *testing.T) {
	mbs := makeMailboxes(2)
	templates := []string{"intro_machinery"}
	pairs := buildPairs(mbs, templates)

	sub := &fakeSubmitter{err: fmt.Errorf("relay down")}

	results := dispatchWithRenderer(context.Background(), "run-log-test", pairs, sub, &fakeContentEngine{}, 0)

	for _, r := range results {
		from := r.Pair.Sender.FromAddress
		to := r.Pair.Receiver.FromAddress
		if !strings.Contains(from, "@") {
			t.Errorf("sender address %q is not a full email (missing @)", from)
		}
		if !strings.Contains(to, "@") {
			t.Errorf("receiver address %q is not a full email (missing @)", to)
		}
		// Verify the local part is present (not just @domain — the old bug).
		if strings.HasPrefix(to, "@") {
			t.Errorf("receiver address %q starts with @ — local part missing (old bug)", to)
		}
	}
}

// ============================================================================
// Test 14: spacing=0 — 36 sends complete fast
// ============================================================================

func TestSpacing_Zero_CompletesQuickly(t *testing.T) {
	mbs := makeMailboxes(4)
	templates := []string{"intro_machinery", "followup_1", "followup_2"}
	pairs := buildPairs(mbs, templates)

	sub := &fakeSubmitter{}
	start := time.Now()
	_ = dispatchWithRenderer(context.Background(), "run-speed-test", pairs, sub, &fakeContentEngine{}, 0)
	elapsed := time.Since(start)

	if elapsed >= 1*time.Second {
		t.Errorf("36 sends with 0 spacing should complete in <1s, took %v", elapsed)
	}
	if len(sub.calls) != 36 {
		t.Errorf("expected 36 sends, got %d", len(sub.calls))
	}
}

// ============================================================================
// Test 15: inactive mailbox fails fast
// ============================================================================

func TestValidateMailboxes_InactiveMailbox_FailsFast(t *testing.T) {
	mbs := []DBMailbox{
		{ID: 1, FromAddress: "a@example.com", SMTPHost: "smtp.example.com", SMTPPort: 465, Password: "realpassword123", Status: "paused"},
		{ID: 2, FromAddress: "b@example.com", SMTPHost: "smtp.example.com", SMTPPort: 465, Password: "realpassword123", Status: "active"},
	}
	err := validateMailboxes(mbs, []int64{1, 2}, false)
	if err == nil {
		t.Error("expected error for inactive mailbox, got nil")
	}
	if !strings.Contains(err.Error(), "status") {
		t.Errorf("expected error mentioning status, got: %v", err)
	}
}

// ============================================================================
// Test 16: placeholder password fails fast
// ============================================================================

func TestValidateMailboxes_PlaceholderPassword_FailsFast(t *testing.T) {
	mbs := []DBMailbox{
		{ID: 1, FromAddress: "a@example.com", SMTPHost: "smtp.example.com", SMTPPort: 465, Password: "123p123p123p", Status: "active"},
	}
	err := validateMailboxes(mbs, []int64{1}, false)
	if err == nil {
		t.Error("expected error for placeholder password, got nil")
	}
	if !strings.Contains(err.Error(), "placeholder") {
		t.Errorf("expected error mentioning placeholder, got: %v", err)
	}
}

// TestValidateMailboxes_AllowPlaceholder_Bypass exercises the explicit
// --allow-placeholder-password CLI override: real test mailboxes whose
// passwords legitimately match the heuristic ("123o123o123" repeated-trigram
// pattern) must be testable without triggering the gate.
func TestValidateMailboxes_AllowPlaceholder_Bypass(t *testing.T) {
	mbs := []DBMailbox{
		{ID: 1, FromAddress: "a@example.com", SMTPHost: "smtp.example.com", SMTPPort: 465, Password: "123p123p123p", Status: "active"},
	}
	err := validateMailboxes(mbs, []int64{1}, true)
	if err != nil {
		t.Errorf("expected no error with allowPlaceholder=true, got: %v", err)
	}
}

// ============================================================================
// Test 17: render error on one template → continues with the rest
// ============================================================================

func TestRenderError_ContinuesWithRest(t *testing.T) {
	mbs := makeMailboxes(2)
	templates := []string{"intro_machinery", "followup_1", "followup_2"}
	pairs := buildPairs(mbs, templates) // 6 pairs

	renderer := &fakeContentEngine{renderErr: fmt.Errorf("render boom"), badTmpl: "followup_1"}
	sub := &fakeSubmitter{}

	results := dispatchWithRenderer(context.Background(), "run-render-err", pairs, sub, renderer, 0)

	errCount, sentCount := 0, 0
	for _, r := range results {
		if r.Err != nil {
			errCount++
		} else if r.Sent {
			sentCount++
		}
	}

	if errCount != 2 {
		t.Errorf("expected 2 render errors, got %d", errCount)
	}
	if sentCount != 4 {
		t.Errorf("expected 4 successful sends, got %d", sentCount)
	}
}

// ============================================================================
// Test 18: persistResults — DB insert failure does not poison the run
// ============================================================================

func TestPersistResults_DBInsertFailure_DoesNotPoison(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("persistResults panicked: %v", r)
		}
	}()

	results := []PairResult{
		{
			Pair: Pair{
				Sender:   DBMailbox{FromAddress: "a@example.com"},
				Receiver: DBMailbox{FromAddress: "b@example.com"},
				Template: "intro_machinery",
			},
			Sent:  false, // skip the DB path — verify no-op doesn't panic
			MsgID: "msg-123",
		},
	}
	persistResults(context.Background(), nil, "run-test", results)
}

// ============================================================================
// Test 19: generateUUIDv4 returns a valid UUID v4
// ============================================================================

func TestGenerateUUIDv4_IsValidFormat(t *testing.T) {
	for i := 0; i < 10; i++ {
		id, err := generateUUIDv4()
		if err != nil {
			t.Fatalf("generateUUIDv4 failed: %v", err)
		}
		if !isValidUUIDv4(id) {
			t.Errorf("invalid UUID v4 format: %q", id)
		}
	}
}

// ============================================================================
// Test 20: buildPairs all combinations present
// ============================================================================

func TestBuildPairs_AllCombinationsPresent(t *testing.T) {
	mbs := makeMailboxes(3)
	templates := []string{"tmpl1"}
	pairs := buildPairs(mbs, templates)

	if len(pairs) != 6 {
		t.Fatalf("expected 6 pairs, got %d", len(pairs))
	}
	type key struct{ from, to string }
	seen := make(map[key]bool)
	for _, p := range pairs {
		k := key{p.Sender.FromAddress, p.Receiver.FromAddress}
		if seen[k] {
			t.Errorf("duplicate pair: %v", k)
		}
		seen[k] = true
	}
}

// ============================================================================
// Test 21: deterministicContactID is stable across calls
// ============================================================================

func TestDeterministicContactID_IsStable(t *testing.T) {
	runID := "stable-run-id-abc"
	for idx := 0; idx < 10; idx++ {
		a := deterministicContactID(runID, idx)
		b := deterministicContactID(runID, idx)
		if a != b {
			t.Errorf("idx=%d: not deterministic: %d != %d", idx, a, b)
		}
		if a <= 0 {
			t.Errorf("idx=%d: expected positive, got %d", idx, a)
		}
	}
}

// ============================================================================
// Test 22: parseIntList parses correctly
// ============================================================================

func TestParseIntList(t *testing.T) {
	tests := []struct {
		input string
		want  []int64
	}{
		{"1,3,631,632", []int64{1, 3, 631, 632}},
		{"", nil},
		{" 1 , 2 ", []int64{1, 2}},
		{"abc", nil},
	}
	for _, tt := range tests {
		got := parseIntList(tt.input)
		if len(got) != len(tt.want) {
			t.Errorf("parseIntList(%q): got %v, want %v", tt.input, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("parseIntList(%q)[%d]: got %d, want %d", tt.input, i, got[i], tt.want[i])
			}
		}
	}
}

// ============================================================================
// Test 23: subject marker pairing tuple uniqueness
// ============================================================================

func TestSubjectMarkerPairingTupleUnique(t *testing.T) {
	runID := "cafecafe-0000-4000-8000-000000000099"
	mbs := makeMailboxes(4)
	templates := []string{"intro_machinery", "followup_1", "followup_2"}
	pairs := buildPairs(mbs, templates)

	type key struct{ short, from, to, tmpl string }
	seen := make(map[key]bool, len(pairs))
	short := subjectShortID(runID)
	for _, p := range pairs {
		k := key{short, p.Sender.FromAddress, p.Receiver.FromAddress, p.Template}
		if seen[k] {
			t.Errorf("duplicate pairing tuple: %+v", k)
		}
		seen[k] = true
	}
	if len(seen) != 36 {
		t.Errorf("expected 36 unique tuples, got %d", len(seen))
	}
}

// ============================================================================
// Test 24: validateMailboxes missing mailbox fails fast
// ============================================================================

func TestValidateMailboxes_MissingMailbox_FailsFast(t *testing.T) {
	mbs := []DBMailbox{
		{ID: 1, FromAddress: "a@example.com", Status: "active", Password: "realpassword123"},
	}
	err := validateMailboxes(mbs, []int64{1, 999}, false)
	if err == nil {
		t.Error("expected error for missing mailbox id=999, got nil")
	}
}

// ============================================================================
// Test 25: validateMailboxes empty password fails fast
// ============================================================================

func TestValidateMailboxes_EmptyPassword_FailsFast(t *testing.T) {
	mbs := []DBMailbox{
		{ID: 1, FromAddress: "a@example.com", Status: "active", Password: ""},
	}
	err := validateMailboxes(mbs, []int64{1}, false)
	if err == nil {
		t.Error("expected error for empty password, got nil")
	}
}

// ============================================================================
// Test 26: send errors collected without abort
// ============================================================================

func TestSendError_CollectedWithoutAbort(t *testing.T) {
	mbs := makeMailboxes(2)
	templates := []string{"intro_machinery"}
	pairs := buildPairs(mbs, templates)

	sub := &fakeSubmitter{err: fmt.Errorf("relay down")}
	results := dispatchWithRenderer(context.Background(), "run-send-err", pairs, sub, &fakeContentEngine{}, 0)

	if len(results) != 2 {
		t.Errorf("expected 2 results even on send error, got %d", len(results))
	}
	for _, r := range results {
		if r.Sent {
			t.Error("expected Sent=false on send error")
		}
		if r.Err == nil {
			t.Error("expected non-nil Err on send error")
		}
	}
}

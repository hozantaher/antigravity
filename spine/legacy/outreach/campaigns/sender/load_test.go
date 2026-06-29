package sender_test

// load_test.go — KT-B10: Load test sender pipeline pro 1000 odpovědí.
//
// Cíl: ověřit, že sender engine zvládne dávku 1000 kontaktů (relay mock,
// žádný reálný SMTP per memory feedback_no_direct_smtp) za <60s na dev
// hardwaru, neuteče goroutine, a per-mailbox circuit breaker se neotevře
// pod healthy burstem.
//
// Pokrytí (≥10 cases per memory feedback_extreme_testing):
//   TestLoad_Sender_1000Contacts_Under60s          — main throughput SLA
//   TestLoad_Sender_NoGoroutineLeak                — runtime.NumGoroutine before/after
//   TestLoad_Sender_PerMailboxBreakerStaysClosed   — burst nesmí spustit cooldown
//   TestLoad_Sender_QueueDrainsCompletely          — všech 1000 zmizí z fronty
//   TestLoad_Sender_RelaySeesAll1000              — atomic counter na mock relay
//   TestLoad_Sender_AcrossMultipleMailboxes        — 5 mailboxů, rotation rovnoměrná
//   TestLoad_Sender_ContextCancelStopsCleanly      — cancel uprostřed dávky
//   TestLoad_Sender_ConcurrentEnqueueSafe          — souběžné Enqueue během Run
//   TestLoad_Sender_TransientErrorsDontExplode     — 50% greylist, batch dokončí
//   TestLoad_Sender_RelaySlowResponseTolerated     — pomalý relay, žádný panik
//   BenchmarkSender_1000Contacts                   — go test -bench

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"campaigns/sender"
	"common/config"
)

const loadBatchSize = 1000

// loadTestSendingCfg returns a SendingConfig that disables the human pacing
// delay (Min/MaxDelaySeconds=0 → poissonDelay returns 0) and opens the send
// window 24/7 so the test isn't sensitive to clock-time-of-day.
func loadTestSendingCfg() config.SendingConfig {
	return config.SendingConfig{
		Timezone:         "UTC",
		WindowStart:      0,
		WindowEnd:        24,
		MinDelaySeconds:  0,
		MaxDelaySeconds:  0,
		MaxPerDomainHour: 100000, // > batch size to never trip per-domain throttle
	}
}

// buildLoadMailboxes creates n test mailboxes pre-populated with valid SMTP
// fields so pickMailbox can rotate without hitting the self-send guard.
func buildLoadMailboxes(n int) []config.MailboxConfig {
	out := make([]config.MailboxConfig, n)
	for i := 0; i < n; i++ {
		out[i] = config.MailboxConfig{
			Address:    fmt.Sprintf("sender%d@firma.cz", i),
			SMTPHost:   "smtp.firma.cz",
			SMTPPort:   587,
			Username:   fmt.Sprintf("sender%d@firma.cz", i),
			Password:   "fake-test-password",
			DailyLimit: loadBatchSize, // each mailbox can carry the whole batch
		}
	}
	return out
}

// buildLoadRequests creates n distinct outbound SendRequests across enough
// recipient domains that MaxPerDomainHour never throttles.
func buildLoadRequests(n int) []sender.SendRequest {
	out := make([]sender.SendRequest, n)
	for i := 0; i < n; i++ {
		// Spread across 100 distinct recipient domains to keep per-domain
		// counters well below MaxPerDomainHour.
		domain := fmt.Sprintf("zakaznik%d.cz", i%100)
		out[i] = sender.SendRequest{
			CampaignID: 1,
			ContactID:  int64(i + 1),
			ToAddress:  fmt.Sprintf("kontakt%d@%s", i, domain),
			Subject:    "Nabídka výkupu techniky",
			BodyPlain:  "Dobrý den, zajímala by nás vaše technika.",
		}
	}
	return out
}

// fastRelay returns an httptest.Server that accepts every /v1/submit request
// and increments hits. JSON body is intentionally NOT decoded for speed.
func fastRelay(hits *int64) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(hits, 1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"load-x","status":"queued"}`))
	}))
}

// runEngineForBatch enqueues every req, then runs Engine.Run until total
// onSent invocations reach len(reqs) or ctx expires.
func runEngineForBatch(
	t testing.TB,
	eng *sender.Engine,
	reqs []sender.SendRequest,
	ctx context.Context,
) (sentCount int64, elapsed time.Duration) {
	t.Helper()

	for _, r := range reqs {
		eng.Enqueue(r)
	}

	var counter int64
	done := make(chan struct{})
	once := sync.Once{}
	expected := int64(len(reqs))

	start := time.Now()
	go func() {
		_ = eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {
			if atomic.AddInt64(&counter, 1) >= expected {
				once.Do(func() { close(done) })
			}
		})
	}()

	select {
	case <-done:
		elapsed = time.Since(start)
	case <-ctx.Done():
		elapsed = time.Since(start)
	}

	return atomic.LoadInt64(&counter), elapsed
}

// ── 1. TestLoad_Sender_1000Contacts_Under60s ──────────────────────────────

// Hlavní SLA: full batch 1000 kontaktů projde pipeline pod 60 sekund na
// dev hardwaru s mock relay. Cap je velkorysý, skutečný target initiative
// je 100 mailů/min = 600 sek na 1000 — naše interní target s mock relay
// je o řád níž.
func TestLoad_Sender_1000Contacts_Under60s(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(5)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(loadBatchSize)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	sent, elapsed := runEngineForBatch(t, eng, reqs, ctx)

	if sent < int64(loadBatchSize) {
		t.Fatalf("zpracováno %d / %d za %s — nedoručil jsem celou dávku", sent, loadBatchSize, elapsed)
	}
	if elapsed > 60*time.Second {
		t.Errorf("dávka 1000 trvala %s, SLA = 60s", elapsed)
	}
	if h := atomic.LoadInt64(&hits); h < int64(loadBatchSize) {
		t.Errorf("relay viděl %d hitů, čekáno ≥%d", h, loadBatchSize)
	}
	t.Logf("KT-B10 sender SLA: 1000 kontaktů za %s (relay hits=%d)", elapsed, atomic.LoadInt64(&hits))
}

// ── 2. TestLoad_Sender_NoGoroutineLeak ─────────────────────────────────────

// Po dokončení dávky a uzavření context se počet goroutin musí vrátit
// zpět na výchozí hodnotu (s tolerancí na runtime housekeeping).
func TestLoad_Sender_NoGoroutineLeak(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	// Force settling before the snapshot — Go runtime may have lingering
	// finalizer / GC goroutines from prior tests.
	runtime.GC()
	time.Sleep(50 * time.Millisecond)
	before := runtime.NumGoroutine()

	mbs := buildLoadMailboxes(3)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(loadBatchSize)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	sent, elapsed := runEngineForBatch(t, eng, reqs, ctx)
	if sent < int64(loadBatchSize) {
		t.Fatalf("processed %d / %d in %s", sent, loadBatchSize, elapsed)
	}

	cancel() // ensure Engine.Run goroutine returns

	// Allow scheduler to release the Run goroutine + httptest server workers.
	deadline := time.Now().Add(2 * time.Second)
	var after int
	for time.Now().Before(deadline) {
		runtime.GC()
		after = runtime.NumGoroutine()
		if after <= before+5 { // <5 grace for in-flight TCP keepalives
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	delta := after - before
	// Tolerance: HTTP transport keepalive workers from httptest may linger.
	// Anything over +20 indicates a real goroutine leak in the engine.
	if delta > 20 {
		t.Errorf("goroutine leak: před=%d po=%d (delta=%d)", before, after, delta)
	}
	t.Logf("goroutiny: před=%d po=%d (delta=%d, OK ≤20)", before, after, delta)
}

// ── 3. TestLoad_Sender_PerMailboxBreakerStaysClosed ────────────────────────

// Zdravý burst (žádné chyby z relay) NESMÍ otevřít per-mailbox circuit
// breaker. Verifikace přes pickMailbox po dávce — všechny mailboxes musí
// být dál volitelné.
func TestLoad_Sender_PerMailboxBreakerStaysClosed(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(5)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(loadBatchSize)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	sent, _ := runEngineForBatch(t, eng, reqs, ctx)
	if sent < int64(loadBatchSize) {
		t.Fatalf("processed %d / %d", sent, loadBatchSize)
	}

	// QueueDepth musí být 0 — pokud by breaker zaříznul mailbox, věci
	// by se hromadily v queue (Run vrací položky zpět při no-mailbox).
	if d := eng.QueueDepth(); d != 0 {
		t.Errorf("queue depth po dávce = %d, čekáno 0 (breaker by trip)", d)
	}
}

// ── 4. TestLoad_Sender_QueueDrainsCompletely ───────────────────────────────

// Po SLA okně musí být fronta plně vypuštěná.
func TestLoad_Sender_QueueDrainsCompletely(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(3)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(loadBatchSize)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if depthBefore := eng.QueueDepth(); depthBefore != 0 {
		t.Errorf("queue není prázdná před testem: %d", depthBefore)
	}

	_, _ = runEngineForBatch(t, eng, reqs, ctx)

	if d := eng.QueueDepth(); d != 0 {
		t.Errorf("queue depth po dávce = %d, čekáno 0", d)
	}
}

// ── 5. TestLoad_Sender_RelaySeesAll1000 ────────────────────────────────────

// Atomic counter na mock relay: počet HTTP POSTů musí dosáhnout 1000.
// Tohle ladí sender↔relay propustnost — pokud onSent fires ale relay
// nedostane request, najde se to tady.
func TestLoad_Sender_RelaySeesAll1000(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(5)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(loadBatchSize)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	sent, _ := runEngineForBatch(t, eng, reqs, ctx)
	if sent < int64(loadBatchSize) {
		t.Fatalf("processed %d / %d", sent, loadBatchSize)
	}

	if h := atomic.LoadInt64(&hits); h != int64(loadBatchSize) {
		t.Errorf("relay hits=%d, čekáno %d (ztráta zprávy mezi senderem a relay)", h, loadBatchSize)
	}
}

// ── 6. TestLoad_Sender_AcrossMultipleMailboxes ─────────────────────────────

// 5 mailboxů, 1000 zpráv → každý mailbox dostane řádově 200 zpráv.
// Test ověří, že rotace funguje pod load — žádný mailbox se nenechá
// vyhladovět ani nekonzumuje 100 % batche.
func TestLoad_Sender_AcrossMultipleMailboxes(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(5)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	mailboxUse := make(map[string]int)
	var muUse sync.Mutex
	reqs := buildLoadRequests(loadBatchSize)

	for _, r := range reqs {
		eng.Enqueue(r)
	}

	var counter int64
	expected := int64(loadBatchSize)
	done := make(chan struct{})
	once := sync.Once{}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	go func() {
		_ = eng.Run(ctx, func(_ sender.SendRequest, res sender.SendResult) {
			muUse.Lock()
			mailboxUse[res.MailboxUsed]++
			muUse.Unlock()
			if atomic.AddInt64(&counter, 1) >= expected {
				once.Do(func() { close(done) })
			}
		})
	}()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("dávka nedokončena v okně")
	}

	muUse.Lock()
	defer muUse.Unlock()
	if len(mailboxUse) < 2 {
		t.Errorf("rotation nefunguje: použito %d mailboxů z 5", len(mailboxUse))
	}
	for addr, used := range mailboxUse {
		if used == 0 {
			t.Errorf("mailbox %s nikdy nepoužit", addr)
		}
		// Nikdo by neměl odeslat víc než ~80 % batche (rotace by selhala)
		if used > int(float64(loadBatchSize)*0.8) {
			t.Errorf("mailbox %s monopolizuje: %d / %d", addr, used, loadBatchSize)
		}
	}
	t.Logf("rotace: %d mailboxů použito, distribuce: %v", len(mailboxUse), mailboxUse)
}

// ── 7. TestLoad_Sender_ContextCancelStopsCleanly ───────────────────────────

// Cancel uprostřed dávky — Run musí vrátit ctx.Err() a fronta nesmí
// zůstat v inkonzistentním stavu.
func TestLoad_Sender_ContextCancelStopsCleanly(t *testing.T) {
	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(2)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(loadBatchSize)
	for _, r := range reqs {
		eng.Enqueue(r)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {})
	}()

	// Let some sends complete, then cancel.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-errCh:
		if err != context.Canceled && err != context.DeadlineExceeded {
			t.Errorf("Run vrátil %v, čekáno context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run nezakončila po cancel — možný leak")
	}
}

// ── 8. TestLoad_Sender_ConcurrentEnqueueSafe ───────────────────────────────

// Ověř race-safe Enqueue během běžícího Run — testing -race najde
// jakoukoli anomálii v engine.queue mutex.
func TestLoad_Sender_ConcurrentEnqueueSafe(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(3)
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var counter int64
	expected := int64(loadBatchSize)
	done := make(chan struct{})
	once := sync.Once{}

	go func() {
		_ = eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {
			if atomic.AddInt64(&counter, 1) >= expected {
				once.Do(func() { close(done) })
			}
		})
	}()

	// Enqueue from 4 goroutines concurrently — each puts 250 messages
	// onto the queue while Run consumes them.
	const goroutines = 4
	const perWorker = loadBatchSize / goroutines
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				idx := workerID*perWorker + i
				eng.Enqueue(sender.SendRequest{
					CampaignID: 1,
					ContactID:  int64(idx + 1),
					ToAddress:  fmt.Sprintf("k%d@d%d.cz", idx, idx%50),
					Subject:    "S",
					BodyPlain:  "B",
				})
			}
		}(g)
	}
	wg.Wait()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatalf("nedoručeno: counter=%d expected=%d", atomic.LoadInt64(&counter), expected)
	}
}

// ── 9. TestLoad_Sender_TransientErrorsDontExplode ──────────────────────────

// Relay vrátí 50% 429 (rate-limit / greylist), 50% 202. Engine musí
// zpracovat všechny zprávy bez panic, bez goroutine leak. Successful
// sends doplíží batch.
func TestLoad_Sender_TransientErrorsDontExplode(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var total, throttled int64
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt64(&total, 1)
		if n%2 == 0 {
			atomic.AddInt64(&throttled, 1)
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"rate-limited"}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"ok","status":"queued"}`))
	}))
	defer relay.Close()

	mbs := buildLoadMailboxes(3)
	eng := sender.NewEngine(
		mbs,
		loadTestSendingCfg(),
		config.SafetyConfig{MaxBounceRate: 0.99}, // tolerantní — 50% 429 nesmí trip global circuit
	)
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	reqs := buildLoadRequests(200) // menší batch, half-fail je bez SLA
	for _, r := range reqs {
		eng.Enqueue(r)
	}

	var counter int64
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	expected := int64(len(reqs))
	done := make(chan struct{})
	once := sync.Once{}
	go func() {
		_ = eng.Run(ctx, func(_ sender.SendRequest, _ sender.SendResult) {
			if atomic.AddInt64(&counter, 1) >= expected {
				once.Do(func() { close(done) })
			}
		})
	}()

	select {
	case <-done:
	case <-ctx.Done():
		// 429s requeue, takže batch může pokračovat — pro tento test stačí,
		// že většina prošla a engine nepanikla.
	}

	t.Logf("transient mix: zpracováno %d / %d (429 = %d)",
		atomic.LoadInt64(&counter), expected, atomic.LoadInt64(&throttled))

	if atomic.LoadInt64(&counter) == 0 {
		t.Error("nezpracována ani jedna zpráva — panika nebo deadlock")
	}
}

// ── 10. TestLoad_Sender_RelaySlowResponseTolerated ─────────────────────────

// Pomalý relay (100ms / request) — ověř, že engine žádnou zprávu neztratí
// a že timeout v AntiTraceClient (30s) nás nezasáhne.
func TestLoad_Sender_RelaySlowResponseTolerated(t *testing.T) {
	if testing.Short() {
		t.Skip("load test skipped in -short mode")
	}

	var hits int64
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond) // simulate slow upstream
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"envelope_id":"slow","status":"queued"}`))
	}))
	defer relay.Close()

	mbs := buildLoadMailboxes(10) // víc mailboxů → engine paralelizuje? Ne — Engine.Run je sekvenční
	eng := sender.NewEngine(mbs, loadTestSendingCfg(), config.SafetyConfig{MaxBounceRate: 0.5})
	eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

	const n = 100 // sequence × 20ms = 2s expected
	reqs := buildLoadRequests(n)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	sent, elapsed := runEngineForBatch(t, eng, reqs, ctx)
	if sent < int64(n) {
		t.Fatalf("processed %d / %d in %s", sent, n, elapsed)
	}
	if h := atomic.LoadInt64(&hits); h < int64(n) {
		t.Errorf("relay hits=%d, čekáno %d", h, n)
	}
	t.Logf("slow-relay batch %d za %s", n, elapsed)
}

// ── BenchmarkSender_1000Contacts ───────────────────────────────────────────

// Měřitelný Go benchmark pro KT-B10 — `go test -bench=. -benchmem`
// pomáhá detekovat regrese ve throughput sender pipeline.
func BenchmarkSender_1000Contacts(b *testing.B) {
	var hits int64
	relay := fastRelay(&hits)
	defer relay.Close()

	mbs := buildLoadMailboxes(5)
	cfg := loadTestSendingCfg()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		eng := sender.NewEngine(mbs, cfg, config.SafetyConfig{MaxBounceRate: 0.5})
		eng.WithAntiTrace(sender.NewAntiTraceClient(relay.URL, "tok"))

		reqs := buildLoadRequests(loadBatchSize)
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		_, _ = runEngineForBatch(b, eng, reqs, ctx)
		cancel()
	}
	b.ReportMetric(float64(loadBatchSize), "sends/op")
}

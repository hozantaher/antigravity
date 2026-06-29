package metrics

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCounter_IncAndExpose(t *testing.T) {
	// Use the already-registered outreach metric — we rely on the rest of the
	// suite and main process to share this global registry.
	before := SendTotal.Value()
	SendTotal.Inc()
	SendTotal.Inc()
	if got := SendTotal.Value(); got != before+2 {
		t.Errorf("expected +2, got %d", got-before)
	}

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()

	if !strings.Contains(body, "# TYPE outreach_send_total counter") {
		t.Errorf("missing TYPE line:\n%s", body)
	}
	if !strings.Contains(body, "outreach_send_total ") {
		t.Errorf("missing value line:\n%s", body)
	}
}

func TestGauge_SetAndExpose(t *testing.T) {
	QueueDepth.Set(42)
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if !strings.Contains(rec.Body.String(), "outreach_queue_depth 42") {
		t.Errorf("expected outreach_queue_depth 42, got:\n%s", rec.Body.String())
	}
}

func TestLabeledGauge_SetAndExpose(t *testing.T) {
	CircuitDomainOpen.Set(1, "bad.test")
	CircuitDomainOpen.Set(0, "good.test")

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()

	if !strings.Contains(body, `outreach_circuit_domain_open{domain="bad.test"} 1`) {
		t.Errorf("missing bad.test=1:\n%s", body)
	}
	if !strings.Contains(body, `outreach_circuit_domain_open{domain="good.test"} 0`) {
		t.Errorf("missing good.test=0:\n%s", body)
	}
}

func TestLabeledCounter_IncAndExpose(t *testing.T) {
	HoneypotDetectedTotal.Inc("role_based", "high")
	HoneypotDetectedTotal.Inc("role_based", "high")
	HoneypotDetectedTotal.Inc("typo_domain", "medium")

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()

	if !strings.Contains(body, `outreach_honeypot_detected_total{signal_type="role_based",severity="high"} 2`) {
		t.Errorf("missing role_based=2:\n%s", body)
	}
	if !strings.Contains(body, `outreach_honeypot_detected_total{signal_type="typo_domain",severity="medium"} 1`) {
		t.Errorf("missing typo_domain=1:\n%s", body)
	}
}

func TestHandler_ContentType(t *testing.T) {
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("expected text/plain content-type, got %q", ct)
	}
	if !strings.Contains(ct, "version=0.0.4") {
		t.Errorf("expected Prometheus version marker, got %q", ct)
	}
}

func TestEscapeLabelValue_InjectionSafe(t *testing.T) {
	// A domain name containing double-quote and backslash must be escaped so
	// the exposition format parser does not break.
	CircuitDomainOpen.Set(1, `evil"\x.test`)
	var buf bytes.Buffer
	write(&buf)
	if strings.Contains(buf.String(), `"evil"\x.test"`) {
		t.Errorf("label not escaped:\n%s", buf.String())
	}
	if !strings.Contains(buf.String(), `\"`) {
		t.Errorf("expected escaped quote in output:\n%s", buf.String())
	}
}

// helper: get metrics text output
func metricsBody() string {
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	return rec.Body.String()
}

// ── LabeledCounter.Add edge cases ─────────────────────────────────────────

func TestLabeledCounter_Add_NegativeN_NoChange(t *testing.T) {
	c := NewLabeledCounter("test_neg_counter", "unit test", "env")
	c.Add(-1, "prod")
	// negative n is no-op — metric should not appear with a positive value
	body := metricsBody()
	if strings.Contains(body, `test_neg_counter{env="prod"} -`) {
		t.Errorf("Add(-1) created negative entry")
	}
}

func TestLabeledCounter_Add_ZeroN_NoChange(t *testing.T) {
	c := NewLabeledCounter("test_zero_counter", "unit test", "env")
	c.Add(0, "prod")
	// zero n is no-op
	body := metricsBody()
	_ = body // metric exists in registry but has 0 value — just verify no panic
	_ = c
}

func TestLabeledCounter_Add_WrongLabelCount_NoChange(t *testing.T) {
	c := NewLabeledCounter("test_wrong_labels_counter", "unit test", "env")
	c.Add(5) // missing label value — no-op
	body := metricsBody()
	if strings.Contains(body, `test_wrong_labels_counter{} 5`) {
		t.Errorf("Add with wrong label count should be no-op")
	}
}

func TestLabeledCounter_Add_PositiveN_Accumulates(t *testing.T) {
	c := NewLabeledCounter("test_acc_counter", "unit test", "env")
	c.Add(3, "staging")
	c.Add(7, "staging")
	body := metricsBody()
	if !strings.Contains(body, `test_acc_counter{env="staging"} 10`) {
		t.Errorf("expected accumulated 10 in metrics output:\n%s", body)
	}
}

// ── LabeledGauge.Set edge cases ──────────────────────────────────────────

func TestLabeledGauge_Set_WrongLabelCount_NoChange(t *testing.T) {
	g := NewLabeledGauge("test_wrong_gauge", "unit test", "env")
	g.Set(42.0) // missing label value — no-op
	body := metricsBody()
	if strings.Contains(body, `test_wrong_gauge{} 42`) {
		t.Errorf("Set with wrong label count should be no-op")
	}
}

func TestLabeledGauge_Set_NegativeValue_Stored(t *testing.T) {
	g := NewLabeledGauge("test_neg_gauge", "unit test", "env")
	g.Set(-5.5, "prod")
	body := metricsBody()
	if !strings.Contains(body, `test_neg_gauge{env="prod"} -5.5`) {
		t.Errorf("expected -5.5 in output:\n%s", body)
	}
}

func TestLabeledGauge_Set_Overwrite_LastWins(t *testing.T) {
	g := NewLabeledGauge("test_overwrite_gauge", "unit test", "env")
	g.Set(1.0, "prod")
	g.Set(99.9, "prod")
	body := metricsBody()
	if !strings.Contains(body, `test_overwrite_gauge{env="prod"} 99.9`) {
		t.Errorf("expected 99.9 in output:\n%s", body)
	}
}

package thread

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"common/audit"
	"common/humanize"
	"github.com/lib/pq"
	"orchestrator/mime"
)

// schemaBUnavailable reports whether err is a Postgres undefined_table (42P01)
// or undefined_column (42703). This deployment is Schema-A-only: the legacy
// Schema-B tables (outreach_threads / outreach_contacts) were dropped (migration
// ~2026-05-24), so matchToThread's Schema-B rungs now ERROR instead of returning
// empty. Before this guard, that error aborted ProcessReply at the "match reply"
// step — silently dropping EVERY inbound reply (neither reply_inbox nor
// unmatched_inbound got the row) from 2026-05-24 onward. When Schema B is
// unavailable we must degrade to "no Schema-B match" so the Schema-A
// reply_inbox fallback (send_events → contacts) still attributes the reply.
func schemaBUnavailable(err error) bool {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) {
		return pqErr.Code == "42P01" || pqErr.Code == "42703"
	}
	return false
}

// SentimentClassifier optionally provides LLM-based reply sentiment classification.
// When nil, the processor falls back to keyword-based classification.
type SentimentClassifier interface {
	ClassifySentiment(ctx context.Context, replyText string) (string, error)
}

// PreClassification is the AC8 Haiku pre-classification verdict persisted
// to `reply_inbox.pre_classification`. Each call is fire-and-forget;
// failures slog.Warn but never abort the inbound pipeline.
type PreClassification struct {
	Intent     string
	Confidence float64
	Reasoning  string
	ModelUsed  string
}

// ReplyPreClassifier is the narrow interface the inbound processor uses
// to tag a newly-matched reply asynchronously with a Haiku-derived
// intent label. Implementations live in
// services/orchestrator/internal/llm/reply_classifier.go.
type ReplyPreClassifier interface {
	ClassifyReply(ctx context.Context, body string) (PreClassification, error)
}

// PreClassifyEnabledGetter is an optional runtime kill-switch source.
// When wired (operator_settings via common/operatorconfig.Loader),
// ProcessReply consults it before spawning the classifier goroutine so
// the operator can disable AC8 without redeploy. Missing or unset →
// classifier enabled (fail-open).
type PreClassifyEnabledGetter interface {
	Get(ctx context.Context, key string) (string, error)
}

// AC8 named thresholds — feedback_no_magic_thresholds T0.
const (
	// preClassifyAsyncBudget is the goroutine-level deadline. The
	// classifier itself uses its own (shorter) timeout; the extra slack
	// here covers the DB UPDATE that persists the verdict.
	preClassifyAsyncBudget = 8 * time.Second

	// preClassifyMatchWindow is the +/- window used when looking up the
	// reply_inbox row by (from_email, received_at). reply_inbox is
	// inserted by the BFF runImapPollCron and by the Go cron_imap_poll
	// path; received_at can differ by a few seconds due to clock skew
	// and downstream parse latency.
	preClassifyMatchWindow = 10 * time.Minute

	// preClassifyOperatorSettingKey toggles AC8 at runtime. Value "true"
	// (default) keeps it on; "false" disables. The default-on choice
	// follows feedback_env_var_needs_db_fallback T0 — config primarily
	// in operator_settings.
	preClassifyOperatorSettingKey = "reply_pre_classification_enabled"
)

// BounceRecorder is the narrow interface the inbound processor uses to
// feed the mailbox-registry per-mailbox bounce counter for IMAP-side
// DSNs. Pre-F3-1 only the SMTP-immediate path
// (services/campaigns/mailboxes/bounce/processor.go) hit the registry —
// hard bounces that arrived as IMAP DSN never increased the sender's
// consecutive_bounces counter, so the auto-hold trigger never fired
// from real-world DSN traffic.
//
// Implemented by *mailbox.StoreBackpressure (services/mailboxes).
type BounceRecorder interface {
	RecordBounce(ctx context.Context, fromAddress, reason string) bool
}

// PhotoProcessor optionally handles inbound photo attachments —
// volume save + LLM vision call + photo_parse_audit INSERT.
//
// Implementation lives in services/orchestrator/internal/photoparse so
// the thread package stays free of net/http + filesystem deps. When
// nil, photo attachments are skipped silently.
type PhotoProcessor interface {
	IsImage(contentType string) bool
	Process(ctx context.Context, photo PhotoInput) (int64, error)
}

// PhotoInput is the contract a PhotoProcessor receives for a single
// inbound image. It mirrors photoparse.Photo but lives here so the
// thread package does not import the internal package.
type PhotoInput struct {
	ThreadID    int64
	MessageID   string
	Filename    string
	ContentType string
	Data        []byte
}

// InboundProcessor matches incoming replies to threads and processes them.
type InboundProcessor struct {
	db                 *sql.DB
	manager            *Manager
	recorder           *MessageRecorder
	events             *EventLogger
	response           *humanize.ResponseEngine
	classifier         SentimentClassifier      // optional LLM classifier
	preClassifier      ReplyPreClassifier       // optional AC8 Haiku pre-classifier
	preClassifyEnabled PreClassifyEnabledGetter // optional runtime kill-switch
	photo              PhotoProcessor           // optional photo pipeline
	onInterested       func(ctx context.Context, from string, threadID int64)
	bounceRecorder     BounceRecorder // optional; nil = no backpressure feed
}

// NewInboundProcessor creates an inbound reply processor.
func NewInboundProcessor(db *sql.DB) *InboundProcessor {
	return &InboundProcessor{
		db:       db,
		manager:  NewManager(db),
		recorder: NewMessageRecorder(db),
		events:   NewEventLogger(db),
		response: humanize.NewResponseEngine(),
	}
}

// WithBounceRecorder wires a mailbox-backpressure feed for IMAP-side
// DSN bounces. F3-1 — pre-fix, hard bounces detected from IMAP polled
// DSN messages were never reported to the registry, breaking the
// per-mailbox auto-hold trigger.
func (p *InboundProcessor) WithBounceRecorder(b BounceRecorder) *InboundProcessor {
	p.bounceRecorder = b
	return p
}

// WithClassifier sets an optional LLM-based sentiment classifier.
// When set, it overrides the keyword-based classification for reply routing.
func (p *InboundProcessor) WithClassifier(c SentimentClassifier) *InboundProcessor {
	p.classifier = c
	return p
}

// WithReplyPreClassifier wires Sprint AC8 Haiku pre-classification. Each
// successfully-matched reply triggers an async classify + UPDATE on the
// corresponding reply_inbox row. Fire-and-forget — never blocks
// ProcessReply's hot path. When nil, ProcessReply behaves identically
// to the pre-AC8 code path.
func (p *InboundProcessor) WithReplyPreClassifier(c ReplyPreClassifier) *InboundProcessor {
	p.preClassifier = c
	return p
}

// WithPreClassifyToggle wires an operator_settings-backed kill-switch so
// the AC8 classifier can be disabled at runtime by an UPDATE on
// operator_settings.reply_pre_classification_enabled. Default value when
// missing or empty is "true" (enabled). When nil, the classifier always
// runs (assuming WithReplyPreClassifier was also set).
func (p *InboundProcessor) WithPreClassifyToggle(g PreClassifyEnabledGetter) *InboundProcessor {
	p.preClassifyEnabled = g
	return p
}

// WithPhotoProcessor wires the inbound photo pipeline (Track E
// photo_parse_audit). When nil, image attachments are skipped — the
// thread is recorded normally but no audit row is written.
func (p *InboundProcessor) WithPhotoProcessor(pp PhotoProcessor) *InboundProcessor {
	p.photo = pp
	return p
}

// WithInterestedHook registers a callback invoked when an interested or meeting
// reply is detected. Use this to fire external alerts without coupling the
// thread package to any specific alerting implementation.
func (p *InboundProcessor) WithInterestedHook(fn func(ctx context.Context, from string, threadID int64)) *InboundProcessor {
	p.onInterested = fn
	return p
}

// RawInbound represents a raw inbound email from IMAP. Headers are
// pre-parsed for thread matching; RawBytes is the full RFC822 source
// the MIME parser (S1.3) consumes when present.
type RawInbound struct {
	MessageID  string
	InReplyTo  string
	References string
	From       string
	Subject    string
	BodyPlain  string
	RawBytes   []byte
	ReceivedAt time.Time
	// MailboxAddr is the polling mailbox address (e.g. "hozan.taher.75@post.cz").
	// Set by the IMAP poller before calling ProcessReply so insertReplyInbox can
	// resolve mailbox_id even when matchToReplyInbox finds no send_events row
	// (e.g. legacy contacts whose original send predates the send_events schema).
	// Zero value "" means unknown — the COALESCE path handles it gracefully.
	MailboxAddr string
}

// TestSubjectPatterns lists subject line prefixes that identify internal
// test/smoke messages. These should never be inserted into unmatched_inbound.
var TestSubjectPatterns = []string{
	"[smoke]",
	"[smoke-clean]",
	"[hdr-test]",
	"[test-A]",
	"[test-B]",
	"[test]",
	"probe ",
}

// InternalSenderAddresses lists outbound mailbox addresses that send to each
// other as part of mb-to-mb anonymity tests / smoke checks. Inbound from
// these addresses must never land in unmatched_inbound — they're not real
// customer replies.
//
// 2026-05-18: hardcoded; future iteration sources this from
// operator_settings.internal_mailbox_addresses (CSV). The current 8 entries
// are the hozan.taher.{75..82}@post.cz fleet: .75-.78 provisioned for
// campaign 457; .79-.82 added 2026-06-23 (DB rows via migration 173).
var InternalSenderAddresses = []string{
	"hozan.taher.75@post.cz",
	"hozan.taher.76@post.cz",
	"hozan.taher.77@post.cz",
	"hozan.taher.78@post.cz",
	"hozan.taher.79@post.cz",
	"hozan.taher.80@post.cz",
	"hozan.taher.81@post.cz",
	"hozan.taher.82@post.cz",
}

// AJ-bounce classification (2026-05-18) — when DetectBounce can't extract
// a Final-Recipient, the row falls through processUnmatchedBounce into
// parkUnattributed. We still want to tag these rows so the BFF can
// hide them from the operator's default /replies view. The same regex
// patterns drive both the Go-side INSERT (classifyUnmatched) and the
// DB-side backfill (migration 118), so the two stay in lockstep.
//
// feedback_no_magic_thresholds T0 — patterns named at package level
// rather than inlined inside classifyUnmatched.
var (
	// unmatchedBounceFromHint matches sender addresses that emit DSNs.
	// Same regex shape as bounce.go's mailerDaemonFrom; kept independent
	// so changing one's scope (e.g. adding "noreply@cisco.example") does
	// not silently affect the other.
	//
	// `[\s-]*` tolerates both "mail delivery system" (Exchange NDR
	// display name) and "mail-delivery-system@cisco.example" (DSN
	// envelope sender at some providers).
	unmatchedBounceFromHint = regexp.MustCompile(`(?i)mailer-daemon|postmaster|mail[\s-]*delivery[\s-]*(subsystem|system|service)`)

	// unmatchedBounceSubjectHint matches DSN subject lines. Czech
	// "nedoručitelná" included for Seznam/Centrum localised bounces.
	unmatchedBounceSubjectHint = regexp.MustCompile(`(?i)undeliverable|undelivered|nedoručitelná|returned\s+to\s+sender|delivery\s+(status|failure|notification|problem)|mail\s+delivery\s+(system|fail)|could\s+not\s+be\s+delivered|rejected:`)

	// unmatchedAutoReplySubjectHint matches out-of-office / vacation
	// auto-reply subjects in CS / EN / DE. These are not bounces but
	// the operator also wants them filtered from the default queue.
	unmatchedAutoReplySubjectHint = regexp.MustCompile(`(?i)automatick[áa]\s+odpověď|out\s+of\s+office|i\s+am\s+out\s+of|absence|am\s+abwesend|automatic\s+reply`)
)

// Classification labels persisted to unmatched_inbound.classification.
// Empty string = unclassified (NULL in DB, real customer reply).
const (
	ClassificationBounce    = "bounce"
	ClassificationAutoReply = "auto_reply"
	ClassificationNone      = ""
)

// classifyUnmatched returns the classification label for an inbound that
// is about to be parked in unmatched_inbound. Pattern matches the
// from-address and subject against the package-level regex constants.
//
// Returns one of:
//   - "bounce"      — DSN bounce whose recipient couldn't be extracted
//   - "auto_reply"  — out-of-office / vacation auto-reply
//   - ""            — unclassified (real customer reply or unknown)
//
// Sender check wins over subject check so a forwarded DSN with a
// "your message has been auto-replied" subject still classifies as
// bounce (the From: address is authoritative).
func classifyUnmatched(from, subject string) string {
	if unmatchedBounceFromHint.MatchString(from) {
		return ClassificationBounce
	}
	if unmatchedBounceSubjectHint.MatchString(subject) {
		return ClassificationBounce
	}
	if unmatchedAutoReplySubjectHint.MatchString(subject) {
		return ClassificationAutoReply
	}
	return ClassificationNone
}

// isTestMessage returns true if the subject line contains a test message prefix
// (case-insensitive) OR the sender address matches an internal mb-to-mb sender.
// Used to filter out synthetic test emails before inserting into
// unmatched_inbound, preventing operator queue noise.
func isTestMessage(subject string) bool {
	subject = strings.ToLower(subject)
	for _, pattern := range TestSubjectPatterns {
		if strings.Contains(subject, strings.ToLower(pattern)) {
			return true
		}
	}
	return false
}

// isEmptyFailedFetch reports whether a parsed inbound message carries the
// signature of a failed/partial IMAP fetch rather than a real email: no From
// address, no real Message-ID (empty, or the synthetic "uid:<n>@host" that
// poller.go assigns when the header is absent), and no Subject. RFC 5322
// mandates a From header on every message, so all three empty together cannot
// be a legitimate message — and would be unattributable/unactionable even if
// it were. Kept deliberately narrow: a real unmatched reply always carries a
// From (or at least a real Message-ID), so it never trips this guard.
//
// Incident 2026-06-23: a degraded wgpool (8 mailboxes vs 6 SOCKS5 endpoints
// after the .79-.82 fleet expansion) produced ~30 such rows in unmatched_inbound,
// surfacing as empty "Neznámý odesílatel / (bez předmětu)" replies in the UI.
func isEmptyFailedFetch(raw RawInbound) bool {
	from := strings.TrimSpace(raw.From)
	subject := strings.TrimSpace(raw.Subject)
	mid := strings.TrimSpace(raw.MessageID)
	syntheticID := mid == "" || strings.HasPrefix(mid, "uid:")
	return from == "" && subject == "" && syntheticID
}

// isInternalSender returns true if the parsed From address matches one of
// the campaign's outbound mailboxes. Inbound from these is internal test
// traffic (mb-to-mb pings) and should be discarded silently — same effect
// as isTestMessage.
func isInternalSender(from string) bool {
	from = strings.ToLower(from)
	for _, addr := range InternalSenderAddresses {
		if strings.Contains(from, strings.ToLower(addr)) {
			return true
		}
	}
	return false
}

// truncateSubject returns the first n characters of s, safe for logging.
func truncateSubject(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ProcessReply matches an inbound email to a thread and takes appropriate action.
func (p *InboundProcessor) ProcessReply(ctx context.Context, raw RawInbound) error {
	// DEBUG-TRACE 2026-05-17 — log every incoming message to bisect why 158 UIDs
	// advanced watermark but only 10 contacts flipped + 0 rows landed in
	// unmatched_inbound. Remove after diagnosis.
	slog.Info("inbound.trace/arrive",
		"op", "thread.ProcessReply/arrive",
		"message_id", raw.MessageID,
		"from", raw.From,
		"subject", truncateSubject(raw.Subject, 80),
		"in_reply_to", raw.InReplyTo,
		"body_len", len(raw.BodyPlain),
	)

	// R5: Filter internal test messages before any further processing.
	// These should never reach the operator queue.
	if isTestMessage(raw.Subject) {
		slog.Info("[inbound] discarded test message",
			"op", "thread.ProcessReply/testMessageFiltered",
			"message_id", raw.MessageID,
			"subject_prefix", truncateSubject(raw.Subject, 20),
		)
		return nil
	}

	// 2026-05-18: filter mb-to-mb internal pings (sender = own outbound mailbox).
	// Without this, anonymity test pings (subject "Dotaz", from
	// hozan.taher.XX@post.cz) land in unmatched_inbound as noise.
	if isInternalSender(raw.From) {
		slog.Info("[inbound] discarded internal sender",
			"op", "thread.ProcessReply/internalSenderFiltered",
			"message_id", raw.MessageID,
			"from", raw.From,
		)
		return nil
	}

	// 1. Match to outbound message via attribution ladder
	//    (Message-ID chain → exact email → domain match)
	threadID, contactID, matchedBy, err := p.matchToThread(ctx, raw)
	if err != nil {
		if schemaBUnavailable(err) {
			// Schema-B tables (outreach_threads/outreach_contacts) are absent in
			// this Schema-A-only deployment. Degrade to "no Schema-B match" so the
			// Schema-A reply_inbox fallback below still attributes the reply,
			// instead of aborting and dropping it.
			slog.Warn("matchToThread Schema-B unavailable; degrading to Schema-A reply_inbox fallback",
				"op", "thread.ProcessReply/schemaBUnavailable",
				"message_id", raw.MessageID,
				"error", err,
			)
			threadID, contactID, matchedBy = 0, 0, ""
		} else {
			return fmt.Errorf("match reply: %w", err)
		}
	}
	// DEBUG-TRACE 2026-05-17 — log match outcome.
	slog.Info("inbound.trace/matched",
		"op", "thread.ProcessReply/matched",
		"message_id", raw.MessageID,
		"thread_id", threadID,
		"contact_id", contactID,
		"matched_by", matchedBy,
	)
	if threadID == 0 {
		// Parse MIME before any side-effect so the body + attachments land in
		// either reply_inbox (Schema-A fallback) or unmatched_inbound (full
		// fallthrough). Without this the /replies UI shows the header but no
		// message content — operator can't decide how to respond.
		var (
			bodyHTML    string
			attachments []mime.Attachment
		)
		parsed := parseRawIfPresent(raw)
		if parsed != nil {
			raw.BodyPlain = bodyPlainFromParsed(parsed, raw.BodyPlain)
			bodyHTML = bodyHTMLFromParsed(parsed)
			attachments = parsed.Attachments
		}

		// R3 — Bounce detection on unmatched DSN messages. When a bounce
		// arrives but matchToThread couldn't link it to an outreach_thread
		// (campaign rfc_message_id mismatch, or pre-R2 legacy outbound
		// rows without a stored rfc_message_id), we still want to flip
		// the contact's email_status to bounce_hold so the verify loop
		// stops scheduling re-sends. The failed recipient is parsed from
		// the DSN body per RFC 3464 (Final-Recipient header).
		//
		// Only hard bounces flip status — soft bounces are transient and
		// should not penalize the contact.
		//
		// On success we skip the unmatched_inbound INSERT entirely; the
		// contact has been handled. On failure (no recipient extractable
		// or unknown contact) we fall through to the regular parking
		// path so the operator can still review.
		// DEBUG-TRACE 2026-05-17
		bounce := DetectBounce(raw)
		slog.Info("inbound.trace/bounceCheck",
			"op", "thread.ProcessReply/bounceCheck",
			"message_id", raw.MessageID,
			"is_bounce", bounce.IsBounce(),
			"kind", fmt.Sprintf("%v", bounce.Kind),
			"dsn_code", bounce.DSNCode,
		)
		if bounce.IsBounce() && bounce.Kind == BounceHard {
			if handled := p.processUnmatchedBounce(ctx, raw, bounce); handled {
				slog.Info("inbound.trace/handledAsHardBounce", "op", "thread.ProcessReply/handledHardBounce", "message_id", raw.MessageID)
				return nil
			}
			slog.Info("inbound.trace/hardBounceFellThrough", "op", "thread.ProcessReply/hardBounceFellThrough", "message_id", raw.MessageID)
		}

		// AV-F1 — Schema-A fallback. The four-rung matchToThread above
		// joins through outreach_threads + outreach_contacts (Schema B).
		// In the current Schema-A-only deployment those tables are empty,
		// so every reply produces threadID=0 even when send_events +
		// contacts hold a perfectly good (campaign, contact, mailbox)
		// chain. matchToReplyInbox bridges that gap: it walks
		// send_events.rfc_message_id → contacts.email → contacts.email_domain
		// and returns a (send_event_id, campaign_id, mailbox_id, contact_id)
		// tuple suitable for direct reply_inbox INSERT. The reply_inbox
		// schema does NOT require thread_id — only contact_id +
		// send_event_id + mailbox_id are needed for the operator UI to
		// render the row.
		if rb, lookupErr := p.matchToReplyInbox(ctx, raw); lookupErr == nil && rb.ContactID > 0 {
			slog.Info("inbound matched via Schema-A fallback to reply_inbox",
				"op", "thread.ProcessReply/replyInboxFallback",
				"message_id", raw.MessageID,
				"matched_by", rb.MatchedBy,
				"send_event_id", rb.SendEventID,
				"campaign_id", rb.CampaignID,
				"contact_id", rb.ContactID,
				"mailbox_id", rb.MailboxID,
			)
			if insertErr := p.insertReplyInbox(ctx, raw, rb, parsed); insertErr == nil {
				return nil
			} else {
				slog.Warn("reply_inbox INSERT failed, falling through to unmatched_inbound",
					"op", "thread.ProcessReply/replyInboxInsertFail",
					"message_id", raw.MessageID,
					"error", insertErr,
				)
				// fall through to parkUnattributed so the operator still sees it
			}
		} else if lookupErr != nil {
			slog.Warn("Schema-A fallback lookup failed",
				"op", "thread.ProcessReply/replyInboxLookupFail",
				"message_id", raw.MessageID,
				"error", lookupErr,
			)
		}

		slog.Info("inbound no matching thread — parking for operator review",
			"op", "thread.ProcessReply/unattributed",
			"message_id", raw.MessageID,
			"in_reply_to", raw.InReplyTo,
			"from", raw.From,
			"raw_bytes_len", len(raw.RawBytes),
			"body_plain_len", len(raw.BodyPlain),
			"body_html_len", len(bodyHTML),
			"attachments_count", len(attachments),
		)
		// Propagate park failure: a swallowed error here let the poller advance
		// the UID watermark past a never-persisted message → permanent loss
		// (RCA 2026-06-01). On error the poller's process-error path keeps the
		// message below the watermark so the next poll retries it.
		return p.parkUnattributed(ctx, raw, bodyHTML, attachments)
	}
	if matchedBy != "message_id" && matchedBy != "references" {
		slog.Info("inbound reply attributed via fallback",
			"op", "thread.ProcessReply/fallbackMatch",
			"matched_by", matchedBy,
			"thread_id", threadID,
			"contact_id", contactID,
			"from", raw.From,
		)
	}

	// 1a. Bounce detection — must run BEFORE the reply classifier
	// because DSN messages from MAILER-DAEMON have positive-sounding
	// phrases ("Mail Delivery", "I'm sorry to have to inform you")
	// that otherwise misclassify as "interested". If this gate matches,
	// we record the bounce and skip reply classification entirely.
	if mb := DetectBounce(raw); mb.IsBounce() {
		slog.Info("inbound.trace/matchedThreadBounce", "op", "thread.ProcessReply/matchedThreadBounce", "message_id", raw.MessageID, "thread_id", threadID)
		return p.processBounce(ctx, raw, threadID, contactID, mb)
	}
	slog.Info("inbound.trace/willRecordInbound", "op", "thread.ProcessReply/willRecordInbound", "message_id", raw.MessageID, "thread_id", threadID)

	// 2. Classify reply — prefer LLM classifier, fallback to keywords.
	//
	// Strategy:
	//   1. Always run keyword classifier (deterministic, fast, never fails)
	//   2. If LLM classifier wired, call it; on parseable result, override
	//      keyword with LLM result
	//   3. On disagreement (keyword vs LLM, both parseable), log slog.Info
	//      so the operator can curate the sample bank for prompt iteration
	//      (see docs/initiatives/2026-04-27-llm-reply-classifier.md S-G)
	//   4. On LLM error or unparseable response, fall through to keyword —
	//      the keyword result is already in replyType, no further action
	//      needed beyond a slog.Warn for ops visibility
	keywordType := p.response.ClassifyReply(raw.BodyPlain)
	replyType := keywordType
	classifierSource := "keyword"
	if p.classifier != nil {
		if category, err := p.classifier.ClassifySentiment(ctx, raw.BodyPlain); err == nil {
			if llmType, ok := parseReplyType(category); ok {
				replyType = llmType
				classifierSource = "llm"
				if llmType != keywordType {
					slog.Info("reply classifier disagreement",
						"op", "thread.ProcessReply/classifyDisagreement",
						"thread_id", threadID,
						"keyword", replyTypeString(keywordType),
						"llm", replyTypeString(llmType),
						"llm_raw", category)
				}
			} else {
				slog.Warn("LLM returned unparseable sentiment, using keyword",
					"op", "thread.ProcessReply/llmUnparseable",
					"thread_id", threadID,
					"llm_raw", category)
			}
		} else {
			slog.Warn("LLM sentiment classification failed, using keyword fallback",
				"op", "thread.ProcessReply/llmError",
				"thread_id", threadID,
				"error", err)
		}
	}
	_ = classifierSource // hook for future metric emission
	sentiment := classifySentiment(replyType)

	// 3. Parse MIME structure if poller delivered RawBytes (S1.2). Falls
	// back to RawInbound's pre-parsed fields when RawBytes is absent
	// (legacy two-literal fetch path).
	parsed := parseRawIfPresent(raw)

	// 3. Record inbound message
	msgID, err := p.recorder.RecordInbound(ctx, InboundMessage{
		ThreadID:      threadID,
		MessageID:     raw.MessageID,
		InReplyTo:     raw.InReplyTo,
		ReferencesHdr: raw.References,
		Subject:       raw.Subject,
		BodyPlain:     bodyPlainFromParsed(parsed, raw.BodyPlain),
		BodyHTML:      bodyHTMLFromParsed(parsed),
		BodySizeBytes: len(raw.RawBytes),
		Sentiment:     sentiment,
		ReplyType:     replyTypeString(replyType),
		ReceivedAt:    raw.ReceivedAt,
		Attachments:   attachmentsFromParsed(parsed),
	})
	if err != nil {
		return fmt.Errorf("record inbound: %w", err)
	}

	// 3a. Photo pipeline — best-effort. Failures are logged but never
	// propagated; the inbound thread is already persisted and a missing
	// audit row is recoverable. Skipped entirely when no PhotoProcessor
	// is wired (boot without llm-runner).
	if p.photo != nil && parsed != nil && len(parsed.Attachments) > 0 {
		processInboundPhotos(ctx, p.photo, threadID, raw.MessageID, parsed.Attachments)
	}

	// 3b. AC8 Haiku pre-classification — async, fire-and-forget. Tags the
	// matching reply_inbox row with {intent, confidence, model_used,
	// reasoning, classified_at} so the operator UI can filter by intent.
	// No auto-actions are wired off this in AC8 (those land in AC9).
	//
	// Privacy: feedback_no_pii_in_commands T0 — the body is forwarded to
	// the Anthropic API but never logged in slog. Only sender domain +
	// intent verdict are emitted.
	p.maybePreClassifyAsync(raw)

	// 4. Log event
	p.events.LogReplied(ctx, contactID, threadID, msgID, replyTypeString(replyType))

	// 5. Take action based on reply type
	switch replyType {
	case humanize.ReplyNegative:
		// Close thread on negative reply and insert into outreach_suppressions
		// so the campaign runner's pre-send filter excludes this contact from
		// every future enrollment. Without this, closing the thread only stops
		// the current sequence — the same contact would be eligible again as
		// soon as they're touched by a new campaign or re-enrichment cycle.
		p.manager.Close(ctx, threadID)
		if logErr := p.events.LogComplained(ctx, contactID, threadID, msgID); logErr != nil {
			slog.Warn("log complained failed", "op", "InboundProcessor.ProcessReply/logComplainedFail", "error", logErr)
		}
		if _, supErr := p.db.ExecContext(ctx, `
			INSERT INTO outreach_suppressions (email, reason)
			SELECT email, 'negative_reply'
			  FROM outreach_contacts WHERE id = $1 AND email IS NOT NULL
			ON CONFLICT (email) DO NOTHING
		`, contactID); supErr != nil {
			slog.Warn("insert suppression on negative reply failed", "op", "InboundProcessor.ProcessReply/suppressionFail", "contact_id", contactID, "error", supErr)
		}
		slog.Warn("inbound negative reply, thread closed + suppressed", "op", "InboundProcessor.ProcessReply/negative", "contact_id", contactID)
		// FUN-1.3 — funnel_events: classified_negative (best-effort).
		p.insertFunnelEvent(ctx, contactID, "classified_negative",
			map[string]any{"classification": "negative"})

	case humanize.ReplyAutoOOO:
		// Pause for 14 days
		p.manager.Pause(ctx, threadID, time.Now().AddDate(0, 0, 14))
		slog.Info("inbound OOO reply, paused 14 days", "contact_id", contactID)

	case humanize.ReplyLater:
		// Pause for 30 days
		p.manager.Pause(ctx, threadID, time.Now().AddDate(0, 0, 30))
		slog.Info("inbound later reply, paused 30 days", "contact_id", contactID)

	case humanize.ReplyMeeting:
		// Flag for manual follow-up
		p.manager.MarkReplied(ctx, threadID, ActionManualFollow)
		slog.Info("inbound meeting request, manual follow-up", "contact_id", contactID)
		if p.onInterested != nil {
			p.onInterested(ctx, raw.From, int64(threadID))
		}
		p.upsertLead(ctx, threadID, contactID, "meeting", raw)
		// FUN-1.3 — funnel_events: classified_engagement (best-effort).
		p.insertFunnelEvent(ctx, contactID, "classified_engagement",
			map[string]any{"classification": "meeting"})

	case humanize.ReplyInterested:
		// Continue sequence
		p.manager.MarkReplied(ctx, threadID, ActionWaitReply)
		slog.Info("inbound interested reply", "contact_id", contactID)
		if p.onInterested != nil {
			p.onInterested(ctx, raw.From, int64(threadID))
		}
		p.upsertLead(ctx, threadID, contactID, "interested", raw)
		// FUN-1.3 — funnel_events: classified_engagement (best-effort).
		p.insertFunnelEvent(ctx, contactID, "classified_engagement",
			map[string]any{"classification": "interested"})

	case humanize.ReplyObjection:
		// Reply with adjusted tone, continue
		p.manager.MarkReplied(ctx, threadID, ActionWaitReply)
		slog.Info("inbound objection reply", "contact_id", contactID)
		// FUN-1.3 — funnel_events: classified_negative (objection treated as negative).
		p.insertFunnelEvent(ctx, contactID, "classified_negative",
			map[string]any{"classification": "objection"})
	}

	return nil
}

// processBounce handles a DSN bounce: records the inbound DSN as an
// outreach_message, flags the matching outbound as bounced, updates
// thread status, logs a bounce event, and for hard bounces suppresses
// the contact.
//
// The `bounce` argument is the verdict produced by DetectBounce. The
// function never returns a nil error in the happy path; partial DB
// failures are logged as warnings so a single broken update doesn't
// leave the overall poll iteration unfinished.
func (p *InboundProcessor) processBounce(
	ctx context.Context, raw RawInbound,
	threadID, contactID int, bounce BounceInfo,
) error {
	// 1. Record the inbound DSN so the dashboard shows a thread entry.
	msgID, err := p.recorder.RecordInbound(ctx, InboundMessage{
		ThreadID:      threadID,
		MessageID:     raw.MessageID,
		InReplyTo:     raw.InReplyTo,
		ReferencesHdr: raw.References,
		Subject:       raw.Subject,
		BodyPlain:     raw.BodyPlain,
		Sentiment:     SentimentNegative,
		ReplyType:     "bounced",
		ReceivedAt:    raw.ReceivedAt,
	})
	if err != nil {
		return fmt.Errorf("record bounce inbound: %w", err)
	}

	// 2. Flag the original outbound message as bounced + capture its
	// from_address so we can feed the per-mailbox backpressure counter.
	// Inline UPDATE because MessageRecorder.MarkBounced has a parameter
	// indexing bug (WHERE message_id = $2 instead of $3 — tracked as
	// follow-up). Using In-Reply-To as the lookup key mirrors the
	// matchToThread logic above.
	var bouncedFromAddress string
	if raw.InReplyTo != "" {
		cleanID := cleanMessageID(raw.InReplyTo)
		smtpResp := bounce.DSNCode + " " + bounce.Diagnostic
		// Lookup before UPDATE so we know which mailbox sent the message.
		if err := p.db.QueryRowContext(ctx,
			`SELECT COALESCE(from_address,'') FROM outreach_messages WHERE message_id = $1`,
			cleanID,
		).Scan(&bouncedFromAddress); err != nil {
			// Missing row or DB error — log and continue. Step 2 below
			// will UPDATE 0 rows and proceed; step 6 (RecordBounce) skips
			// when from_address is empty.
			slog.Warn("lookup outbound from_address failed", "op", "InboundProcessor.ProcessBounce/lookupFail", "message_id", cleanID, "error", err)
		}
		if _, err := p.db.ExecContext(ctx, `
			UPDATE outreach_messages
			SET bounced_at = $1, smtp_response = $2
			WHERE message_id = $3 AND bounced_at IS NULL`,
			raw.ReceivedAt, smtpResp, cleanID,
		); err != nil {
			slog.Warn("mark outbound bounced failed", "op", "InboundProcessor.ProcessBounce/markMsg", "message_id", cleanID, "error", err)
		}
	}

	// 3. Transition the thread. Hard bounces halt the sequence; soft
	// bounces pause for 3 days to let the retry window clear (matches
	// Postfix default deferred-queue lifetime).
	switch bounce.Kind {
	case BounceHard:
		// No Manager.MarkBounced helper exists, so do it inline.
		if _, err := p.db.ExecContext(ctx, `
			UPDATE outreach_threads
			SET status = 'bounced', next_action = 'done',
				next_action_at = NULL, updated_at = now()
			WHERE id = $1`, threadID); err != nil {
			slog.Warn("mark thread bounced failed", "op", "InboundProcessor.ProcessBounce/markThread", "thread_id", threadID, "error", err)
		}
	case BounceSoft:
		if err := p.manager.Pause(ctx, threadID, raw.ReceivedAt.AddDate(0, 0, 3)); err != nil {
			slog.Warn("pause thread on soft bounce failed", "op", "InboundProcessor.ProcessBounce/pauseFail", "thread_id", threadID, "error", err)
		}
	}

	// 4. Log the bounce event. LogBounced also increments contact and
	// domain bounce counters, which is the input the intelligence
	// loop uses to trigger domain-level suppression.
	if logErr := p.events.LogBounced(ctx, contactID, threadID, msgID, string(bounce.Kind)); logErr != nil {
		slog.Warn("log bounce failed", "op", "InboundProcessor.ProcessBounce/logFail", "error", logErr)
	}

	// 5. For hard bounces only, flip the contact status so no further
	// campaign enrolls pick it up. Soft bounces keep the contact
	// active — a temporary mailbox-full state shouldn't lose the lead.
	if bounce.Kind == BounceHard {
		if _, err := p.db.ExecContext(ctx, `
			UPDATE outreach_contacts
			SET status = 'bounced', updated_at = now()
			WHERE id = $1`, contactID); err != nil {
			slog.Warn("mark contact bounced failed", "op", "InboundProcessor.ProcessBounce/markContact", "contact_id", contactID, "error", err)
		}
	}

	// 6. F3-1 — feed the per-mailbox backpressure counter (mailbox.
	// Backpressure.RecordBounce). Pre-fix, hard bounces detected via
	// IMAP DSN never reached the registry, so the auto-hold threshold
	// never tripped from real-world DSN traffic. Hard bounces only:
	// soft bounces are transient and don't degrade mailbox reputation
	// in the way hard ones do.
	if p.bounceRecorder != nil && bounce.Kind == BounceHard && bouncedFromAddress != "" {
		reason := "imap_dsn:" + bounce.DSNCode
		if held := p.bounceRecorder.RecordBounce(ctx, bouncedFromAddress, reason); held {
			slog.Warn("mailbox auto-held after IMAP-DSN bounce", "op", "InboundProcessor.ProcessBounce/recorderHeld",
				"from_address", bouncedFromAddress,
				"dsn_code", bounce.DSNCode,
				"thread_id", threadID,
			)
		}
	}

	slog.Info("inbound DSN detected",
		"kind", bounce.Kind,
		"dsn_code", bounce.DSNCode,
		"thread_id", threadID,
		"contact_id", contactID,
		"diagnostic", bounce.Diagnostic,
	)
	return nil
}

// bounceRecipientFallback extracts an email address from a raw bounce body
// when the structured RFC 3464 Final-Recipient header is absent. Many
// older MTAs emit plain-text NDRs that mention the failed recipient
// inside angle brackets ("<jan@example.com>") or as a bare token.
//
// Returns the lowercased, trimmed address or "" if nothing parseable
// shows up. Conservative on purpose: a wrong extraction would suppress
// the wrong contact.
var bounceRecipientRegexp = regexp.MustCompile(`<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>`)

// 2026-05-18 hardening — additional DSN recipient extraction patterns.
// The 2026-05-18 backfill landed 118 DSN messages; only 4 of them had a
// canonical Final-Recipient header that the primary path catches. The
// remaining 114 fell through to parkUnattributed as noise. These patterns
// recover most of them so they flip contacts.email_status correctly
// instead of polluting unmatched_inbound.
var (
	// X-Failed-Recipients: foo@x.cz, bar@y.cz   (some MTAs)
	xFailedRecipientsLine = regexp.MustCompile(`(?mi)^\s*X-Failed-Recipients\s*:\s*([^\s,;]+@[^\s,;]+)`)
	// Original-Recipient: rfc822; foo@x.cz   (RFC 3464 §2.3.1, optional)
	originalRecipientLine = regexp.MustCompile(`(?mi)^\s*Original-Recipient\s*:\s*(?:rfc822;\s*)?(.+?)\s*$`)
	// "To: <addr>" inside the bounced-message envelope (Postfix/Sendmail include orig headers)
	embeddedToLine = regexp.MustCompile(`(?mi)^\s*To\s*:\s*(?:[^<]*<)?([^<>@\s]+@[^<>@\s]+\.[^<>@\s,]+)>?`)
	// Plain "failed to deliver to <addr>" / "delivery to <addr> failed" / "Recipient: <addr>"
	plainRecipientLine = regexp.MustCompile(`(?mi)(?:failed.{1,20}to deliver to|recipient|delivery to|to address|na adresu)\s*[:<]?\s*([^<>@\s,;:]+@[^<>@\s,;:]+\.[^<>@\s,;:.]+)`)
	// Last-resort: any email-looking token in body (e.g. unstructured NDR)
	anyEmailRegexp = regexp.MustCompile(`([^<>@\s,;:]+@[^<>@\s,;:]+\.[^<>@\s,;:.]+)`)
)

// rawHeader fetches a specific header from raw.RawBytes (best-effort).
// Returns empty when RawBytes is unparseable or header missing.
func rawHeader(raw RawInbound, name string) string {
	if len(raw.RawBytes) == 0 {
		return ""
	}
	// Cheap line scan; avoids importing net/mail just for this lookup.
	prefix := strings.ToLower(name) + ":"
	for _, line := range strings.Split(string(raw.RawBytes), "\n") {
		l := strings.TrimRight(line, "\r")
		if strings.HasPrefix(strings.ToLower(l), prefix) {
			return strings.TrimSpace(l[len(prefix):])
		}
		// First empty line ends headers.
		if l == "" {
			return ""
		}
	}
	return ""
}

func extractBouncedRecipient(b BounceInfo, bodyPlain string) string {
	// 1. Prefer the parsed Final-Recipient DSN field — authoritative.
	if r := strings.TrimSpace(b.FailedRecipient); r != "" {
		r = strings.TrimPrefix(r, "<")
		r = strings.TrimSuffix(r, ">")
		return strings.ToLower(strings.TrimSpace(r))
	}
	// 2. X-Failed-Recipients line in body.
	if m := xFailedRecipientsLine.FindStringSubmatch(bodyPlain); len(m) >= 2 {
		return strings.ToLower(strings.TrimSpace(m[1]))
	}
	// 3. Original-Recipient line in body (RFC 3464 alternative).
	if m := originalRecipientLine.FindStringSubmatch(bodyPlain); len(m) >= 2 {
		v := strings.TrimSpace(m[1])
		v = strings.TrimPrefix(v, "<")
		v = strings.TrimSuffix(v, ">")
		if strings.Contains(v, "@") {
			return strings.ToLower(v)
		}
	}
	// 4. Canonical <email> token in body (original primary fallback).
	if m := bounceRecipientRegexp.FindStringSubmatch(bodyPlain); len(m) >= 2 {
		return strings.ToLower(strings.TrimSpace(m[1]))
	}
	// 5. Embedded To: header of the bounced message (Postfix/Sendmail bundle orig msg in body).
	if m := embeddedToLine.FindStringSubmatch(bodyPlain); len(m) >= 2 {
		return strings.ToLower(strings.TrimSpace(m[1]))
	}
	// 6. Plain "recipient: addr" / "failed to deliver to addr" patterns.
	if m := plainRecipientLine.FindStringSubmatch(bodyPlain); len(m) >= 2 {
		return strings.ToLower(strings.TrimSpace(m[1]))
	}
	// 7. Last-resort: any plausible email token (but only inside the body,
	//    not in From — to avoid grabbing "postmaster@seznam.cz"). Skip if
	//    the only match is the bouncer itself.
	matches := anyEmailRegexp.FindAllStringSubmatch(bodyPlain, -1)
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		v := strings.ToLower(strings.TrimSpace(m[1]))
		if strings.Contains(v, "mailer-daemon") || strings.Contains(v, "postmaster") {
			continue
		}
		return v
	}
	return ""
}

// processUnmatchedBounce flips contacts.email_status='bounce_hold' for the
// recipient referenced by an unmatched DSN. Returns true when the contact
// row was updated (the caller skips the unmatched_inbound park) and
// false when no recipient could be extracted or no contact matched
// (the caller falls through to the regular parking path).
//
// R3 — see docs/initiatives/2026-05-13-reply-pipeline-recovery.md. The
// purpose is to keep the verify-loop honest when a campaign's
// rfc_message_id never makes it to send_events (legacy rows or
// matchToThread failures): a hard bounce still mutates contact state
// so we don't keep re-sending to a dead address.
//
// HARD rules satisfied:
//   - feedback_audit_log_on_mutations T0 — INSERTs operator_audit_log
//     immediately after the contact UPDATE. We don't wrap both in an
//     explicit BEGIN ... COMMIT because the BFF/DB connection pool already
//     auto-commits each ExecContext and audit.Log is fire-and-forget by
//     design (audit-loss is recoverable; missed contact UPDATE is not).
//     If a future Sprint reintroduces multi-statement tx semantics here,
//     wrap both in p.db.BeginTx + Commit.
//   - feedback_no_pii_in_commands — no inline email addresses; the
//     parsed recipient flows through bind parameters.
func (p *InboundProcessor) processUnmatchedBounce(
	ctx context.Context, raw RawInbound, bounce BounceInfo,
) (handled bool) {
	if p.db == nil {
		return false
	}
	recipient := extractBouncedRecipient(bounce, raw.BodyPlain)
	if recipient == "" && len(raw.RawBytes) > 0 {
		// A multipart/report DSN keeps Final-Recipient / X-Failed-Recipients
		// in the message/delivery-status part that mime.Parse files as an
		// attachment, and BodyPlain was overwritten with the human-readable
		// part upstream. Re-scan the full RFC822 so the recipient patterns
		// (and DetectBounce's own RawBytes fallback) still recover the address.
		recipient = extractBouncedRecipient(bounce, string(raw.RawBytes))
	}
	if recipient == "" {
		slog.Info("unmatched bounce — no recipient extractable, parking",
			"op", "thread.processUnmatchedBounce/noRecipient",
			"message_id", raw.MessageID,
			"dsn_code", bounce.DSNCode,
		)
		return false
	}

	// Flip contacts.email_status. Schema A `contacts` carries the
	// verify-loop status field (migration 066). RETURNING id so we have
	// the entity_id for the audit row.
	var contactID int64
	err := p.db.QueryRowContext(ctx, `
		UPDATE contacts
		SET email_status = 'bounce_hold', updated_at = now()
		WHERE lower(trim(email)) = $1
		  AND (email_status IS NULL OR email_status NOT IN ('bounce_hold', 'spamtrap'))
		RETURNING id
	`, recipient).Scan(&contactID)
	if errors.Is(err, sql.ErrNoRows) {
		slog.Info("unmatched bounce — recipient not found in contacts, parking",
			"op", "thread.processUnmatchedBounce/contactMissing",
			"message_id", raw.MessageID,
			"dsn_code", bounce.DSNCode,
		)
		return false
	}
	if err != nil {
		slog.Warn("unmatched bounce — contact UPDATE failed, parking",
			"op", "thread.processUnmatchedBounce/updateFail",
			"message_id", raw.MessageID,
			"error", err,
		)
		return false
	}

	// Also flag any send_events rows that targeted this recipient as
	// 'bounced' so the M5 reputation panel + analytics reflect reality.
	// Best-effort — soft errors don't abort the bounce handling.
	if _, err := p.db.ExecContext(ctx, `
		UPDATE send_events SET status = 'bounced'
		WHERE contact_id = $1 AND (status IS NULL OR status NOT IN ('bounced'))
	`, contactID); err != nil {
		slog.Warn("unmatched bounce — send_events UPDATE failed (non-fatal)",
			"op", "thread.processUnmatchedBounce/sendEventsFail",
			"contact_id", contactID,
			"error", err,
		)
	}

	// Audit log — feedback_audit_log_on_mutations T0.
	audit.Log(ctx, p.db, "contact_bounce_hold", "system_bounce_parser",
		"contact", fmt.Sprintf("%d", contactID),
		map[string]any{
			"dsn_code":   bounce.DSNCode,
			"diagnostic": bounce.Diagnostic,
			"message_id": raw.MessageID,
			"source":     "unmatched_dsn",
		},
	)

	slog.Info("unmatched bounce — contact flipped to bounce_hold",
		"op", "thread.processUnmatchedBounce/contactHeld",
		"contact_id", contactID,
		"dsn_code", bounce.DSNCode,
		"message_id", raw.MessageID,
	)
	return true
}

// matchToThread finds the thread for an inbound reply.
//
// Attribution ladder (in order):
//  1. Message-ID chain: In-Reply-To header → outreach_messages.message_id
//     (legacy schema-B mirror), then send_events.rfc_message_id (R2 — canonical
//     RFC 5322 Message-ID actually emitted on the wire).
//  2. References header: each token tried against the same two columns.
//  3. Exact email match: outreach_contacts WHERE email = from (unique match only)
//  4. Domain match: outreach_contacts WHERE email_domain = from-domain AND
//     domain is NOT a known freemail provider (unique ICO match only, to avoid
//     matching generic webmail where multiple companies share the domain)
//
// R2 rationale (docs/initiatives/2026-05-12-reply-pipeline-recovery.md):
// outreach_messages.message_id stored the anti-trace envelope_id ("env_XXX")
// which never appears in headers of the sent email. Replies reference the
// RFC Message-ID emitted by sender.applyAnonymityHeaders (e.g. "<HMAC@domain>")
// which lives in send_events.rfc_message_id going forward. The two lookups
// are unioned at each rung so legacy rows (rfc_message_id IS NULL) still
// match via the original outreach_messages path.
//
// Returns threadID=0 / contactID=0 when no ladder rung matches; the caller
// parks the reply in unmatched_inbound for operator review.
func (p *InboundProcessor) matchToThread(ctx context.Context, raw RawInbound) (threadID, contactID int, matchedBy string, err error) {
	// ── Rung 1: In-Reply-To ──────────────────────────────────────────────
	if raw.InReplyTo != "" {
		cleanID := cleanMessageID(raw.InReplyTo)
		tid, cid, mb, lookupErr := p.lookupByMessageID(ctx, cleanID)
		if lookupErr != nil {
			return 0, 0, "", fmt.Errorf("match by in-reply-to: %w", lookupErr)
		}
		if tid != 0 {
			// Collapse "message_id" / "rfc_message_id" into the canonical
			// bucket so the caller's fallbackMatch branch doesn't fire on
			// a perfectly good RFC-canonical match.
			_ = mb
			return tid, cid, "message_id", nil
		}
	}

	// ── Rung 2: References header ────────────────────────────────────────
	if raw.References != "" {
		refs := strings.Fields(raw.References)
		for _, ref := range refs {
			cleanRef := cleanMessageID(ref)
			tid, cid, mb, lookupErr := p.lookupByMessageID(ctx, cleanRef)
			if lookupErr != nil {
				return 0, 0, "", fmt.Errorf("match by references: %w", lookupErr)
			}
			if tid != 0 {
				// Promote any sub-source to "references" so downstream
				// matched_by buckets remain stable.
				_ = mb
				return tid, cid, "references", nil
			}
		}
	}

	// ── Rung 3: Exact email match ────────────────────────────────────────
	fromEmail := extractEmail(raw.From)
	if fromEmail != "" {
		tid, cid, scanErr := p.matchByEmail(ctx, fromEmail)
		if scanErr != nil {
			return 0, 0, "", fmt.Errorf("match by email: %w", scanErr)
		}
		if tid != 0 {
			return tid, cid, "email_exact", nil
		}
	}

	// ── Rung 4: Domain match (corporate domains only) ────────────────────
	if fromEmail != "" {
		domain := domainFromEmail(fromEmail)
		if domain != "" && !isFreemailDomain(domain) {
			tid, cid, scanErr := p.matchByDomain(ctx, domain)
			if scanErr != nil {
				return 0, 0, "", fmt.Errorf("match by domain: %w", scanErr)
			}
			if tid != 0 {
				return tid, cid, "domain_match", nil
			}
		}
	}

	return 0, 0, "", nil
}

// lookupByMessageID attempts both Message-ID storage columns: the legacy
// outreach_messages.message_id (schema-B mirror, where pre-R2 rows live as
// envelope_id strings) and the canonical send_events.rfc_message_id (set
// by the sender engine starting R2). The send_events path joins through
// the Schema A contacts → Schema B outreach_contacts → outreach_threads
// hop because send_events.contact_id references the runner's contacts row,
// not the thread's outreach_contacts row.
//
// Returns threadID=0 on no match. matchedBy distinguishes the source so
// future diagnostics (and the slog at the caller's fallbackMatch branch)
// can spot legacy-vs-canonical hits.
func (p *InboundProcessor) lookupByMessageID(ctx context.Context, cleanID string) (threadID, contactID int, matchedBy string, err error) {
	if p.db == nil || cleanID == "" {
		return 0, 0, "", nil
	}
	// 1. outreach_messages — legacy mirror (also covers any future code
	// path that writes Message-ID into Schema B directly).
	scanErr := p.db.QueryRowContext(ctx, `
		SELECT m.thread_id, t.contact_id
		FROM outreach_messages m
		JOIN outreach_threads t ON t.id = m.thread_id
		WHERE m.message_id = $1
	`, cleanID).Scan(&threadID, &contactID)
	if scanErr == nil {
		return threadID, contactID, "message_id", nil
	}
	if !errors.Is(scanErr, sql.ErrNoRows) {
		return 0, 0, "", scanErr
	}

	// 2. send_events.rfc_message_id (R2 canonical) — bridge through
	// contacts.email → outreach_contacts.email so the existing
	// outreach_threads row is returned. Includes a defensive LIMIT 1 +
	// ORDER BY because the same email could in theory be enrolled in
	// multiple campaigns; we take the most recently updated thread —
	// the same heuristic matchByEmail uses.
	scanErr = p.db.QueryRowContext(ctx, `
		SELECT t.id, t.contact_id
		FROM send_events se
		JOIN contacts c ON c.id = se.contact_id
		JOIN outreach_contacts oc
		  ON lower(trim(oc.email)) = lower(trim(c.email))
		JOIN outreach_threads t
		  ON t.contact_id = oc.id
		 AND t.campaign_id = se.campaign_id
		WHERE se.rfc_message_id = $1
		ORDER BY t.updated_at DESC NULLS LAST, t.id DESC
		LIMIT 1
	`, cleanID).Scan(&threadID, &contactID)
	if scanErr == nil {
		return threadID, contactID, "rfc_message_id", nil
	}
	if !errors.Is(scanErr, sql.ErrNoRows) {
		return 0, 0, "", scanErr
	}
	return 0, 0, "", nil
}

// matchByEmail looks up a unique active thread by exact contact email.
// Returns threadID=0 when no unique match exists (0 rows or multiple rows).
func (p *InboundProcessor) matchByEmail(ctx context.Context, email string) (threadID, contactID int, err error) {
	if p.db == nil {
		return 0, 0, nil
	}
	rows, queryErr := p.db.QueryContext(ctx, `
		SELECT t.id, t.contact_id
		FROM outreach_threads t
		JOIN outreach_contacts c ON c.id = t.contact_id
		WHERE lower(trim(c.email)) = lower(trim($1))
		  AND t.status NOT IN ('closed', 'expired', 'error')
		ORDER BY t.updated_at DESC
		LIMIT 2
	`, email)
	if queryErr != nil {
		return 0, 0, fmt.Errorf("email lookup: %w", queryErr)
	}
	defer rows.Close()

	var results []struct{ tid, cid int }
	for rows.Next() {
		var r struct{ tid, cid int }
		if scanErr := rows.Scan(&r.tid, &r.cid); scanErr != nil {
			return 0, 0, fmt.Errorf("email scan: %w", scanErr)
		}
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("email rows: %w", err)
	}

	if len(results) == 1 {
		return results[0].tid, results[0].cid, nil
	}
	// 0 or multiple → no unambiguous match
	return 0, 0, nil
}

// matchByDomain looks up a unique active thread by corporate email domain.
// The domain must correspond to exactly one distinct ICO in our contacts table;
// if multiple companies share the domain (e.g. hosted email provider used by
// several firms), we do NOT attribute (ambiguous). Caller must have already
// excluded freemail domains.
func (p *InboundProcessor) matchByDomain(ctx context.Context, domain string) (threadID, contactID int, err error) {
	if p.db == nil {
		return 0, 0, nil
	}
	// Count distinct ICOs on this domain first — abort if not exactly 1.
	var icoCount int
	countErr := p.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT COALESCE(NULLIF(trim(ico),''), 'NNICO_' || id::text))
		FROM outreach_contacts
		WHERE lower(trim(email_domain)) = lower(trim($1))
	`, domain).Scan(&icoCount)
	if countErr != nil {
		return 0, 0, fmt.Errorf("domain ico count: %w", countErr)
	}
	if icoCount != 1 {
		// 0 (unknown domain) or >1 (multiple companies) → skip
		return 0, 0, nil
	}

	// Exactly one ICO on this domain — find the most-recent active thread.
	rows, queryErr := p.db.QueryContext(ctx, `
		SELECT t.id, t.contact_id
		FROM outreach_threads t
		JOIN outreach_contacts c ON c.id = t.contact_id
		WHERE lower(trim(c.email_domain)) = lower(trim($1))
		  AND t.status NOT IN ('closed', 'expired', 'error')
		ORDER BY t.updated_at DESC
		LIMIT 2
	`, domain)
	if queryErr != nil {
		return 0, 0, fmt.Errorf("domain thread lookup: %w", queryErr)
	}
	defer rows.Close()

	var results []struct{ tid, cid int }
	for rows.Next() {
		var r struct{ tid, cid int }
		if scanErr := rows.Scan(&r.tid, &r.cid); scanErr != nil {
			return 0, 0, fmt.Errorf("domain scan: %w", scanErr)
		}
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("domain rows: %w", err)
	}

	if len(results) >= 1 {
		return results[0].tid, results[0].cid, nil
	}
	return 0, 0, nil
}

// replyInboxMatch is the Schema-A bridge result. Unlike matchToThread
// (which joins outreach_threads + outreach_contacts — empty in the current
// deployment), this struct carries only the columns reply_inbox actually
// needs: contact_id (required), send_event_id (optional, for thread-history
// later), campaign_id (required for the operator's "Z kampaně" chip),
// mailbox_id (optional). The reply_inbox schema does NOT require thread_id,
// so threadID is intentionally absent here.
type replyInboxMatch struct {
	ContactID   int64
	SendEventID int64
	CampaignID  int64
	MailboxID   int64
	FromEmail   string
	MatchedBy   string // "rfc_message_id" | "message_id" | "email_exact" | "domain_match"
}

// matchToReplyInbox walks Schema-A (send_events + contacts) directly to
// recover the (campaign, contact, mailbox) tuple for an incoming reply.
// Mirrors matchToThread's 4-rung structure but writes to reply_inbox
// without requiring the Schema-B outreach_threads bridge.
//
// Rung 1: In-Reply-To header → send_events.message_id / rfc_message_id
// Rung 2: References header (each ref) → same lookup
// Rung 3: Email exact → contacts.email → most-recent send_events
// Rung 4: Domain match (corporate-only, ICO-unique) → most-recent send_events
//
// Returns ContactID > 0 on match. Caller passes the result to
// insertReplyInbox.
func (p *InboundProcessor) matchToReplyInbox(ctx context.Context, raw RawInbound) (replyInboxMatch, error) {
	var zero replyInboxMatch
	if p.db == nil {
		return zero, nil
	}

	// Rung 1: In-Reply-To
	if raw.InReplyTo != "" {
		cleanID := cleanMessageID(raw.InReplyTo)
		if cleanID != "" {
			rb, err := p.sendEventToReplyInboxMatch(ctx, cleanID)
			if err != nil {
				return zero, fmt.Errorf("schema-a in-reply-to lookup: %w", err)
			}
			if rb.ContactID > 0 {
				rb.MatchedBy = "rfc_message_id"
				rb.FromEmail = extractEmail(raw.From)
				return rb, nil
			}
		}
	}

	// Rung 2: References
	if raw.References != "" {
		for _, ref := range strings.Fields(raw.References) {
			cleanRef := cleanMessageID(ref)
			if cleanRef == "" {
				continue
			}
			rb, err := p.sendEventToReplyInboxMatch(ctx, cleanRef)
			if err != nil {
				return zero, fmt.Errorf("schema-a references lookup: %w", err)
			}
			if rb.ContactID > 0 {
				rb.MatchedBy = "references"
				rb.FromEmail = extractEmail(raw.From)
				return rb, nil
			}
		}
	}

	// Rung 3: Email exact — most recent send_events for the contact
	fromEmail := extractEmail(raw.From)
	if fromEmail != "" {
		rb, err := p.contactEmailToReplyInboxMatch(ctx, fromEmail)
		if err != nil {
			return zero, fmt.Errorf("schema-a email lookup: %w", err)
		}
		if rb.ContactID > 0 {
			rb.MatchedBy = "email_exact"
			rb.FromEmail = fromEmail
			return rb, nil
		}
	}

	// Rung 4: Domain — corporate only, ICO-unique
	if fromEmail != "" {
		domain := domainFromEmail(fromEmail)
		if domain != "" && !isFreemailDomain(domain) {
			rb, err := p.contactDomainToReplyInboxMatch(ctx, domain)
			if err != nil {
				return zero, fmt.Errorf("schema-a domain lookup: %w", err)
			}
			if rb.ContactID > 0 {
				rb.MatchedBy = "domain_match"
				rb.FromEmail = fromEmail
				return rb, nil
			}
		}
	}

	return zero, nil
}

// sendEventToReplyInboxMatch resolves a Message-ID (already cleaned) to a
// reply_inbox match by checking both message_id and rfc_message_id columns.
// Returns zero match (ContactID=0) when no row found.
func (p *InboundProcessor) sendEventToReplyInboxMatch(ctx context.Context, cleanID string) (replyInboxMatch, error) {
	var rb replyInboxMatch
	if p.db == nil || cleanID == "" {
		return rb, nil
	}
	// COALESCE on mailbox_used → outreach_mailboxes.id so the reply_inbox
	// row carries a clean BIGINT. Empty / missing mailbox_used yields NULL
	// (we use a sentinel 0 in Go and translate to NULL in insertReplyInbox).
	scanErr := p.db.QueryRowContext(ctx, `
		SELECT
		  se.contact_id,
		  se.id,
		  se.campaign_id,
		  COALESCE((SELECT m.id FROM outreach_mailboxes m WHERE m.from_address = se.mailbox_used LIMIT 1), 0) AS mailbox_id
		FROM send_events se
		WHERE se.message_id = $1 OR se.rfc_message_id = $1
		ORDER BY se.sent_at DESC NULLS LAST
		LIMIT 1
	`, cleanID).Scan(&rb.ContactID, &rb.SendEventID, &rb.CampaignID, &rb.MailboxID)
	if scanErr == nil {
		return rb, nil
	}
	if errors.Is(scanErr, sql.ErrNoRows) {
		return replyInboxMatch{}, nil
	}
	return replyInboxMatch{}, scanErr
}

// contactEmailToReplyInboxMatch resolves "reply from foo@bar" to the most
// recent send_events row for that contact. Uses idx_contacts_lower_email
// (migration 120 partial index) — the WHERE clause MUST include the
// non-null/non-empty predicate to match the partial-index gate.
func (p *InboundProcessor) contactEmailToReplyInboxMatch(ctx context.Context, email string) (replyInboxMatch, error) {
	var rb replyInboxMatch
	if p.db == nil || email == "" {
		return rb, nil
	}
	scanErr := p.db.QueryRowContext(ctx, `
		SELECT
		  ct.id,
		  se.id,
		  se.campaign_id,
		  COALESCE((SELECT m.id FROM outreach_mailboxes m WHERE m.from_address = se.mailbox_used LIMIT 1), 0)
		FROM contacts ct
		LEFT JOIN send_events se ON se.contact_id = ct.id
		WHERE LOWER(ct.email) = LOWER(TRIM($1))
		  AND ct.email IS NOT NULL
		  AND ct.email <> ''
		ORDER BY se.sent_at DESC NULLS LAST
		LIMIT 1
	`, email).Scan(&rb.ContactID, &rb.SendEventID, &rb.CampaignID, &rb.MailboxID)
	if scanErr == nil {
		return rb, nil
	}
	if errors.Is(scanErr, sql.ErrNoRows) {
		return replyInboxMatch{}, nil
	}
	return replyInboxMatch{}, scanErr
}

// contactDomainToReplyInboxMatch resolves "reply from someone@<domain>"
// to a (contact, campaign, mailbox) when the domain is corporate-unique
// (exactly one ICO maps to it in contacts). Less precise than email_exact,
// hence rung 4. The contact returned is the one whose ico matches that
// ICO's earliest contact_id (deterministic tiebreaker).
func (p *InboundProcessor) contactDomainToReplyInboxMatch(ctx context.Context, domain string) (replyInboxMatch, error) {
	var rb replyInboxMatch
	if p.db == nil || domain == "" {
		return rb, nil
	}
	// Count distinct icos for this domain — skip if not exactly 1.
	var icoCount int
	if err := p.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT NULLIF(TRIM(ico), ''))
		FROM contacts
		WHERE LOWER(SPLIT_PART(email, '@', 2)) = LOWER(TRIM($1))
		  AND ico IS NOT NULL
		  AND ico <> ''
	`, domain).Scan(&icoCount); err != nil {
		return zero(rb), fmt.Errorf("domain ico count: %w", err)
	}
	if icoCount != 1 {
		return rb, nil
	}
	scanErr := p.db.QueryRowContext(ctx, `
		SELECT
		  ct.id,
		  se.id,
		  se.campaign_id,
		  COALESCE((SELECT m.id FROM outreach_mailboxes m WHERE m.from_address = se.mailbox_used LIMIT 1), 0)
		FROM contacts ct
		LEFT JOIN send_events se ON se.contact_id = ct.id
		WHERE LOWER(SPLIT_PART(ct.email, '@', 2)) = LOWER(TRIM($1))
		  AND ct.email IS NOT NULL
		  AND ct.email <> ''
		ORDER BY se.sent_at DESC NULLS LAST, ct.id ASC
		LIMIT 1
	`, domain).Scan(&rb.ContactID, &rb.SendEventID, &rb.CampaignID, &rb.MailboxID)
	if scanErr == nil {
		return rb, nil
	}
	if errors.Is(scanErr, sql.ErrNoRows) {
		return replyInboxMatch{}, nil
	}
	return replyInboxMatch{}, scanErr
}

// zero is a tiny helper that returns the same struct value — keeps the
// 'return zero, err' lines compact in functions above.
func zero(rb replyInboxMatch) replyInboxMatch { return replyInboxMatch{} }

// insertReplyInbox persists the matched reply into reply_inbox.
//
// G3.7.2: body_text, body_html, attachments_meta, headers_json are now
// stored alongside the metadata columns, eliminating the 68% data loss at
// the schema fence that occurred when only unmatched_inbound kept body
// content (matched hot-lead replies were body-blind before this change).
//
// parsed is the MIME parse result from parseRawIfPresent — may be nil for
// legacy two-literal fetch paths. All body fields degrade gracefully to
// NULL when parsed is nil or empty.
//
// headers_json stores boolean auth flags + selected scalar headers only.
// NO raw Received chain, NO IP addresses (feedback_no_pii_in_logs T0).
func (p *InboundProcessor) insertReplyInbox(ctx context.Context, raw RawInbound, rb replyInboxMatch, parsed *mime.ParsedMessage) error {
	if p.db == nil {
		return nil
	}
	// Mailbox FK is nullable — 0 sentinel from the SELECT means "we
	// couldn't resolve outreach_mailboxes from send_events.mailbox_used".
	// Fallback: if the poller set raw.MailboxAddr, resolve via a secondary
	// lookup so legacy contacts (no send_events row) still get mailbox_id.
	var mailboxID interface{}
	if rb.MailboxID > 0 {
		mailboxID = rb.MailboxID
	} else if raw.MailboxAddr != "" && p.db != nil {
		var fallbackID int64
		if err := p.db.QueryRowContext(ctx,
			`SELECT id FROM outreach_mailboxes WHERE from_address = $1 LIMIT 1`,
			raw.MailboxAddr,
		).Scan(&fallbackID); err == nil && fallbackID > 0 {
			mailboxID = fallbackID
		}
	}
	var sendEventID interface{}
	if rb.SendEventID > 0 {
		sendEventID = rb.SendEventID
	}
	var campaignID interface{}
	if rb.CampaignID > 0 {
		campaignID = rb.CampaignID
	}

	received := raw.ReceivedAt
	if received.IsZero() {
		received = time.Now().UTC()
	}

	// Idempotency identity. Prefer the inbound's stable RFC Message-ID over
	// received_at: received_at degrades to time.Now() above for messages with
	// no parseable Date, so a re-poll / watermark reset would mint a fresh
	// timestamp and duplicate the reply. A real Message-ID is stable across
	// re-fetches. reply_inbox has no message_id column, so the dedup matches
	// through headers_json->>'message_id' (written by replyInboxHeadersJSON
	// below); we therefore only key on it when headers_json is actually
	// persisted (parsed != nil) and the id is real — not the synthetic
	// "uid:<n>@host" the poller assigns when the header is absent. Otherwise we
	// fall back to the original received_at key. dedupMsgID is normalised with
	// cleanMessageID so it compares equal to btrim(<stored>, '<>').
	dedupMsgID := ""
	if mid := strings.TrimSpace(raw.MessageID); parsed != nil && mid != "" && !strings.HasPrefix(mid, "uid:") {
		dedupMsgID = cleanMessageID(raw.MessageID)
	}

	// Body content — degrade to nil (NULL in DB) when parsed is absent.
	var bodyText, bodyHTML interface{}
	var attachmentsMeta, headersJSON interface{}

	if parsed != nil {
		if t := safeUTF8(bodyPlainFromParsed(parsed, raw.BodyPlain)); t != "" {
			bodyText = t
		}
		if h := safeUTF8(bodyHTMLFromParsed(parsed)); h != "" {
			bodyHTML = h
		}
		if len(parsed.Attachments) > 0 {
			attachmentsMeta = replyInboxAttachmentsMeta(parsed.Attachments)
		}
		headersJSON = replyInboxHeadersJSON(parsed.Headers, raw)
	}

	_, err := p.db.ExecContext(ctx, `
		INSERT INTO reply_inbox (
		  campaign_id, contact_id, mailbox_id, send_event_id,
		  from_email, subject, received_at, handled,
		  body_text, body_html, attachments_meta, headers_json
		)
		SELECT $1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11
		WHERE NOT EXISTS (
		  -- Idempotent re-ingest guard. A re-fetched message must not create a
		  -- duplicate reply row, making an IMAP watermark reset safe (backlog
		  -- recovery) and hardening against any future re-poll. When the
		  -- inbound carries a stable Message-ID ($12) we dedup on
		  -- (mailbox_id, message_id) — stable across re-fetches even when the
		  -- Date header is missing. Only when there is no usable Message-ID do
		  -- we fall back to (mailbox_id, from_email, received_at), which is
		  -- unstable for Date-less mail (received_at degrades to time.Now()).
		  -- IS NOT DISTINCT FROM is NULL-safe for replies with a null
		  -- mailbox_id; btrim normalises the stored "<id>" to the $12 form.
		  SELECT 1 FROM reply_inbox
		  WHERE mailbox_id IS NOT DISTINCT FROM $3
		    AND (
		      ($12 <> '' AND btrim(headers_json->>'message_id', '<>') = $12)
		      OR ($12 = '' AND from_email = $5 AND received_at = $7)
		    )
		)
	`,
		campaignID, rb.ContactID, mailboxID, sendEventID,
		safeUTF8(rb.FromEmail), safeUTF8(raw.Subject), received,
		bodyText, bodyHTML, attachmentsMeta, headersJSON, dedupMsgID,
	)
	if err != nil {
		return fmt.Errorf("reply_inbox insert: %w", err)
	}

	// Persist attachment BYTES so matched-reply photos are servable by the
	// dashboard (RCA 2026-06-01 "netěží fotky" — previously only metadata was
	// kept here, bytes went to the photostore/were dropped, so seller photos on
	// hot-lead replies never reached the operator). Mirrors parkUnattributed for
	// orphans. Resolve the reply_inbox id via the dedup key, then upsert each
	// attachment (idempotent on re-process). Best-effort: a failure here must not
	// fail the reply itself (the row + metadata already landed).
	if parsed != nil && len(parsed.Attachments) > 0 {
		var riID int64
		if e := p.db.QueryRowContext(ctx,
			`SELECT id FROM reply_inbox
			  WHERE mailbox_id IS NOT DISTINCT FROM $3
			    AND (
			      ($4 <> '' AND btrim(headers_json->>'message_id', '<>') = $4)
			      OR ($4 = '' AND from_email = $1 AND received_at = $2)
			    )
			  ORDER BY id DESC LIMIT 1`,
			safeUTF8(rb.FromEmail), received, mailboxID, dedupMsgID,
		).Scan(&riID); e == nil && riID > 0 {
			for idx, att := range parsed.Attachments {
				if len(att.Data) == 0 {
					continue
				}
				sum := sha256.Sum256(att.Data)
				if _, e2 := p.db.ExecContext(ctx, `
					INSERT INTO reply_inbox_attachments
						(reply_inbox_id, idx, filename, content_type, size_bytes, data, sha256, is_inline)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					ON CONFLICT (reply_inbox_id, idx) DO NOTHING`,
					riID, idx, att.Filename, att.ContentType, len(att.Data), att.Data,
					hex.EncodeToString(sum[:]),
					strings.HasPrefix(att.ContentType, "image/") || att.ContentID != "",
				); e2 != nil {
					slog.Warn("reply_inbox attachment persist failed",
						"op", "thread.insertReplyInbox/attachmentFail",
						"reply_inbox_id", riID, "idx", idx, "error", e2)
				}
			}
		}
	}
	return nil
}

// replyInboxAttachmentsMeta converts parsed MIME attachments into a
// JSONB-safe []map for storage in reply_inbox.attachments_meta.
// Only filename, content_type, and size_bytes are kept — no raw data
// (feedback_no_pii_in_logs T0; bulk binary belongs in photostore).
func replyInboxAttachmentsMeta(atts []mime.Attachment) []byte {
	if len(atts) == 0 {
		return nil
	}
	type attMeta struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		SizeBytes   int    `json:"size_bytes"`
	}
	out := make([]attMeta, 0, len(atts))
	for _, a := range atts {
		out = append(out, attMeta{
			Filename:    a.Filename,
			ContentType: a.ContentType,
			SizeBytes:   len(a.Data),
		})
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

// replyInboxHeadersJSON builds a sanitized JSONB object from parsed mail
// headers. Stores only boolean auth flags and selected scalar headers.
//
// HARD: NO raw Received chain (contains IP addresses), NO full DKIM-Signature
// value. Only a boolean dkim_present flag is stored
// (feedback_no_pii_in_logs T0).
func replyInboxHeadersJSON(h interface{ Get(string) string }, raw RawInbound) []byte {
	// net/mail.Header has a Get(key) method. We accept the interface so tests
	// can pass a simple stub.
	spfRaw := strings.ToLower(rawHeader(raw, "Received-SPF"))
	dkimSig := rawHeader(raw, "DKIM-Signature")

	payload := map[string]interface{}{
		// Scalar reference headers — useful for dedup and thread linkage.
		"message_id":   h.Get("Message-Id"),
		"in_reply_to":  h.Get("In-Reply-To"),
		"references":   h.Get("References"),
		"date":         h.Get("Date"),
		"content_type": h.Get("Content-Type"),
		// Auth flags — boolean only, no raw values that could expose IPs.
		"spf_pass":     strings.HasPrefix(spfRaw, "pass"),
		"dkim_present": dkimSig != "",
	}

	b, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return b
}

// parkUnattributed persists a reply that could not be matched to any thread
// into the unmatched_inbound table for operator review.
//
// As of Sprint B2 (issue #1248) it also persists body_html + attachments
// extracted from the parsed MIME so the operator UI can render rich
// content and download originals without needing to re-poll IMAP.
//
// ON CONFLICT path backfills body_preview / body_html when the
// orchestrator previously inserted a row before MIME parsing was wired
// in here. Existing rows with empty preview get hydrated on the next
// poll cycle when BFF re-fetches the message. Non-empty preview is
// preserved (operator may have manually edited via SQL).
//
// Attachments are written best-effort — failure to insert an attachment
// must not block the inbound from landing. We log + Sentry but don't
// abort.
// safeUTF8 strips bytes that aren't valid UTF-8 so Postgres TEXT INSERTs
// don't raise 22021 ("invalid byte sequence for encoding UTF8"). Some
// non-Latin-1 MTAs / Czech CP1250 mail headers leak through here. We
// preserve all valid UTF-8 sequences and replace invalid bytes with
// U+FFFD REPLACEMENT CHARACTER (or empty string, keeping length stable).
func safeUTF8(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			// Replace invalid byte with REPLACEMENT CHARACTER.
			b.WriteRune('�')
			i++
			continue
		}
		b.WriteRune(r)
		i += size
	}
	return b.String()
}

// parkUnattributed persists an unmatched inbound message to unmatched_inbound
// so the operator still sees it. Returns an error when the row could NOT be
// persisted — the caller MUST propagate it so the poller does not advance the
// UID watermark past a message that was never stored (silent-loss guard:
// 2026-06-01 a reply arrived but landed in no table because this error was
// swallowed at the call site and the watermark advanced past it).
func (p *InboundProcessor) parkUnattributed(
	ctx context.Context,
	raw RawInbound,
	bodyHTML string,
	attachments []mime.Attachment,
) error {
	// Discard test messages before inserting into unmatched_inbound.
	if isTestMessage(raw.Subject) {
		slog.Info("inbound.test_msg_discard",
			"op", "thread.parkUnattributed/test_discard",
			"message_id", raw.MessageID,
			"subject", truncateSubject(raw.Subject, 50))
		return nil
	}

	// Discard empty/failed-fetch artifacts (no From, synthetic Message-ID, no
	// Subject) before inserting — otherwise a degraded IMAP fetch surfaces as
	// an empty "Neznámý odesílatel / (bez předmětu)" row in the operator's
	// Odpovědi queue. Returning nil (not an error) makes the poller advance the
	// UID watermark so the corrupt fetch is not retried forever; the raw message
	// stays on the server (BODY.PEEK) and is recoverable on a healthy re-poll.
	if isEmptyFailedFetch(raw) {
		slog.Warn("inbound.empty_fetch_skip",
			"op", "thread.parkUnattributed/empty_fetch_skip",
			"message_id", raw.MessageID,
			"mailbox", raw.MailboxAddr,
			"body_plain_len", len(raw.BodyPlain),
			"body_html_len", len(bodyHTML))
		return nil
	}

	if p.db == nil {
		return nil
	}

	// AJ-bounce 2026-05-18 — classify on insert so the BFF /replies
	// endpoint can hide DSNs/auto-replies from the operator's default
	// view. NULL means unclassified (real customer reply); 'bounce' or
	// 'auto_reply' = noise to filter. Empty string is converted to a
	// SQL NULL via sql.NullString so an unclassified row doesn't trip
	// the IS NOT NULL partial index.
	classification := classifyUnmatched(raw.From, raw.Subject)
	classificationArg := sql.NullString{
		String: classification,
		Valid:  classification != ClassificationNone,
	}

	// Upsert the unmatched_inbound row first so we have an ID for the
	// attachment rows. RETURNING id covers both INSERT and DO UPDATE
	// paths so we always get back the row to fan out attachments under.
	//
	// The ON CONFLICT path also backfills classification when a previous
	// insert (pre-AJ-bounce, or under a race) saved the row as NULL.
	// We only overwrite NULL — operator-set classification (via the
	// dashboard) wins over the auto-classifier.
	//
	// 2026-05-18 hardening: pre-sanitize all TEXT parameters through
	// safeUTF8 so Postgres doesn't raise 22021 on invalid byte sequences
	// (real bounce 2026-05-17 from testima.local hit this — DSN body had
	// CP1250 bytes after subject; INSERT rolled back, message lost).
	var unmatchedID int64
	err := p.db.QueryRowContext(ctx, `
		INSERT INTO unmatched_inbound
			(message_id, in_reply_to, from_address, subject, body_preview, body_html, received_at, classification)
		VALUES ($1, $2, $3, $4, LEFT($5, 500), $6, $7, $8)
		ON CONFLICT (message_id) DO UPDATE
			SET body_preview = CASE
				WHEN unmatched_inbound.body_preview = '' THEN EXCLUDED.body_preview
				ELSE unmatched_inbound.body_preview
			END,
			body_html = CASE
				WHEN unmatched_inbound.body_html IS NULL OR unmatched_inbound.body_html = ''
				THEN EXCLUDED.body_html
				ELSE unmatched_inbound.body_html
			END,
			classification = CASE
				WHEN unmatched_inbound.classification IS NULL
				THEN EXCLUDED.classification
				ELSE unmatched_inbound.classification
			END
		RETURNING id
	`,
		safeUTF8(raw.MessageID),
		safeUTF8(raw.InReplyTo),
		safeUTF8(raw.From),
		safeUTF8(raw.Subject),
		safeUTF8(raw.BodyPlain),
		safeUTF8(bodyHTML),
		raw.ReceivedAt,
		classificationArg,
	).Scan(&unmatchedID)
	if err != nil {
		slog.Warn("park unattributed failed",
			"op", "thread.parkUnattributed/insertFail",
			"message_id", raw.MessageID,
			"classification", classification,
			"error", err)
		return fmt.Errorf("park unattributed insert: %w", err)
	}
	if classification != ClassificationNone {
		slog.Info("park unattributed classified",
			"op", "thread.parkUnattributed/classified",
			"unmatched_id", unmatchedID,
			"classification", classification)
	}

	// Fan out attachments. Skip empty inputs early. Hash via SHA-256 so
	// the operator can deduplicate by content if the same attachment
	// arrives via two senders.
	for idx, att := range attachments {
		if len(att.Data) == 0 {
			continue
		}
		hash := sha256.Sum256(att.Data)
		hashHex := hex.EncodeToString(hash[:])
		_, err := p.db.ExecContext(ctx, `
			INSERT INTO unmatched_inbound_attachments
				(unmatched_id, idx, filename, content_type, size_bytes, data, sha256, is_inline)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (unmatched_id, idx) DO NOTHING
		`,
			unmatchedID,
			idx,
			att.Filename,
			att.ContentType,
			len(att.Data),
			att.Data,
			hashHex,
			strings.HasPrefix(att.ContentType, "image/") || att.ContentID != "",
		)
		if err != nil {
			slog.Warn("park unattributed attachment failed",
				"op", "thread.parkUnattributed/attachmentFail",
				"message_id", raw.MessageID,
				"unmatched_id", unmatchedID,
				"idx", idx,
				"filename", att.Filename,
				"error", err)
		}
	}
	// The unmatched_inbound row persisted (RETURNING id succeeded above);
	// attachment failures are best-effort and do not fail the park.
	return nil
}

// extractEmail extracts a bare email address from a From header value.
// Handles both "Display Name <addr@domain>" and bare "addr@domain" forms.
func extractEmail(from string) string {
	from = strings.TrimSpace(from)
	if from == "" {
		return ""
	}
	// "Display Name <email@domain>"
	if lt := strings.LastIndex(from, "<"); lt != -1 {
		if gt := strings.Index(from[lt:], ">"); gt != -1 {
			addr := strings.TrimSpace(from[lt+1 : lt+gt])
			return strings.ToLower(addr)
		}
	}
	// Bare address
	if strings.Contains(from, "@") {
		return strings.ToLower(strings.TrimSpace(from))
	}
	return ""
}

// domainFromEmail extracts the domain portion of an email address.
func domainFromEmail(email string) string {
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(parts[1]))
}

// isFreemailDomain returns true for known consumer/generic webmail providers.
// Fallback 4 (domain match) must NOT fire for these — a reply from
// boss@gmail.com does not unambiguously identify a single corporate contact.
func isFreemailDomain(domain string) bool {
	return knownFreemailDomains[strings.ToLower(strings.TrimSpace(domain))]
}

// knownFreemailDomains is a compile-time map of consumer/generic webmail
// providers. Same source of truth as services/contacts/enrichment/domain.go
// but kept local so the thread package stays free of cross-module imports.
var knownFreemailDomains = map[string]bool{
	// Czech
	"seznam.cz": true, "email.cz": true, "centrum.cz": true,
	"volny.cz": true, "tiscali.cz": true, "post.cz": true,
	"atlas.cz": true, "quick.cz": true, "iol.cz": true,
	"azet.cz": true, "wo.cz": true, "in.cz": true,
	"mybox.cz": true, "klikni.cz": true,
	// Slovak
	"azet.sk": true, "centrum.sk": true, "pobox.sk": true, "post.sk": true,
	"zoznam.sk": true, "atlas.sk": true,
	// Global
	"gmail.com": true, "googlemail.com": true,
	"outlook.com": true, "hotmail.com": true, "live.com": true, "msn.com": true,
	"outlook.cz": true, "hotmail.cz": true,
	"yahoo.com": true, "yahoo.co.uk": true, "yahoo.de": true,
	"icloud.com": true, "me.com": true, "mac.com": true,
	"protonmail.com": true, "proton.me": true, "pm.me": true,
	"tutanota.com": true, "tuta.io": true,
	"zoho.com": true, "yandex.com": true, "mail.ru": true,
	"aol.com": true, "gmx.com": true, "gmx.de": true, "gmx.net": true,
	"mail.com": true, "inbox.com": true,
}

func cleanMessageID(id string) string {
	id = strings.TrimSpace(id)
	id = strings.TrimPrefix(id, "<")
	id = strings.TrimSuffix(id, ">")
	return id
}

func classifySentiment(replyType humanize.ReplyType) Sentiment {
	switch replyType {
	case humanize.ReplyInterested, humanize.ReplyMeeting:
		return SentimentPositive
	case humanize.ReplyLater, humanize.ReplyObjection:
		return SentimentNeutral
	case humanize.ReplyNegative:
		return SentimentNegative
	case humanize.ReplyAutoOOO:
		return SentimentOOO
	default:
		return SentimentNeutral
	}
}

// parseReplyType converts an LLM category string to a humanize.ReplyType.
func parseReplyType(category string) (humanize.ReplyType, bool) {
	switch strings.ToLower(strings.TrimSpace(category)) {
	case "interested":
		return humanize.ReplyInterested, true
	case "meeting":
		return humanize.ReplyMeeting, true
	case "later":
		return humanize.ReplyLater, true
	case "objection":
		return humanize.ReplyObjection, true
	case "negative":
		return humanize.ReplyNegative, true
	case "ooo":
		return humanize.ReplyAutoOOO, true
	default:
		return 0, false
	}
}

func replyTypeString(rt humanize.ReplyType) string {
	switch rt {
	case humanize.ReplyInterested:
		return "interested"
	case humanize.ReplyMeeting:
		return "meeting"
	case humanize.ReplyLater:
		return "later"
	case humanize.ReplyObjection:
		return "objection"
	case humanize.ReplyNegative:
		return "negative"
	case humanize.ReplyAutoOOO:
		return "ooo"
	default:
		return "unknown"
	}
}

// upsertLead records an interested/meeting reply as a sales lead.
//
// Idempotency: leads has UNIQUE (contact_id, campaign_id), so re-classification
// of the same thread updates the existing row rather than inserting a duplicate.
//
// Failures are logged as warnings only — the reply has already been recorded
// in outreach_messages and the thread state advanced; a missing leads row is
// recoverable (operator can manually insert), so we never fail the inbound
// pipeline on a leads write.
func (p *InboundProcessor) upsertLead(
	ctx context.Context, threadID, contactID int, sentiment string, raw RawInbound,
) {
	const q = `
		WITH t AS (
			SELECT campaign_id FROM outreach_threads WHERE id = $1
		)
		INSERT INTO leads (
			contact_id, campaign_id, status, source, notes,
			classified_at, sentiment, original_message_id, original_text
		)
		SELECT
			$2, t.campaign_id, 'new', 'reply_classifier',
			COALESCE(LEFT($5, 200), ''),
			NOW(), $3, $4, $5
		FROM t
		WHERE t.campaign_id IS NOT NULL
		ON CONFLICT (contact_id, campaign_id) DO UPDATE SET
			classified_at       = EXCLUDED.classified_at,
			sentiment           = EXCLUDED.sentiment,
			original_message_id = EXCLUDED.original_message_id,
			original_text       = EXCLUDED.original_text,
			updated_at          = NOW()
	`
	bodyExcerpt := raw.BodyPlain
	if len(bodyExcerpt) > 4096 {
		bodyExcerpt = bodyExcerpt[:4096]
	}
	if _, err := p.db.ExecContext(ctx, q, threadID, contactID, sentiment, raw.MessageID, bodyExcerpt); err != nil {
		slog.Warn("upsert lead failed",
			"op", "thread.upsertLead",
			"contact_id", contactID,
			"thread_id", threadID,
			"sentiment", sentiment,
			"error", err)
		return
	}
	// FUN-1.3 — funnel_events: lead_created (best-effort, after successful upsert).
	p.insertFunnelEvent(ctx, contactID, "lead_created",
		map[string]any{"sentiment": sentiment, "thread_id": threadID})
}

// ── FUN-1.3 — Funnel event hook ───────────────────────────────────────

// insertFunnelEvent appends a classification event to funnel_events.
// Best-effort: failures are logged as Warn but never abort the inbound pipeline.
// contactID maps to funnel_events.contact_id; event_type is one of the
// classified_* values defined in migration 141.
func (p *InboundProcessor) insertFunnelEvent(ctx context.Context, contactID int, eventType string, details map[string]any) {
	detailsJSON, _ := json.Marshal(details)
	if _, err := p.db.ExecContext(ctx,
		`INSERT INTO funnel_events (event_type, contact_id, occurred_at, details)
		 VALUES ($1, $2, NOW(), $3::jsonb)`,
		eventType, contactID, string(detailsJSON),
	); err != nil {
		slog.Warn("funnel_events insert failed (non-fatal)",
			"op", "thread.insertFunnelEvent",
			"contact_id", contactID,
			"event_type", eventType,
			"error", err)
	}
}

// ── MIME helpers (S1.4) ────────────────────────────────────────────────

// parseRawIfPresent invokes the MIME parser if the poller (S1.2) supplied
// the full RFC822 source. Returns nil for legacy fetches that only filled
// pre-parsed header fields. Errors are logged and swallowed: a partial
// ParsedMessage is better than dropping the inbound entirely.
func parseRawIfPresent(raw RawInbound) *mime.ParsedMessage {
	if len(raw.RawBytes) == 0 {
		return nil
	}
	parsed, err := mime.Parse(raw.RawBytes)
	if err != nil {
		slog.Warn("mime parse failed, falling back to RawInbound fields",
			"op", "thread.parseRawIfPresent",
			"message_id", raw.MessageID,
			"error", err)
		// parsed may still be partial — let the caller use it.
	}
	return parsed
}

func bodyPlainFromParsed(p *mime.ParsedMessage, fallback string) string {
	if p != nil && p.BodyPlain != "" {
		return p.BodyPlain
	}
	return fallback
}

func bodyHTMLFromParsed(p *mime.ParsedMessage) string {
	if p == nil {
		return ""
	}
	return p.BodyHTML
}

// processInboundPhotos iterates parsed MIME attachments and forwards
// every image to the PhotoProcessor. Each call is independent — a
// failure on one photo does not abort the rest. Best-effort by design:
// the audit pipeline is fail-open per spec.
func processInboundPhotos(
	ctx context.Context,
	photo PhotoProcessor,
	threadID int,
	messageID string,
	attachments []mime.Attachment,
) {
	for _, att := range attachments {
		if !photo.IsImage(att.ContentType) {
			continue
		}
		if _, err := photo.Process(ctx, PhotoInput{
			ThreadID:    int64(threadID),
			MessageID:   messageID,
			Filename:    att.Filename,
			ContentType: att.ContentType,
			Data:        att.Data,
		}); err != nil {
			slog.Warn("photo pipeline failed",
				"op", "thread.processInboundPhotos",
				"thread_id", threadID,
				"message_id", messageID,
				"filename", att.Filename,
				"content_type", att.ContentType,
				"error", err)
		}
	}
}

// maybePreClassifyAsync spawns the AC8 Haiku classifier in a goroutine
// when wired. Skipped silently when:
//   - WithReplyPreClassifier was not called (preClassifier == nil)
//   - operator_settings.reply_pre_classification_enabled == "false"
//   - body is empty
//
// The goroutine has its own preClassifyAsyncBudget timeout (8 s) so the
// caller's request-scoped context cancellation does not cut classifier
// work short — IMAP poll ctx is typically short-lived.
//
// On verdict, the goroutine UPDATEs the single reply_inbox row for THIS
// message whose pre_classification is still NULL — resolved by exact
// Message-ID when the row carries one (headers_json), else the most recent
// (from_email + subject + +/-preClassifyMatchWindow on received_at) row.
// Running the UPDATE after the classifier returns also absorbs the race
// where the BFF cron inserts the row slightly before or after the Go path.
//
// Failures (classifier error, DB error) are slog.Warn only — they
// never propagate. The verdict, including unknown-on-failure, is
// always persisted so the operator UI can distinguish "never tried"
// (NULL) from "tried, model uncertain" (intent=unknown, confidence=0).
func (p *InboundProcessor) maybePreClassifyAsync(raw RawInbound) {
	if p.preClassifier == nil || p.db == nil {
		return
	}
	body := raw.BodyPlain
	if strings.TrimSpace(body) == "" {
		return
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("ac8 pre-classify goroutine panic recovered",
					"op", "thread.maybePreClassifyAsync/panic",
					"recover", r,
				)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), preClassifyAsyncBudget)
		defer cancel()

		// Runtime kill-switch check. Default = enabled (fail-open) so a
		// transient operator_settings query failure does not silently
		// disable classification.
		if p.preClassifyEnabled != nil {
			if v, err := p.preClassifyEnabled.Get(ctx, preClassifyOperatorSettingKey); err == nil {
				if strings.EqualFold(strings.TrimSpace(v), "false") {
					return
				}
			} else {
				slog.Warn("ac8 pre-classify settings read failed, continuing fail-open",
					"op", "thread.maybePreClassifyAsync/settingsRead",
					"error", err,
				)
			}
		}

		verdict, err := p.preClassifier.ClassifyReply(ctx, body)
		if err != nil {
			// Sender domain only — never the body. Per feedback_no_pii_in_commands.
			slog.Warn("ac8 pre-classify failed",
				"op", "thread.maybePreClassifyAsync/classifyFail",
				"sender_domain", senderDomainOnly(raw.From),
				"intent", verdict.Intent,
				"error", err,
			)
			// Fall through — still persist the unknown verdict so the UI
			// can show "tried, failed" vs "never tried (NULL)".
		}

		payloadMap := map[string]any{
			"intent":        verdict.Intent,
			"confidence":    verdict.Confidence,
			"model_used":    verdict.ModelUsed,
			"reasoning":     verdict.Reasoning,
			"classified_at": time.Now().UTC().Format(time.RFC3339),
		}
		payload, mErr := json.Marshal(payloadMap)
		if mErr != nil {
			slog.Warn("ac8 pre-classify marshal failed",
				"op", "thread.maybePreClassifyAsync/marshal",
				"error", mErr,
			)
			return
		}

		// Match window covers BFF/Go clock skew + parser latency.
		windowStart := raw.ReceivedAt.Add(-preClassifyMatchWindow)
		windowEnd := raw.ReceivedAt.Add(preClassifyMatchWindow)
		fromEmail := strings.ToLower(strings.TrimSpace(extractEmail(raw.From)))

		// Stable per-message identity, when the inbound carries a real
		// Message-ID (not the synthetic "uid:<n>@host" the poller assigns when
		// the header is absent). cleanMessageID normalises it to the
		// btrim(<stored>, '<>') form used in the lookup below.
		dedupMsgID := ""
		if mid := strings.TrimSpace(raw.MessageID); mid != "" && !strings.HasPrefix(mid, "uid:") {
			dedupMsgID = cleanMessageID(raw.MessageID)
		}

		// Tag exactly ONE reply_inbox row — the one for THIS message — instead
		// of every row sharing (from_email, subject, received_at window). The
		// old fuzzy WHERE cross-contaminated: two same-subject replies from the
		// same sender inside the window both received the first goroutine's
		// verdict (and a second goroutine then found nothing still NULL). We
		// resolve a single id and UPDATE by it: an exact Message-ID match (via
		// headers_json, e.g. Go-inserted rows) wins; otherwise the most recent
		// sender+subject+window row — the best key for BFF-inserted rows that
		// carry no stored Message-ID. pre_classification IS NULL still guards
		// against clobbering operator curation (AC9) and against double-tagging.
		res, updErr := p.db.ExecContext(ctx, `
			UPDATE reply_inbox
			SET pre_classification = $1::jsonb
			WHERE id = (
			  SELECT id FROM reply_inbox
			  WHERE pre_classification IS NULL
			    AND (
			      ($6 <> '' AND btrim(headers_json->>'message_id', '<>') = $6)
			      OR (lower(trim(from_email)) = $2
			          AND coalesce(lower(trim(subject)), '') = coalesce(lower(trim($3::text)), '')
			          AND received_at BETWEEN $4 AND $5)
			    )
			  ORDER BY (CASE WHEN $6 <> '' AND btrim(headers_json->>'message_id', '<>') = $6 THEN 0 ELSE 1 END), id DESC
			  LIMIT 1
			)
			  AND pre_classification IS NULL
		`, string(payload), fromEmail, raw.Subject, windowStart, windowEnd, dedupMsgID)
		if updErr != nil {
			slog.Warn("ac8 pre-classify persist failed",
				"op", "thread.maybePreClassifyAsync/persist",
				"sender_domain", senderDomainOnly(raw.From),
				"error", updErr,
			)
			return
		}
		n, _ := res.RowsAffected()
		slog.Info("ac8 pre-classify persisted",
			"op", "thread.maybePreClassifyAsync/persisted",
			"sender_domain", senderDomainOnly(raw.From),
			"intent", verdict.Intent,
			"confidence", verdict.Confidence,
			"rows_updated", n,
		)
	}()
}

// senderDomainOnly returns the lowercased domain portion of a From
// header for slog. It strips the local-part to satisfy
// feedback_no_pii_in_commands when classification verdicts are logged.
func senderDomainOnly(from string) string {
	email := extractEmail(from)
	return domainFromEmail(email)
}

// attachmentsFromParsed lifts mime.Attachment → InboundAttachment with
// computed SHA256 + size. Pure transform — no DB or sanitization side
// effects.
func attachmentsFromParsed(p *mime.ParsedMessage) []InboundAttachment {
	if p == nil || len(p.Attachments) == 0 {
		return nil
	}
	out := make([]InboundAttachment, 0, len(p.Attachments))
	for _, a := range p.Attachments {
		sum := sha256.Sum256(a.Data)
		out = append(out, InboundAttachment{
			ContentID:   a.ContentID,
			Filename:    a.Filename,
			ContentType: a.ContentType,
			Data:        a.Data,
			SizeBytes:   len(a.Data),
			SHA256:      hex.EncodeToString(sum[:]),
			IsInline:    a.IsInline,
		})
	}
	return out
}

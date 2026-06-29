package sender

// Anonymity-bundle header builders.
//
// Three header-level leaks were measured at 17/100 on the 2026-05-01 brutal
// anonymity test:
//
//   1. Message-ID: per-envelope only — same recipient pulled the same ID
//      across batches, breaking per-recipient unlinkability.
//   2. From: bare email "info@firma.cz" without a display name — RFC 5322
//      legitimate clients ship "Display Name <local@domain>"; bare-address
//      From is a strong webmail-vs-bot signal.
//   3. Date: server local timezone (always +0200 Prague) regardless of the
//      sending mailbox's actual locale. Implicit beats explicit nothing —
//      the mailbox's tz from outreach_mailboxes.tz is the source of truth.
//
// These helpers are the single canonical construction site invoked from
// engine.go right before antiTrace.Send. They override anything the
// humanize fingerprint layer wrote so the relay receives the
// anonymity-correct values.
//
// Source: docs/subsystem-maps/anti-trace.md G7 → G10 (the headers
// override happens between humanize and relay submit).
//
// Audit ratchet: services/campaigns/sender/message_id_audit_test.go.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode"
)

// generateEnvelopeID returns a fresh 16-byte hex envelope id used as input
// to the Message-ID HMAC. crypto/rand failure falls through to a
// nanosecond-based id so a kernel RNG hiccup never drops a send. The
// fallback is still unique per send; the downstream HMAC blends it with
// the recipient address so two sends to the same recipient at the same
// nanosecond would still produce different IDs.
func generateEnvelopeID() string {
	var buf [16]byte
	if _, err := randRead(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	return fmt.Sprintf("%016x", time.Now().UnixNano())
}

// BuildMessageIDHeader builds the per-recipient Message-ID header value
// per the format `<{hex16}.{nanos}@{domain}>` where:
//
//	{hex16} = HMAC-SHA256(recipient + envelopeID, hmacKey)[:16] hex
//	{nanos} = current Unix epoch nanoseconds
//	{domain} = sender's mailbox FQDN, derived from fromAddress
//
// Recipient is part of the HMAC input so two sends to the same recipient
// from the same envelope still produce a stable per-recipient identifier
// the relay's bounce dedupe can match against.
//
// hmacKey MUST be ≥32 bytes after env-var b64-decode; the caller validates
// at boot. A nil/empty key falls back to the legacy generateMessageID path
// rather than panicking — defence in depth, never drop a send because the
// operator misconfigured an env var.
func BuildMessageIDHeader(recipient, envelopeID, fromAddress string, hmacKey []byte, now time.Time) string {
	domain := domainOf(fromAddress)
	if domain == "" {
		domain = "alias.local"
	}
	if len(hmacKey) == 0 {
		// Defensive — caller boot path should have validated. Use the
		// existing generateMessageID shape so downstream parsers don't
		// see two different formats.
		return "<" + generateMessageID(fromAddress) + ">"
	}

	h := hmac.New(sha256.New, hmacKey)
	h.Write([]byte(recipient))
	h.Write([]byte(envelopeID))
	digest := h.Sum(nil)
	hexed := hex.EncodeToString(digest[:8]) // 16 hex chars

	return fmt.Sprintf("<%s.%d@%s>", hexed, now.UnixNano(), domain)
}

// BuildFromHeader produces an RFC 5322 "Display Name <email@domain>"
// From value. When displayName is empty, the local-part of email is
// title-cased ("a.mazher" → "A. Mazher", "jan.novak" → "Jan Novak")
// as a per-mailbox fallback so we never emit a bare-address From.
//
// CRLF characters in displayName are stripped before formatting so the
// function is safe regardless of call site — not just when the result
// passes through buildMessage.stripCRLF. This is a defence-in-depth
// measure: the adversarial red-team sweep (2026-05-05, F2) found that a
// display name containing "\r\n" produced a raw header-split before
// buildMessage's strip ran, creating a gap for any future caller that
// doesn't go through buildMessage.
func BuildFromHeader(displayName, email string) string {
	// Strip CRLF at function boundary so the result is unconditionally safe.
	displayName = strings.NewReplacer("\r", "", "\n", "").Replace(displayName)
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = titleCaseLocalPart(email)
	}
	if displayName == "" {
		// Nothing usable — emit bare email rather than malformed " <email>".
		return email
	}
	return fmt.Sprintf("%s <%s>", quoteIfNeeded(displayName), email)
}

// quoteIfNeeded wraps a display name in double quotes when it contains
// any of the RFC 5322 "specials" that would otherwise terminate the
// display-name token. Keeps the common case ("Jan Novak", "A. Mazher")
// unquoted so the wire format stays human-readable.
//
// "." is intentionally NOT in the trigger set — RFC 5322 §3.2.3 makes
// "." an atext-extension-allowed character inside the obs-phrase
// production used by historic mailers; the Go stdlib mail.ParseAddress
// accepts unquoted "A. Mazher". Webmail clients rely on this — quoting
// "A. Mazher" would render as `"A. Mazher" <addr>` and look bot-like.
func quoteIfNeeded(name string) string {
	if strings.ContainsAny(name, `()<>[]:;@\,"`) {
		// Backslash-escape any embedded quotes/backslashes per RFC 5322
		// §3.2.4 quoted-string production.
		escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(name)
		return `"` + escaped + `"`
	}
	return name
}

// titleCaseLocalPart converts a bare email's local part into a
// human-presentable display name. Heuristic: split on '.', '_', '-',
// title-case each token, and append a period after the first token if
// it's a single letter — mimicking "first-initial. surname" patterns
// common in Central European webmail.
//
//	"a.mazher"     → "A. Mazher"
//	"jan.novak"    → "Jan Novak"
//	"info"         → "Info"
//	"sales_team"   → "Sales Team"
//	""             → ""
//
// This is intentionally minimal — operators who want a proper display
// name set outreach_mailboxes.display_name. The fallback only fires
// when display_name is NULL/empty.
func titleCaseLocalPart(email string) string {
	at := strings.IndexByte(email, '@')
	if at < 0 {
		at = len(email)
	}
	local := email[:at]
	if local == "" {
		return ""
	}
	rep := strings.NewReplacer(".", " ", "_", " ", "-", " ")
	cleaned := rep.Replace(local)
	tokens := strings.Fields(cleaned)
	if len(tokens) == 0 {
		return ""
	}
	for i, tok := range tokens {
		tokens[i] = titleWord(tok)
	}
	if len([]rune(tokens[0])) == 1 {
		tokens[0] = tokens[0] + "."
	}
	return strings.Join(tokens, " ")
}

// titleWord upper-cases the first rune and lower-cases the rest.
// Uses unicode.ToUpper / ToLower so non-ASCII names round-trip
// correctly ("nováková" → "Nováková").
func titleWord(s string) string {
	if s == "" {
		return s
	}
	runes := []rune(s)
	runes[0] = unicode.ToUpper(runes[0])
	for i := 1; i < len(runes); i++ {
		runes[i] = unicode.ToLower(runes[i])
	}
	return string(runes)
}

// BuildDateHeader formats now in the mailbox's IANA timezone per
// RFC 5322 §3.3 ("Mon, 02 Jan 2006 15:04:05 -0700"). When tz is empty
// or unparseable, falls back to "Europe/Prague" — never UTC, because a
// Prague-based mailbox emitting UTC dates is a strong bot signal even
// when the underlying server lives on Railway's US datacenter.
//
// tz must be an IANA name accepted by time.LoadLocation
// ("Europe/Prague", "Europe/Stockholm", "America/New_York"). Anything
// else collapses to the safe Prague default — this function does not
// propagate the error so a bad tz value never drops a send.
func BuildDateHeader(tz string, now time.Time) string {
	loc := loadLocationOrDefault(tz)
	return now.In(loc).Format("Mon, 02 Jan 2006 15:04:05 -0700")
}

// loadLocationOrDefault loads tz, falling back to "Europe/Prague".
// Returns time.UTC only when even the fallback fails (degenerate
// tzdata-less environment).
func loadLocationOrDefault(tz string) *time.Location {
	if tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			return loc
		}
	}
	if loc, err := time.LoadLocation("Europe/Prague"); err == nil {
		return loc
	}
	return time.UTC
}

// maxReferencesChainDepth is the maximum number of Message-IDs emitted in
// the References header. RFC 5322 §3.6.4 has no hard cap, but long chains
// waste wire bytes and most MUA thread matchers only look at the last few
// entries. Ten is the consensus sweet spot — enough to maintain threading
// across the longest reasonable outreach sequence (MaxSequenceSteps=12)
// while staying well under any header-line-length concern.
const maxReferencesChainDepth = 10

// BuildThreadHeaders produces the RFC 5322 §3.6.4 thread-linking header
// values for a follow-up email. It must only be called for Step > 0;
// the runner is responsible for that gate.
//
// inReplyTo is the Message-ID of the immediately preceding send (step-1).
// references is the ordered chain of all prior Message-IDs, oldest first,
// newest last — it includes inReplyTo as the last element.
//
// Rules applied:
//   - If inReplyTo is empty: returns empty strings (caller should not set
//     In-Reply-To or References at all).
//   - If references is longer than maxReferencesChainDepth: keep the
//     newest maxReferencesChainDepth entries (latest-first truncation so
//     the immediate parent is always retained).
//   - Each ID is wrapped in angle brackets if not already wrapped, and
//     CR/LF is stripped (injection guard).
//   - Multiple IDs are joined with ", " per RFC 5322 §3.6.4.
//
// Returns the ready-to-use header values (not the "Key: " prefix).
func BuildThreadHeaders(inReplyTo string, references []string) (inReplyToVal, referencesVal string) {
	stripCRLF := strings.NewReplacer("\r", "", "\n", "").Replace

	if inReplyTo == "" {
		return "", ""
	}
	inReplyToVal = wrapAngleBrackets(stripCRLF(inReplyTo))

	// Truncate to newest maxReferencesChainDepth entries.
	chain := references
	if len(chain) > maxReferencesChainDepth {
		chain = chain[len(chain)-maxReferencesChainDepth:]
	}

	parts := make([]string, 0, len(chain))
	for _, id := range chain {
		id = stripCRLF(id)
		if id == "" {
			continue
		}
		parts = append(parts, wrapAngleBrackets(id))
	}
	if len(parts) > 0 {
		referencesVal = strings.Join(parts, ", ")
	}
	return inReplyToVal, referencesVal
}

// wrapAngleBrackets ensures a Message-ID value is enclosed in "<" and ">".
// If the value already starts with "<", it is returned as-is (preserves
// existing angle brackets from BuildMessageIDHeader output).
func wrapAngleBrackets(id string) string {
	if strings.HasPrefix(id, "<") {
		return id
	}
	return "<" + id + ">"
}

// BuildListUnsubscribeHeaders returns the RFC 2369 / RFC 8058 header pair
// that every outbound campaign mail must carry:
//
//	List-Unsubscribe: <https://…/unsubscribe?c=C&id=I&t=TOKEN>
//	List-Unsubscribe-Post: List-Unsubscribe=One-Click
//
// unsubURL is the per-recipient URL already computed by
// campaign/runner.go buildUnsubURL (HMAC-SHA256 over campaign_id|contact_id|email,
// validated by the BFF /unsubscribe handler). The header value wraps it in
// angle-brackets per RFC 2369 §2.
//
// Both values are CRLF-stripped before return so injecting them into
// req.Headers is safe regardless of what URL the caller passes — defence
// in depth against URL values that sneak in newlines.
//
// If unsubURL is empty the function returns empty strings. The caller
// (runner.go) already guarantees a non-empty URL when UNSUBSCRIBE_SECRET
// (or its OUTREACH_API_KEY fallback) is set; the empty-return path is a
// safety valve for mis-configured envs that never produce a usable URL.
func BuildListUnsubscribeHeaders(unsubURL string) (listUnsub, listUnsubPost string) {
	if unsubURL == "" {
		return "", ""
	}
	stripCRLF := strings.NewReplacer("\r", "", "\n", "").Replace
	safe := stripCRLF(unsubURL)
	if safe == "" {
		return "", ""
	}
	return "<" + safe + ">", "List-Unsubscribe=One-Click"
}

// BuildListUnsubscribeToken computes a base64url-encoded HMAC-SHA256 token
// bound to (sendEventID, contactID) under secret. This is the token embedded
// inside the List-Unsubscribe URL for per-send auditability.
//
// The token is 32 bytes (256 bits) of HMAC-SHA256, base64url-encoded without
// padding. When secret is nil or empty the function returns an empty string so
// callers can detect a missing-secret condition and fail-closed.
//
// sendEventID is a string key for the specific send event (typically the
// campaign_contacts PK or a UUID), giving each send its own revokeable token.
func BuildListUnsubscribeToken(sendEventID string, contactID int64, secret []byte) string {
	if len(secret) == 0 {
		return ""
	}
	h := hmac.New(sha256.New, secret)
	fmt.Fprintf(h, "%s||%d", sendEventID, contactID)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// applyAnonymityHeaders writes the three anonymity-bundle headers
// (Message-ID, From, Date) into dst, overriding any values the
// humanize fingerprint layer wrote upstream. Returns the new
// envelope id used so the caller can log/audit it.
//
// The argument shape is intentionally narrow — all three values are
// computed in one place so a future fourth anonymity header (e.g.
// User-Agent suppression) can hook in without surgery on engine.go.
func applyAnonymityHeaders(
	dst map[string]string,
	recipient string,
	mailboxAddress, mailboxDisplayName, mailboxTimezone string,
	hmacKey []byte,
	now time.Time,
) (envelopeID, messageID, fromHeader, dateHeader string) {
	envelopeID = generateEnvelopeID()
	messageID = BuildMessageIDHeader(recipient, envelopeID, mailboxAddress, hmacKey, now)
	fromHeader = BuildFromHeader(mailboxDisplayName, mailboxAddress)
	dateHeader = BuildDateHeader(mailboxTimezone, now)

	if dst == nil {
		return envelopeID, messageID, fromHeader, dateHeader
	}
	dst["Message-ID"] = messageID
	dst["From"] = fromHeader
	dst["Date"] = dateHeader
	return envelopeID, messageID, fromHeader, dateHeader
}

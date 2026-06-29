package mailsim

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// ReplyBuilder generates synthetic Czech-language replies that match
// each reply Behavior. The wording is deliberately varied so the
// production intelligence-loop classifier (which categorises replies
// into interested/meeting/later/objection/negative/ooo) has realistic
// signal to work with.
type ReplyBuilder struct {
	// HostDomain is appended to generated Message-IDs so they look
	// authentic. Must match the recipient's domain in production
	// traces.
	HostDomain string
}

// DefaultReplyBuilder uses a neutral test hostname.
func DefaultReplyBuilder() *ReplyBuilder {
	return &ReplyBuilder{HostDomain: "mail.prospect.test"}
}

// Build constructs an RFC 822 reply message from `original` with the
// content driven by `beh`. OOO replies set Auto-Submitted: auto-replied
// per RFC 3834; other replies are tagged as normal human messages.
func (r *ReplyBuilder) Build(original *OriginalMessage, beh Behavior, replyFrom string) ([]byte, error) {
	if !beh.IsReply() && beh != BehaviorOOO {
		return nil, fmt.Errorf("mailsim: behavior %q does not produce a reply", beh)
	}

	subject := "Re: " + original.Subject
	msgID := fmt.Sprintf("<reply-%s@%s>", randomID(), r.HostDomain)
	now := time.Now().UTC()

	body := bodyFor(beh, original)

	var sb strings.Builder
	fmt.Fprintf(&sb, "From: %s\r\n", replyFrom)
	fmt.Fprintf(&sb, "To: %s\r\n", original.From)
	fmt.Fprintf(&sb, "Subject: %s\r\n", subject)
	fmt.Fprintf(&sb, "Date: %s\r\n", now.Format(time.RFC1123Z))
	fmt.Fprintf(&sb, "Message-ID: %s\r\n", msgID)
	if original.MessageID != "" {
		fmt.Fprintf(&sb, "In-Reply-To: %s\r\n", bracketed(original.MessageID))
		fmt.Fprintf(&sb, "References: %s\r\n", bracketed(original.MessageID))
	}
	// OOO replies: RFC 3834 tags so downstream doesn't treat them as
	// genuine human replies in certain paths.
	if beh == BehaviorOOO {
		sb.WriteString("Auto-Submitted: auto-replied (vacation)\r\n")
		sb.WriteString("X-Auto-Response-Suppress: All\r\n")
		sb.WriteString("Precedence: bulk\r\n")
	}
	sb.WriteString("MIME-Version: 1.0\r\n")
	sb.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	sb.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	sb.WriteString("\r\n")
	sb.WriteString(body)
	sb.WriteString("\r\n")

	return []byte(sb.String()), nil
}

// bodyFor returns a plain-text reply body for the given behaviour.
// Multiple variants per behaviour are included so a batch of replies
// produces natural-looking variety (we rotate on the original Message-ID
// hash so output stays deterministic).
func bodyFor(beh Behavior, original *OriginalMessage) string {
	idx := hashVariant(original.MessageID)
	switch beh {
	case BehaviorReplyInterested:
		v := []string{
			"Dobrý den,\r\n\r\nděkuji za zprávu. Ano, o Vaší nabídku máme zájem. Prosím pošlete více podrobností.\r\n\r\nS pozdravem",
			"Zdravím,\r\n\r\nVaše nabídka mě zaujala. Rád bych si o ní zavolal — dejte vědět, kdy se Vám to hodí.\r\n\r\nDěkuji",
			"Dobrý den,\r\n\r\nurčitě nás to zajímá. Pošlete prosím cenovou nabídku a podmínky.\r\n\r\nDíky",
		}
		return v[idx%len(v)]
	case BehaviorReplyMeeting:
		v := []string{
			"Dobrý den,\r\n\r\nrád bych se sešel. Co takhle ve středu od 10:00 u nás v kanceláři?\r\n\r\nS pozdravem",
			"Zdravím,\r\n\r\nmůžeme si zavolat tento pátek ve 14:00? Pošlete prosím odkaz na Meet.\r\n\r\nDěkuji",
			"Dobrý den,\r\n\r\nnavrhuji schůzku příští úterý dopoledne. Vyhovuje Vám?\r\n\r\nDíky",
		}
		return v[idx%len(v)]
	case BehaviorReplyLater:
		v := []string{
			"Dobrý den,\r\n\r\naktuálně jsme plně vytíženi. Mohli bychom se ozvat zpět za 2 měsíce?\r\n\r\nS pozdravem",
			"Zdravím,\r\n\r\npozději to bude asi lepší — zkuste prosím ozvat se v září.\r\n\r\nDěkuji",
			"Dobrý den,\r\n\r\nnyní to není priorita. Ozvěte se, prosím, za půl roku.\r\n\r\nDíky",
		}
		return v[idx%len(v)]
	case BehaviorReplyObjection:
		v := []string{
			"Dobrý den,\r\n\r\ncena je pro nás vysoká. Máte nějaký lepší návrh?\r\n\r\nS pozdravem",
			"Zdravím,\r\n\r\nv podobné oblasti už spolupracujeme s konkurencí. Co nabízíte navíc?\r\n\r\nDěkuji",
			"Dobrý den,\r\n\r\npodmínky nesedí našim interním pravidlům. Mohli bychom je upravit?\r\n\r\nDíky",
		}
		return v[idx%len(v)]
	case BehaviorReplyNegative:
		v := []string{
			"Dobrý den,\r\n\r\nneodepisujte mi prosím. Odstraňte mě ze své databáze.\r\n\r\nDěkuji",
			"Zdravím,\r\n\r\nprosím, nezasílejte další e-maily. Opt-out.\r\n\r\nS pozdravem",
			"Dobrý den,\r\n\r\no spolupráci nemáme zájem a žádám o výmaz osobních údajů.\r\n\r\nDíky",
		}
		return v[idx%len(v)]
	case BehaviorOOO:
		v := []string{
			"Dobrý den,\r\n\r\nDěkuji za Váš e-mail. Jsem mimo kancelář do 30. dubna.\r\nV urgentních případech kontaktujte kolegy.\r\n\r\nS pozdravem",
			"Hello,\r\n\r\nI am currently out of office and will return on May 2nd.\r\nFor urgent matters please contact my colleague.\r\n\r\nBest regards",
			"Dobrý den,\r\n\r\naktuálně jsem na dovolené do 5. května. E-maily budu vyřizovat po návratu.\r\n\r\nDěkuji za pochopení",
		}
		return v[idx%len(v)]
	}
	return "Dobrý den,\r\n\r\nDěkuji za zprávu.\r\n\r\nS pozdravem\r\n"
}

// hashVariant picks a stable variant index from a Message-ID so the
// same original always gets the same reply wording. Deterministic
// across runs even without a seeded RNG.
func hashVariant(messageID string) int {
	if messageID == "" {
		return 0
	}
	// Use first 4 bytes of the ID as an integer seed.
	sum := 0
	for i := 0; i < len(messageID) && i < 16; i++ {
		sum = sum*31 + int(messageID[i])
	}
	if sum < 0 {
		sum = -sum
	}
	return sum
}

// randomID returns a 16-char hex token used in generated Message-IDs.
func randomID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

package policy

import (
	"context"
	"errors"
	"fmt"
	netmail "net/mail"
	"strings"
	"unicode/utf8"

	"privacy-gateway/internal/alias"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
)

var (
	ErrNoRecipients      = errors.New("at least one recipient is required")
	ErrTooManyRecipients = errors.New("recipient count exceeds policy")
	ErrEmptyBody         = errors.New("text body is required")
	ErrHTMLNotSupported  = errors.New("html body is not supported in MVP")
	ErrMessageTooLarge   = errors.New("message exceeds size limit")
	ErrInvalidRecipient  = errors.New("recipient address is invalid")
	ErrInvalidSubject    = errors.New("subject contains invalid UTF-8")
)

type Service struct {
	aliases         *alias.Service
	gateway         mail.Gateway
	maxRecipients   int
	maxMessageBytes int
}

func NewService(aliases *alias.Service, gateway mail.Gateway, maxRecipients, maxMessageBytes int) *Service {
	return &Service{
		aliases:         aliases,
		gateway:         gateway,
		maxRecipients:   maxRecipients,
		maxMessageBytes: maxMessageBytes,
	}
}

func (s *Service) Submit(ctx context.Context, actor model.Actor, input model.SendMessageInput) (model.MessageRecord, error) {
	if strings.TrimSpace(input.HTMLBody) != "" {
		return model.MessageRecord{}, ErrHTMLNotSupported
	}
	if len(input.To) == 0 {
		return model.MessageRecord{}, ErrNoRecipients
	}
	if len(input.To) > s.maxRecipients {
		return model.MessageRecord{}, ErrTooManyRecipients
	}
	subject := strings.TrimSpace(input.Subject)
	if !utf8.ValidString(subject) || strings.ContainsAny(subject, "\r\n") {
		return model.MessageRecord{}, ErrInvalidSubject
	}

	body := strings.TrimSpace(input.TextBody)
	if body == "" {
		return model.MessageRecord{}, ErrEmptyBody
	}

	recipients := make([]string, 0, len(input.To))
	seen := make(map[string]struct{}, len(input.To))
	for _, raw := range input.To {
		normalized, err := normalizeAddress(raw)
		if err != nil {
			return model.MessageRecord{}, fmt.Errorf("%w: %s", ErrInvalidRecipient, raw)
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		recipients = append(recipients, normalized)
	}

	if len(recipients) == 0 {
		return model.MessageRecord{}, ErrNoRecipients
	}

	sizeEstimate := len(input.Subject) + len(body)
	for _, recipient := range recipients {
		sizeEstimate += len(recipient)
	}
	if sizeEstimate > s.maxMessageBytes {
		return model.MessageRecord{}, ErrMessageTooLarge
	}

	senderAlias, err := s.aliases.GetOwned(ctx, actor, strings.TrimSpace(input.AliasID))
	if err != nil {
		return model.MessageRecord{}, err
	}

	msg := model.SanitizedMessage{
		Actor:     actor,
		Alias:     senderAlias,
		To:        recipients,
		Subject:   subject,
		TextBody:  body,
		CreatedAt: senderAlias.CreatedAt,
	}

	return s.gateway.Send(ctx, msg)
}

func normalizeAddress(value string) (string, error) {
	addr, err := netmail.ParseAddress(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return strings.ToLower(addr.Address), nil
}

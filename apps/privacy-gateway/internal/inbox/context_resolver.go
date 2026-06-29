package inbox

import (
	"context"
	"strings"

	"privacy-gateway/internal/model"
)

type AliasLookup interface {
	ListForActor(ctx context.Context, actor model.Actor) ([]model.Alias, error)
}

type SubmissionLookup interface {
	ListForActor(ctx context.Context, actor model.Actor) ([]model.Submission, error)
}

func NewContextResolver(aliases AliasLookup, submissions SubmissionLookup) MessageResolver {
	if aliases == nil || submissions == nil {
		return nil
	}

	return MessageResolverFunc(func(ctx context.Context, actor model.Actor, msg model.InboxMessage) (model.InboxMessage, error) {
		resolved := msg

		ownedAliases, err := aliases.ListForActor(ctx, actor)
		if err != nil {
			return model.InboxMessage{}, err
		}
		for _, item := range ownedAliases {
			if strings.EqualFold(strings.TrimSpace(item.Email), strings.TrimSpace(msg.AliasEmail)) {
				resolved.AliasID = item.ID
				break
			}
		}
		if resolved.AliasID == "" {
			return resolved, nil
		}

		records, err := submissions.ListForActor(ctx, actor)
		if err != nil {
			return model.InboxMessage{}, err
		}
		normalizedSubject := normalizeCorrelationSubject(msg.Subject)
		fromAddress := strings.ToLower(strings.TrimSpace(msg.From))
		if normalizedSubject == "" || fromAddress == "" {
			return resolved, nil
		}

		for _, item := range records {
			if item.SubmittedBy != actor.ID {
				continue
			}
			if item.ChannelID != resolved.AliasID {
				continue
			}
			if !submissionContainsRecipient(item, fromAddress) {
				continue
			}
			if normalizeCorrelationSubject(item.Subject) != normalizedSubject {
				continue
			}
			resolved.SubmissionID = item.ID
			break
		}

		return resolved, nil
	})
}

func submissionContainsRecipient(item model.Submission, address string) bool {
	for _, recipient := range item.To {
		if strings.EqualFold(strings.TrimSpace(recipient), address) {
			return true
		}
	}
	return false
}

func normalizeCorrelationSubject(value string) string {
	subject := strings.ToLower(strings.TrimSpace(value))
	for {
		switch {
		case strings.HasPrefix(subject, "re:"):
			subject = strings.TrimSpace(strings.TrimPrefix(subject, "re:"))
		case strings.HasPrefix(subject, "fw:"):
			subject = strings.TrimSpace(strings.TrimPrefix(subject, "fw:"))
		case strings.HasPrefix(subject, "fwd:"):
			subject = strings.TrimSpace(strings.TrimPrefix(subject, "fwd:"))
		default:
			return subject
		}
	}
}

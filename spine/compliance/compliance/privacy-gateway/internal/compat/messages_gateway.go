package compat

import (
	"context"
	"time"

	"privacy-gateway/internal/audit"
	"privacy-gateway/internal/mail"
	"privacy-gateway/internal/model"
	"privacy-gateway/internal/relay"
	"privacy-gateway/internal/sanitizer"
	"privacy-gateway/internal/submission"
)

type MessagesGateway struct {
	submissions *submission.Service
	sanitizer   *sanitizer.Service
	relay       *relay.Service
	audit       *audit.Service
}

func NewMessagesGateway(submissions *submission.Service, sanitizer *sanitizer.Service, relayService *relay.Service, auditService *audit.Service) *MessagesGateway {
	return &MessagesGateway{
		submissions: submissions,
		sanitizer:   sanitizer,
		relay:       relayService,
		audit:       auditService,
	}
}

func (g *MessagesGateway) Send(ctx context.Context, msg model.SanitizedMessage) (model.MessageRecord, error) {
	if g.submissions != nil {
		created, err := g.submissions.Create(ctx, msg.Actor, model.CreateSubmissionInput{
			ChannelID: msg.Alias.ID,
			To:        append([]string(nil), msg.To...),
			Subject:   msg.Subject,
			TextBody:  msg.TextBody,
		})
		if err != nil {
			return model.MessageRecord{}, err
		}

		if g.sanitizer != nil {
			_ = g.sanitizer.SanitizeOutbound(model.SendMessageInput{
				AliasID:  msg.Alias.ID,
				To:       append([]string(nil), msg.To...),
				Subject:  msg.Subject,
				TextBody: msg.TextBody,
			})
		}

		attempt, record, err := g.relay.Relay(ctx, created.ID, msg)
		if err != nil {
			failureClass, failureDisposition := ClassifyRelayFailure(err)
			failedAttempt, attemptErr := g.relay.RecordFailure(ctx, created.ID, msg, failureClass, failureDisposition, err.Error())
			if attemptErr != nil {
				return model.MessageRecord{}, attemptErr
			}
			if err := g.recordRelayAttemptAudit(ctx, msg, failedAttempt); err != nil {
				return model.MessageRecord{}, err
			}
			if _, markErr := g.submissions.MarkRelayFailed(ctx, created.ID, failedAttempt.ID, relayProviderName(g.relay), "messages_compat", failureClass, failureDisposition, err.Error(), time.Now().UTC()); markErr != nil {
				return model.MessageRecord{}, markErr
			}
			if g.audit != nil {
				_, auditErr := g.audit.Record(ctx, msg.Actor.TenantID, msg.Actor.ID, "message_compat_relay_failed", created.ID, map[string]string{
					"alias_id":                  msg.Alias.ID,
					"relay_attempt_id":          failedAttempt.ID,
					"relay_failure_class":       failureClass,
					"relay_failure_disposition": failureDisposition,
				})
				if auditErr != nil {
					return model.MessageRecord{}, auditErr
				}
			}
			return model.MessageRecord{}, err
		}
		if err := g.recordRelayAttemptAudit(ctx, msg, attempt); err != nil {
			return model.MessageRecord{}, err
		}
		if _, err := g.submissions.MarkRelayed(ctx, created.ID, attempt.Provider, attempt.ID, "messages_compat", time.Now().UTC()); err != nil {
			return model.MessageRecord{}, err
		}

		if g.audit != nil {
			_, err = g.audit.Record(ctx, msg.Actor.TenantID, msg.Actor.ID, "message_compat_relay", attempt.ID, map[string]string{
				"submission_id": created.ID,
				"alias_id":      msg.Alias.ID,
			})
			if err != nil {
				return model.MessageRecord{}, err
			}
		}

		return record, nil
	}

	attempt, record, err := g.relay.Relay(ctx, "", msg)
	if err != nil {
		failureClass, failureDisposition := ClassifyRelayFailure(err)
		failedAttempt, attemptErr := g.relay.RecordFailure(ctx, "", msg, failureClass, failureDisposition, err.Error())
		if attemptErr != nil {
			return model.MessageRecord{}, attemptErr
		}
		if err := g.recordRelayAttemptAudit(ctx, msg, failedAttempt); err != nil {
			return model.MessageRecord{}, err
		}
		if g.audit != nil {
			_, auditErr := g.audit.Record(ctx, msg.Actor.TenantID, msg.Actor.ID, "message_compat_relay_failed", msg.Alias.ID, map[string]string{
				"alias_id":                  msg.Alias.ID,
				"relay_attempt_id":          failedAttempt.ID,
				"relay_failure_class":       failureClass,
				"relay_failure_disposition": failureDisposition,
			})
			if auditErr != nil {
				return model.MessageRecord{}, auditErr
			}
		}
		return model.MessageRecord{}, err
	}
	if err := g.recordRelayAttemptAudit(ctx, msg, attempt); err != nil {
		return model.MessageRecord{}, err
	}
	if g.audit != nil {
		_, err = g.audit.Record(ctx, msg.Actor.TenantID, msg.Actor.ID, "message_compat_relay", attempt.ID, map[string]string{
			"alias_id": msg.Alias.ID,
		})
		if err != nil {
			return model.MessageRecord{}, err
		}
	}
	return record, nil
}

func (g *MessagesGateway) ListByActor(ctx context.Context, actor model.Actor) ([]model.MessageRecord, error) {
	return g.relay.ListByActor(ctx, actor)
}

var _ mail.Gateway = (*MessagesGateway)(nil)

// ClassifyRelayFailure delegates to relay.ClassifyError for structured failure diagnosis.
func ClassifyRelayFailure(err error) (string, string) {
	diag := relay.ClassifyError(err)
	return diag.Class, diag.Disposition
}

func relayProviderName(service *relay.Service) string {
	if service == nil {
		return ""
	}
	return service.Provider()
}

func (g *MessagesGateway) recordRelayAttemptAudit(ctx context.Context, msg model.SanitizedMessage, attempt model.RelayAttempt) error {
	if g.audit == nil {
		return nil
	}

	metadata := map[string]string{
		"submission_id":             attempt.SubmissionID,
		"alias_id":                  attempt.AliasID,
		"provider":                  attempt.Provider,
		"status":                    attempt.Status,
		"failure_class":             attempt.FailureClass,
		"failure_disposition":       attempt.FailureDisposition,
	}
	if attempt.FailureReason != "" {
		metadata["failure_reason"] = attempt.FailureReason
	}

	_, err := g.audit.Record(ctx, msg.Actor.TenantID, msg.Actor.ID, "relay_attempt_created", attempt.ID, metadata)
	return err
}

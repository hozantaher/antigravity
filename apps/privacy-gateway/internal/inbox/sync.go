package inbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	netmail "net/mail"
	"net/textproto"
	"strconv"
	"strings"
	"time"
	"unicode"

	"privacy-gateway/internal/model"
)

var (
	ErrIMAPNotConfigured    = errors.New("imap sync is not configured")
	ErrIMAPIncompleteConfig = errors.New("imap host, username, and password must either all be set or all be empty")
)

const defaultSyncLimit = 20
const defaultAttachmentMaxBytes = 5 * 1024 * 1024

type Syncer interface {
	Sync(ctx context.Context, actor model.Actor) (int, error)
}

type IMAPSyncConfig struct {
	Host          string
	Port          int
	Username      string
	Password      string
	Mailbox       string
	TLSServerName string
	Timeout       time.Duration
	FetchLimit    int
}

type IMAPSyncer struct {
	config           IMAPSyncConfig
	store            *Store
	cursors          *CursorStore
	attachmentPolicy AttachmentPolicy
	resolver         MessageResolver
	sessions         imapSessionFactory
}

type MessageResolver interface {
	Resolve(ctx context.Context, actor model.Actor, msg model.InboxMessage) (model.InboxMessage, error)
}

type MessageResolverFunc func(ctx context.Context, actor model.Actor, msg model.InboxMessage) (model.InboxMessage, error)

func (f MessageResolverFunc) Resolve(ctx context.Context, actor model.Actor, msg model.InboxMessage) (model.InboxMessage, error) {
	return f(ctx, actor, msg)
}

type imapSession interface {
	Login(username, password string) error
	Select(mailbox string) error
	SearchAllUIDs() ([]string, error)
	FetchMessageByUID(uid string) ([]byte, error)
	Logout() error
	Close() error
}

type imapSessionFactory interface {
	New(ctx context.Context, config IMAPSyncConfig) (imapSession, error)
}

type netIMAPSessionFactory struct{}

type netIMAPSession struct {
	conn *textproto.Conn
}

type AttachmentPolicy interface {
	Apply(attachment model.InboxAttachment) model.InboxAttachment
}

type DefaultAttachmentPolicy struct {
	MaxBytes            int
	BlockedContentTypes map[string]struct{}
}

func NewIMAPSyncer(config IMAPSyncConfig, store *Store, cursors *CursorStore) (*IMAPSyncer, error) {
	host := strings.TrimSpace(config.Host)
	username := strings.TrimSpace(config.Username)
	password := strings.TrimSpace(config.Password)

	emptyFields := 0
	for _, value := range []string{host, username, password} {
		if value == "" {
			emptyFields++
		}
	}
	switch emptyFields {
	case 3:
		return nil, ErrIMAPNotConfigured
	case 0:
		config.Host = host
		config.Username = username
		config.Password = password
	default:
		return nil, ErrIMAPIncompleteConfig
	}
	if store == nil {
		return nil, errors.New("inbox store is required")
	}
	if cursors == nil {
		return nil, errors.New("cursor store is required")
	}
	if config.Port <= 0 {
		config.Port = 993
	}
	if config.Mailbox == "" {
		config.Mailbox = "INBOX"
	}
	if config.TLSServerName == "" {
		config.TLSServerName = config.Host
	}
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Second
	}
	if config.FetchLimit <= 0 {
		config.FetchLimit = defaultSyncLimit
	}

	return &IMAPSyncer{
		config:  config,
		store:   store,
		cursors: cursors,
		attachmentPolicy: DefaultAttachmentPolicy{
			MaxBytes: defaultAttachmentMaxBytes,
			BlockedContentTypes: map[string]struct{}{
				"application/x-msdownload": {},
				"application/x-dosexec":    {},
				"application/x-sh":         {},
				"application/x-executable": {},
				"application/java-archive": {},
				"text/x-shellscript":       {},
			},
		},
		sessions: netIMAPSessionFactory{},
	}, nil
}

func (s *IMAPSyncer) WithResolver(resolver MessageResolver) *IMAPSyncer {
	s.resolver = resolver
	return s
}

func (s *IMAPSyncer) Sync(ctx context.Context, actor model.Actor) (int, error) {
	session, err := s.sessions.New(ctx, s.config)
	if err != nil {
		return 0, err
	}
	defer session.Close()
	defer session.Logout()

	if err := session.Login(s.config.Username, s.config.Password); err != nil {
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "login failed") || strings.Contains(msg, "authentication failed") {
			return 0, fmt.Errorf("imap authentication failed (check credentials): %w", err)
		}
		return 0, err
	}
	if err := session.Select(s.config.Mailbox); err != nil {
		return 0, err
	}

	uids, err := session.SearchAllUIDs()
	if err != nil {
		return 0, err
	}

	cursor, err := s.cursors.Load(ctx, actor)
	if err != nil {
		return 0, err
	}

	// Fix 5: UID monotonicity check — detect server-side UID sequence reset.
	if cursor != "" && len(uids) > 0 {
		cursorVal, cursorErr := strconv.ParseUint(strings.TrimSpace(cursor), 10, 64)
		maxUID := uids[len(uids)-1]
		maxVal, maxErr := strconv.ParseUint(strings.TrimSpace(maxUID), 10, 64)
		if cursorErr == nil && maxErr == nil && maxVal < cursorVal {
			slog.Warn("imap uid sequence reset detected, resetting sync cursor",
				"op", "inbox.Sync/uidReset",
				"actor_id", actor.ID,
				"cursor_uid", cursorVal,
				"server_max_uid", maxVal,
			)
			cursor = ""
		}
	}

	uids = selectSyncUIDs(uids, cursor, s.config.FetchLimit)

	synced := 0
	for _, uid := range uids {
		raw, err := session.FetchMessageByUID(uid)
		if err != nil {
			return synced, err
		}
		msg, err := parseIMAPMessage(actor, uid, raw, s.attachmentPolicy)
		if err != nil {
			return synced, err
		}
		if s.resolver != nil {
			msg, err = s.resolver.Resolve(ctx, actor, msg)
			if err != nil {
				return synced, err
			}
		}
		if _, err := s.store.Save(ctx, msg); err != nil {
			return synced, err
		}
		if err := s.cursors.Save(ctx, actor, uid); err != nil {
			return synced, err
		}
		synced++
	}

	return synced, nil
}

func (netIMAPSessionFactory) New(ctx context.Context, config IMAPSyncConfig) (imapSession, error) {
	address := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	dialer := &net.Dialer{Timeout: config.Timeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", address, &tls.Config{
		ServerName: config.TLSServerName,
		MinVersion: tls.VersionTLS12,
	})
	if err != nil {
		return nil, err
	}

	session := &netIMAPSession{conn: textproto.NewConn(conn)}
	if _, err := session.conn.ReadLine(); err != nil {
		session.Close()
		return nil, err
	}
	_ = ctx
	return session, nil
}

func (s *netIMAPSession) Login(username, password string) error {
	return s.command("LOGIN %s %s", quoteIMAP(username), quoteIMAP(password))
}

func (s *netIMAPSession) Select(mailbox string) error {
	return s.command("SELECT %s", quoteIMAP(mailbox))
}

func (s *netIMAPSession) SearchAllUIDs() ([]string, error) {
	tag := imapTag(s.conn.Next())
	if err := s.conn.PrintfLine("%s UID SEARCH ALL", tag); err != nil {
		return nil, err
	}

	var uids []string
	for {
		line, err := s.conn.ReadLine()
		if err != nil {
			return nil, err
		}
		switch {
		case strings.HasPrefix(line, "* SEARCH "):
			fields := strings.Fields(strings.TrimPrefix(line, "* SEARCH "))
			uids = append(uids, fields...)
		case strings.HasPrefix(line, tag+" OK"):
			return uids, nil
		case strings.HasPrefix(line, tag+" NO"), strings.HasPrefix(line, tag+" BAD"):
			return nil, errors.New(line)
		}
	}
}

func (s *netIMAPSession) FetchMessageByUID(uid string) ([]byte, error) {
	tag := imapTag(s.conn.Next())
	if err := s.conn.PrintfLine("%s UID FETCH %s BODY.PEEK[]", tag, uid); err != nil {
		return nil, err
	}

	var buffer strings.Builder
	for {
		line, err := s.conn.ReadLine()
		if err != nil {
			return nil, err
		}
		switch {
		case strings.HasPrefix(line, "* ") && strings.Contains(line, "FETCH"):
			literalSize := parseLiteralSize(line)
			if literalSize == 0 {
				// No literal or size declared as zero — skip body read.
				break
			}
			data := make([]byte, literalSize)
			n, err := io.ReadFull(s.conn.R, data)
			if err != nil || n != literalSize {
				_ = s.conn.Close()
				return nil, fmt.Errorf("imap literal size mismatch: declared %d bytes, read %d: %w", literalSize, n, errors.New("truncated imap literal"))
			}
			buffer.Write(data[:n])
			_, _ = s.conn.ReadLine()
		case strings.HasPrefix(line, tag+" OK"):
			return []byte(buffer.String()), nil
		case strings.HasPrefix(line, tag+" NO"), strings.HasPrefix(line, tag+" BAD"):
			return nil, errors.New(line)
		}
	}
}

func (s *netIMAPSession) Logout() error {
	return s.command("LOGOUT")
}

func (s *netIMAPSession) Close() error {
	return s.conn.Close()
}

func (s *netIMAPSession) command(format string, args ...any) error {
	tag := imapTag(s.conn.Next())
	if err := s.conn.PrintfLine(tag+" "+format, args...); err != nil {
		return err
	}

	for {
		line, err := s.conn.ReadLine()
		if err != nil {
			return err
		}
		if strings.HasPrefix(line, tag+" OK") {
			return nil
		}
		if strings.HasPrefix(line, tag+" NO") || strings.HasPrefix(line, tag+" BAD") {
			return errors.New(line)
		}
	}
}

func imapTag(id uint) string {
	return "A" + strconv.FormatUint(uint64(id), 10)
}

func parseIMAPMessage(actor model.Actor, uid string, raw []byte, policy AttachmentPolicy) (result model.InboxMessage, retErr error) {
	defer func() {
		if r := recover(); r != nil {
			hash := sha256.Sum256(raw)
			slog.Warn("panic parsing imap message, skipping",
				"op", "inbox.parseMessage/recover",
				"uid", uid,
				"raw_sha256", fmt.Sprintf("%x", hash[:8]),
				"panic", fmt.Sprintf("%v", r),
			)
			result = model.InboxMessage{}
			retErr = fmt.Errorf("panic parsing message uid %s: %v", uid, r)
		}
	}()

	message, err := netmail.ReadMessage(strings.NewReader(string(raw)))
	if err != nil {
		return model.InboxMessage{}, err
	}

	to, _ := netmail.ParseAddressList(message.Header.Get("To"))
	from, _ := netmail.ParseAddress(message.Header.Get("From"))
	dateHeader := message.Header.Get("Date")
	receivedAt, err := netmail.ParseDate(dateHeader)
	if err != nil {
		receivedAt = time.Now().UTC()
	}
	bodyResult, err := extractMessageBody(message.Header, message.Body)
	if err != nil {
		return model.InboxMessage{}, err
	}
	attachments := applyAttachmentPolicy(policy, bodyResult.Attachments)

	toValues := make([]string, 0, len(to))
	aliasEmail := ""
	for _, addr := range to {
		toValues = append(toValues, strings.ToLower(addr.Address))
		if aliasEmail == "" {
			aliasEmail = strings.ToLower(addr.Address)
		}
	}
	if aliasEmail == "" {
		aliasEmail = actor.PrimaryEmail
	}

	fromValue := ""
	if from != nil {
		fromValue = strings.ToLower(from.Address)
	}

	return model.InboxMessage{
		ID:              "imap_" + uid,
		UserID:          actor.ID,
		TenantID:        actor.TenantID,
		AliasEmail:      aliasEmail,
		From:            fromValue,
		To:              toValues,
		Subject:         strings.TrimSpace(message.Header.Get("Subject")),
		TextBody:        bodyResult.Text,
		Attachments:     attachments,
		AttachmentCount: len(attachments),
		ReceivedAt:      receivedAt.UTC(),
		ProviderUID:     uid,
	}, nil
}

func parseLiteralSize(line string) int {
	start := strings.LastIndex(line, "{")
	end := strings.LastIndex(line, "}")
	if start == -1 || end == -1 || end <= start+1 {
		return 0
	}
	size, err := strconv.Atoi(line[start+1 : end])
	if err != nil {
		return 0
	}
	return size
}

func quoteIMAP(value string) string {
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return fmt.Sprintf("\"%s\"", escaped)
}

func limitTail(items []string, max int) []string {
	if max <= 0 || len(items) <= max {
		return append([]string(nil), items...)
	}
	return append([]string(nil), items[len(items)-max:]...)
}

func selectSyncUIDs(uids []string, cursor string, max int) []string {
	if cursor == "" {
		return limitTail(uids, max)
	}

	filtered := filterUIDsAfterCursor(uids, cursor)
	if max <= 0 || len(filtered) <= max {
		return filtered
	}
	return append([]string(nil), filtered[:max]...)
}

func filterUIDsAfterCursor(uids []string, cursor string) []string {
	cursorValue, err := strconv.ParseUint(strings.TrimSpace(cursor), 10, 64)
	if err != nil {
		return append([]string(nil), uids...)
	}

	filtered := make([]string, 0, len(uids))
	for _, uid := range uids {
		uidValue, err := strconv.ParseUint(strings.TrimSpace(uid), 10, 64)
		if err != nil {
			continue
		}
		if uidValue > cursorValue {
			filtered = append(filtered, uid)
		}
	}
	return filtered
}

type parsedBody struct {
	Text        string
	Kind        string
	MediaType   string
	Attachments []model.InboxAttachment
}

func extractMessageBody(header netmail.Header, body io.Reader) (parsedBody, error) {
	result, err := extractMessageBodyPart(header, body)
	if err != nil {
		return parsedBody{}, err
	}
	return result, nil
}

func extractMessageBodyPart(header netmail.Header, body io.Reader) (parsedBody, error) {
	mediaType, params, err := mime.ParseMediaType(header.Get("Content-Type"))
	if err != nil || mediaType == "" {
		mediaType = "text/plain"
	}

	decodedBody, err := decodeTransferEncoding(header.Get("Content-Transfer-Encoding"), body)
	if err != nil {
		return parsedBody{}, err
	}

	switch {
	case strings.HasPrefix(mediaType, "multipart/"):
		boundary := strings.TrimSpace(params["boundary"])
		if boundary == "" {
			bodyBytes, err := io.ReadAll(decodedBody)
			if err != nil {
				return parsedBody{}, err
			}
			return parsedBody{
				Text:      normalizeExtractedText(string(bodyBytes)),
				Kind:      "plain",
				MediaType: mediaType,
			}, nil
		}
		result, err := extractMultipartTextBody(multipart.NewReader(decodedBody, boundary))
		if err != nil {
			return parsedBody{}, err
		}
		result.MediaType = mediaType
		return result, nil
	case mediaType == "text/html":
		bodyBytes, err := io.ReadAll(decodedBody)
		if err != nil {
			return parsedBody{}, err
		}
		return parsedBody{
			Text:      normalizeExtractedText(stripHTML(string(bodyBytes))),
			Kind:      "html",
			MediaType: mediaType,
		}, nil
	default:
		disposition, _, _ := mime.ParseMediaType(header.Get("Content-Disposition"))
		filename := messageFilename(header)
		bodyBytes, err := io.ReadAll(decodedBody)
		if err != nil {
			return parsedBody{}, err
		}
		if isAttachmentPart(mediaType, disposition, filename) {
			return parsedBody{
				MediaType: mediaType,
				Kind:      "attachment",
				Attachments: []model.InboxAttachment{{
					Filename:    filename,
					ContentType: mediaType,
					Disposition: disposition,
					SizeBytes:   len(bodyBytes),
				}},
			}, nil
		}
		return parsedBody{
			Text:      normalizeExtractedText(string(bodyBytes)),
			Kind:      "plain",
			MediaType: mediaType,
		}, nil
	}
}

func extractMultipartTextBody(reader *multipart.Reader) (parsedBody, error) {
	var bestText string
	var bestKind string
	var attachments []model.InboxAttachment

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return parsedBody{}, err
		}

		result, err := extractMessageBodyPart(netmail.Header(part.Header), part)
		_ = part.Close()
		if err != nil {
			return parsedBody{}, err
		}
		attachments = append(attachments, result.Attachments...)
		switch result.Kind {
		case "plain":
			if result.Text != "" && bestKind != "plain" {
				bestText = result.Text
				bestKind = "plain"
			}
		case "html":
			if result.Text != "" && bestKind == "" {
				bestText = result.Text
				bestKind = "html"
			}
		}
	}

	return parsedBody{
		Text:        bestText,
		Kind:        bestKind,
		Attachments: attachments,
	}, nil
}

func decodeTransferEncoding(encoding string, body io.Reader) (io.Reader, error) {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "7bit", "8bit", "binary":
		return body, nil
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, body), nil
	case "quoted-printable":
		return quotedPrintableReader(body), nil
	default:
		return body, nil
	}
}

func quotedPrintableReader(body io.Reader) io.Reader {
	return quotedprintable.NewReader(body)
}

func isAttachmentPart(mediaType, disposition, filename string) bool {
	disposition = strings.ToLower(strings.TrimSpace(disposition))
	filename = strings.TrimSpace(filename)
	if disposition == "attachment" {
		return true
	}
	if filename != "" && !strings.HasPrefix(mediaType, "multipart/") {
		return true
	}
	if disposition == "inline" && mediaType != "text/plain" && mediaType != "text/html" {
		return true
	}
	if !strings.HasPrefix(mediaType, "text/") && !strings.HasPrefix(mediaType, "multipart/") {
		return true
	}
	return false
}

func applyAttachmentPolicy(policy AttachmentPolicy, attachments []model.InboxAttachment) []model.InboxAttachment {
	if len(attachments) == 0 {
		return nil
	}
	if policy == nil {
		return attachments
	}

	out := make([]model.InboxAttachment, 0, len(attachments))
	for _, attachment := range attachments {
		out = append(out, policy.Apply(attachment))
	}
	return out
}

func (p DefaultAttachmentPolicy) Apply(attachment model.InboxAttachment) model.InboxAttachment {
	action := "metadata_only"
	reason := "non-text attachments are stored as metadata only"

	contentType := strings.ToLower(strings.TrimSpace(attachment.ContentType))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if _, blocked := p.BlockedContentTypes[contentType]; blocked {
		action = "blocked"
		reason = "blocked high-risk attachment type"
	} else if p.MaxBytes > 0 && attachment.SizeBytes > p.MaxBytes {
		action = "blocked"
		reason = "attachment exceeds size policy"
	} else if strings.HasPrefix(contentType, "image/") {
		action = "allowed_metadata"
		reason = "image attachment metadata retained"
	} else if contentType == "application/pdf" || strings.HasPrefix(contentType, "text/") {
		action = "allowed_metadata"
		reason = "document attachment metadata retained"
	}

	attachment.PolicyAction = action
	attachment.PolicyReason = reason
	return attachment
}

func messageFilename(header netmail.Header) string {
	if value := strings.TrimSpace(header.Get("Content-Disposition")); value != "" {
		_, params, err := mime.ParseMediaType(value)
		if err == nil && strings.TrimSpace(params["filename"]) != "" {
			return strings.TrimSpace(params["filename"])
		}
	}
	if value := strings.TrimSpace(header.Get("Content-Type")); value != "" {
		_, params, err := mime.ParseMediaType(value)
		if err == nil && strings.TrimSpace(params["name"]) != "" {
			return strings.TrimSpace(params["name"])
		}
	}
	return ""
}

func normalizeExtractedText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimSpace(text)
	return collapseExcessBlankLines(text)
}

func collapseExcessBlankLines(text string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	blankCount := 0
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			blankCount++
			if blankCount > 1 {
				continue
			}
			out = append(out, "")
			continue
		}
		blankCount = 0
		out = append(out, strings.TrimRightFunc(line, unicode.IsSpace))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func stripHTML(input string) string {
	var out bytes.Buffer
	inTag := false

	for _, r := range input {
		switch r {
		case '<':
			inTag = true
			if out.Len() > 0 {
				last := out.Bytes()[out.Len()-1]
				if last != '\n' && last != ' ' {
					out.WriteByte(' ')
				}
			}
		case '>':
			inTag = false
		default:
			if !inTag {
				out.WriteRune(r)
			}
		}
	}

	return html.UnescapeString(out.String())
}

// seed-from-prod — KT-B5 Lab Feedback Loop CLI entry.
//
// Usage:
//
//	seed-from-prod --batch 5 --lab-user op@gmail.lab --lab-pass labpass
//	seed-from-prod --dry-run --batch 25
//
// Reads recent classified inbound replies from prod, anonymizes them,
// and APPENDs the result via IMAP into the Mail Lab. Designed to be
// called from cron (nightly small batch) or by hand for ad-hoc seeding.
//
// Exit codes:
//
//	0 — success (including dry-run with no rows)
//	1 — runtime error (DB connect, IMAP login, etc.)
//	2 — invalid configuration (missing required env / flag)
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"common/envconfig"
	"common/telemetry"

	_ "github.com/lib/pq"

	"operator-practice/internal/labseed"
	"operator-practice/internal/seedstore"
)

// Args is the parsed CLI surface. Pulled into a struct so tests can
// exercise the parser without subprocessing.
type Args struct {
	BatchSize int
	LabHost   string
	LabPort   int
	LabTLS    bool
	LabUser   string
	LabPass   string
	LabFolder string
	DryRun    bool
	Salt      string
}

func main() {
	if err := telemetry.Init("operator-practice"); err != nil {
		slog.Error("sentry init failed", "op", "main/telemetry-init", "error", err)
	}
	telemetry.SetServiceTag("operator-practice")
	defer telemetry.Flush()

	args, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "configuration error:", err)
		os.Exit(2)
	}

	if !args.DryRun {
		envconfig.MustHave("DATABASE_URL")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	var db *sql.DB
	if !args.DryRun {
		db, err = sql.Open("postgres", envconfig.GetOr("DATABASE_URL", ""))
		if err != nil {
			slog.Error("db open failed", "op", "main/db-open", "error", err)
			os.Exit(1)
		}
		defer db.Close()
		if err := db.PingContext(ctx); err != nil {
			slog.Error("db ping failed", "op", "main/db-ping", "error", err)
			os.Exit(1)
		}
	}

	var store labseed.Selector
	if db != nil {
		store = seedstore.New(db)
	} else {
		store = noopStore{}
	}
	runner := labseed.NewRunner(store, nil)

	stats, err := runner.Run(ctx, labseed.Config{
		BatchSize: args.BatchSize,
		LabHost:   args.LabHost,
		LabPort:   args.LabPort,
		LabTLS:    args.LabTLS,
		LabUser:   args.LabUser,
		LabPass:   args.LabPass,
		LabFolder: args.LabFolder,
		Salt:      args.Salt,
		DryRun:    args.DryRun,
	})
	if err != nil {
		slog.Error("seed-from-prod failed",
			"op", "main/run",
			"error", err,
			"batch_id", stats.BatchID,
			"selected", stats.Selected,
			"injected", stats.Injected,
			"failed", stats.Failed,
		)
		os.Exit(1)
	}

	slog.Info("seed-from-prod ok",
		"op", "main/run-ok",
		"batch_id", stats.BatchID,
		"dry_run", stats.DryRun,
		"selected", stats.Selected,
		"skipped_already_sent", stats.SkippedAlreadySent,
		"injected", stats.Injected,
		"failed", stats.Failed,
		"review_candidates", stats.ReviewCandidates,
	)
}

func parseArgs(argv []string) (Args, error) {
	args := Args{
		LabHost:   envconfig.GetOr("LAB_IMAP_HOST", "localhost"),
		LabPort:   atoiOr("LAB_IMAP_PORT", 25993),
		LabTLS:    boolOr("LAB_IMAP_TLS", true),
		LabUser:   envconfig.GetOr("LAB_IMAP_USER", ""),
		LabPass:   envconfig.GetOr("LAB_IMAP_PASS", ""),
		LabFolder: envconfig.GetOr("LAB_IMAP_FOLDER", "INBOX"),
		BatchSize: atoiOr("OPERATOR_PRACTICE_BATCH_SIZE", 5),
		Salt:      envconfig.GetOr("OPERATOR_PRACTICE_SALT", ""),
	}

	fs := flag.NewFlagSet("seed-from-prod", flag.ContinueOnError)
	fs.IntVar(&args.BatchSize, "batch", args.BatchSize, "max rows to inject this run")
	fs.StringVar(&args.LabHost, "lab-host", args.LabHost, "IMAP host (lab only)")
	fs.IntVar(&args.LabPort, "lab-port", args.LabPort, "IMAP port")
	fs.BoolVar(&args.LabTLS, "lab-tls", args.LabTLS, "use IMAPS")
	fs.StringVar(&args.LabUser, "lab-user", args.LabUser, "lab mailbox address (e.g. op@gmail.lab)")
	fs.StringVar(&args.LabPass, "lab-pass", args.LabPass, "lab mailbox password")
	fs.StringVar(&args.LabFolder, "lab-folder", args.LabFolder, "destination IMAP folder")
	fs.BoolVar(&args.DryRun, "dry-run", false, "skip IMAP + DB writes")
	fs.StringVar(&args.Salt, "salt", args.Salt, "anonymizer salt (override default)")

	if err := fs.Parse(argv); err != nil {
		return args, err
	}

	if args.BatchSize <= 0 {
		return args, errors.New("--batch must be > 0")
	}
	if !args.DryRun {
		if strings.TrimSpace(args.LabUser) == "" {
			return args, errors.New("--lab-user required (or LAB_IMAP_USER env)")
		}
		if strings.TrimSpace(args.LabPass) == "" {
			return args, errors.New("--lab-pass required (or LAB_IMAP_PASS env)")
		}
	}
	return args, nil
}

func atoiOr(key string, def int) int {
	// envconfig-allowed: int parse; envconfig.GetOr is string-only
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func boolOr(key string, def bool) bool {
	return envconfig.BoolOr(key, def)
}

// noopStore is used in --dry-run mode when no DB connection is opened.
// All reads return empty; writes are silent. Allows the CLI to exercise
// the full Run plumbing for help-message + smoke tests without touching
// the database.
type noopStore struct{}

func (noopStore) EnsureSchema(_ context.Context) error { return nil }
func (noopStore) SelectClassifiedReplies(_ context.Context, _ int) ([]labseed.SelectorMessage, error) {
	return nil, nil
}
func (noopStore) FilterUnseen(_ context.Context, _ []labseed.SelectorMessage) ([]labseed.SelectorMessage, error) {
	return nil, nil
}
func (noopStore) RecordSeeded(_ context.Context, _, _, _, _ string) error { return nil }

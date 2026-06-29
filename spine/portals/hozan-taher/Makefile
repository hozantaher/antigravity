.PHONY: help test test-go test-js test-audit test-smoke test-mutation test-fast \
        test-area lint clean coverage

help:
	@echo "hozan-taher monorepo Makefile"
	@echo ""
	@echo "Test targets:"
	@echo "  make test          Run everything (Go + JS/TS + audit + smoke; skips mutation)"
	@echo "  make test-fast     Run Go + JS/TS only (no audit/smoke/mutation)"
	@echo "  make test-go       Run Go workspace suites only"
	@echo "  make test-js       Run JS/TS pnpm test scripts only"
	@echo "  make test-audit    Run audit/quality scripts only"
	@echo "  make test-smoke    Run smoke shell scripts only"
	@echo "  make test-mutation Run Stryker mutation testing (slow, 30+ min)"
	@echo "  make test-area AREA=<name>  Run all suites for one area (e.g. AREA=relay)"
	@echo ""
	@echo "Backlog operations (GitHub Issues = SoT, see ADR-002):"
	@echo "  make todo          Show top 20 open P0/P1 issues"
	@echo "  make todo-bot      Show issues bot can work (automation/ok)"
	@echo "  make reprioritize  Run scripts/reprioritize.mjs in dry-run"
	@echo "  make digest        Print today's bot digest preview"
	@echo ""
	@echo "Other:"
	@echo "  make clean         Remove /tmp/hozan-tests-* logs"

# ── Test targets ────────────────────────────────────────────────────

test:
	@bash scripts/test-all.sh --skip-mutation

test-fast:
	@bash scripts/test-all.sh --skip-mutation --skip-smoke

test-go:
	@bash scripts/test-all.sh --filter=go

test-js:
	@bash scripts/test-all.sh --filter=js

test-audit:
	@bash scripts/test-all.sh --filter=audit

test-smoke:
	@bash scripts/test-all.sh --filter=smoke

test-mutation:
	@bash scripts/test-all.sh --filter=mutation

test-area:
ifndef AREA
	$(error AREA is required: make test-area AREA=relay)
endif
	@bash scripts/test-all.sh --filter=area/$(AREA)

# ── Backlog ─────────────────────────────────────────────────────────

todo:
	@gh issue list --state=open --limit=20 \
		--label priority/p0,priority/p1 \
		--json number,title,labels \
		--jq '.[] | "  #\(.number)  \(.title[:80])  [\(.labels | map(.name) | join(", "))]"'

todo-bot:
	@gh issue list --state=open --limit=20 \
		--label automation/ok \
		--json number,title \
		--jq '.[] | "  #\(.number)  \(.title[:80])"'

reprioritize:
	@node scripts/reprioritize.mjs --dry-run

digest:
	@node scripts/daily-digest.mjs

# ── Cleanup ─────────────────────────────────────────────────────────

clean:
	@rm -rf /tmp/hozan-tests-*
	@echo "Removed /tmp/hozan-tests-* logs"

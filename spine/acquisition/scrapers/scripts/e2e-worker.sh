#!/bin/bash
#
# E2E test for Rozporuj.com worker pipeline via Claude Code CLI.
#
# Generates a legal document (odpor/rozklad) using Claude CLI + MCP tools,
# then converts it to DOCX and PDF — replicating the full worker pipeline.
# Uses Claude CLI subscription, not the Anthropic API.
#
# Usage:
#   ./scripts/e2e-worker.sh <pdf> [prompt]
#
# Examples:
#   ./scripts/e2e-worker.sh test-pdfs/pokuta.pdf
#   ./scripts/e2e-worker.sh test-pdfs/pokuta.pdf "rozporuj tuto výzvu"
#   ./scripts/e2e-worker.sh test-pdfs/zaloba.pdf "analyzuj žalobu a navrhni obranu"
#
# Required env vars:
#   MCP_REMOTE_URL     — Railway MCP server URL
#   MCP_REMOTE_SECRET  — OAuth secret
#
# Optional:
#   E2E_BUDGET         — max USD per run (default: 5.00)
#   E2E_MODEL          — Claude CLI model (default: sonnet)
#   E2E_TIMEOUT        — timeout in seconds (default: 600)

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXTENSION_DIR="$PROJECT_DIR/desktop-extension"

PDF_PATH="${1:-}"
USER_PROMPT="${2:-rozporuj tuto pokutu}"
BUDGET="${E2E_BUDGET:-5.00}"
MODEL="${E2E_MODEL:-sonnet}"
TIMEOUT="${E2E_TIMEOUT:-600}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }
info() { echo -e "  $1"; }

FAILURES=0
TESTS=0

check() {
  TESTS=$((TESTS + 1))
  if eval "$1"; then
    pass "$2"
  else
    fail "$2"
  fi
}

# --- Validate prerequisites ---

echo ""
echo "=== Rozporuj.com Worker — E2E Test ==="
echo ""

if [ -z "$PDF_PATH" ]; then
  echo "Usage: $0 <pdf> [prompt]"
  echo ""
  echo "Examples:"
  echo "  $0 test-pdfs/pokuta.pdf"
  echo "  $0 test-pdfs/pokuta.pdf \"rozporuj tuto výzvu\""
  exit 1
fi

if [ ! -f "$PDF_PATH" ]; then
  echo "Error: File not found: $PDF_PATH"
  exit 1
fi

PDF_PATH="$(cd "$(dirname "$PDF_PATH")" && pwd)/$(basename "$PDF_PATH")"

# --- Phase 1: Prerequisites ---

echo "--- Phase 1: Prerequisites ---"
echo ""

check 'command -v claude &>/dev/null' "claude CLI installed"
check 'pnpm tsx --version &>/dev/null' "tsx available (via pnpm)"
check 'command -v libreoffice &>/dev/null' "libreoffice installed"
check 'command -v jq &>/dev/null' "jq installed"
check '[ -n "${MCP_REMOTE_URL:-}" ]' "MCP_REMOTE_URL set"
check '[ -n "${MCP_REMOTE_SECRET:-}" ]' "MCP_REMOTE_SECRET set"

if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo -e "  ${RED}Prerequisites failed — cannot continue.${NC}"
  echo ""
  echo "  Required:"
  echo "    brew install claude jq libreoffice  # or equivalent"
  echo "    export MCP_REMOTE_URL=https://garaaage-scrapers-production.up.railway.app"
  echo "    export MCP_REMOTE_SECRET=<secret>"
  exit 1
fi

echo ""

info "Server:  $MCP_REMOTE_URL"
info "Model:   $MODEL"
info "Budget:  \$$BUDGET"
info "Timeout: ${TIMEOUT}s"
info "PDF:     $PDF_PATH"
info "Prompt:  $USER_PROMPT"
echo ""

# --- MCP config (reuses desktop extension as proxy to remote MCP) ---

MCP_CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "garaaage-legal": {
      "command": "node",
      "args": ["$EXTENSION_DIR/server/index.js"],
      "env": {
        "MCP_REMOTE_URL": "$MCP_REMOTE_URL",
        "MCP_REMOTE_SECRET": "$MCP_REMOTE_SECRET"
      }
    }
  }
}
EOF
)

ALLOWED_TOOLS="Read mcp__garaaage-legal__get_stats mcp__garaaage-legal__get_schema mcp__garaaage-legal__search mcp__garaaage-legal__read_paragraphs mcp__garaaage-legal__query mcp__garaaage-legal__get_decision mcp__garaaage-legal__get_law_context"

# --- Temp file cleanup ---

STDERR_FILE=""
CONVERT_STDERR=""
cleanup() { rm -f "$STDERR_FILE" "$CONVERT_STDERR"; }
trap cleanup EXIT

# --- Output directory ---

OUTPUT_DIR="$PROJECT_DIR/test-output"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RUN_DIR="$OUTPUT_DIR/e2e_worker_${TIMESTAMP}"
mkdir -p "$RUN_DIR"

# --- Phase 2: Generate legal document via Claude CLI ---

echo "--- Phase 2: Generate legal document (this may take 3-8 min) ---"
echo ""

# Extract the real worker system prompt (single source of truth)
SYSTEM_PROMPT=$(pnpm tsx "$SCRIPT_DIR/e2e-worker-prompt.ts" 2>/dev/null) || {
  echo -e "  ${RED}FAIL${NC} Could not extract worker system prompt"
  exit 1
}

# User message — matches what the worker sends (generate-odpor.ts:369-372)
USER_MESSAGE="Přečti soubor $PDF_PATH a vygeneruj kompletní odpor/rozklad.
Pro vyhledání legislativy a judikatury použij garaaage-legal MCP nástroje (search, read_paragraphs, get_decision, get_law_context).

Účastník řízení: Jan Testovací
Dnešní datum: $(date +%Y-%m-%d)
$USER_PROMPT"

STDERR_FILE=$(mktemp)

# Capture full JSON conversation (includes tool calls, results, costs)
# Note: --output-format json buffers ALL output until completion.
# If timeout kills the process, RAW_JSON will be empty.
CLI_EXIT=0
RAW_JSON=$(timeout "$TIMEOUT" claude -p "$USER_MESSAGE" \
  --system-prompt "$SYSTEM_PROMPT" \
  --model "$MODEL" \
  --output-format json \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --allowedTools "$ALLOWED_TOOLS" \
  --max-budget-usd "$BUDGET" < /dev/null 2>"$STDERR_FILE") || CLI_EXIT=$?

if [ "$CLI_EXIT" -eq 124 ]; then
  fail "Claude CLI timed out after ${TIMEOUT}s (try E2E_TIMEOUT=900)"
  echo ""
  echo "========================================"
  echo "  Results: $((TESTS - FAILURES))/$TESTS passed"
  echo -e "  ${RED}$FAILURES test(s) failed${NC}"
  echo "========================================"
  exit "$FAILURES"
fi

if [ -s "$STDERR_FILE" ] && [ -z "$RAW_JSON" ]; then
  warn "Claude CLI stderr:"
  head -5 "$STDERR_FILE" | while IFS= read -r line; do warn "  $line"; done
fi

# Extract markdown from JSON, fall back to raw output if not JSON
MARKDOWN=""
if echo "$RAW_JSON" | jq -e '.result' &>/dev/null; then
  MARKDOWN=$(echo "$RAW_JSON" | jq -r '.result')
  echo "$RAW_JSON" | jq '.' > "$RUN_DIR/conversation.json"
  info "Raw conversation saved to conversation.json"
elif [ -n "$RAW_JSON" ]; then
  MARKDOWN="$RAW_JSON"
  warn "Output was not JSON — saved as raw text"
  echo "$RAW_JSON" > "$RUN_DIR/conversation_raw.txt"
fi

MD_LEN=${#MARKDOWN}
info "Generated markdown: $MD_LEN chars"

if [ "$MD_LEN" -lt 200 ]; then
  fail "Markdown output too short ($MD_LEN chars) — generation likely failed"
  echo ""
  echo "========================================"
  echo "  Results: $((TESTS - FAILURES))/$TESTS passed"
  echo -e "  ${RED}$FAILURES test(s) failed${NC}"
  echo "========================================"
  exit "$FAILURES"
fi

echo "$MARKDOWN" > "$RUN_DIR/odpor.md"
echo ""

# --- Phase 3: Convert markdown → DOCX → PDF ---

echo "--- Phase 3: DOCX + PDF conversion ---"
echo ""

CONVERT_STDERR=$(mktemp)

CONVERT_SUMMARY=$(pnpm tsx "$SCRIPT_DIR/e2e-worker-run.ts" \
  "$RUN_DIR/odpor.md" \
  "$RUN_DIR/odpor.docx" \
  "$RUN_DIR/odpor.pdf" \
  2>"$CONVERT_STDERR") || true

if [ -s "$CONVERT_STDERR" ]; then
  while IFS= read -r line; do info "$line"; done < "$CONVERT_STDERR"
fi

DOCX_SIZE=0
PDF_SIZE=0
if [ -n "$CONVERT_SUMMARY" ]; then
  DOCX_SIZE=$(echo "$CONVERT_SUMMARY" | jq -r '.docxSize')
  PDF_SIZE=$(echo "$CONVERT_SUMMARY" | jq -r '.pdfSize')
fi

check '[ -f "$RUN_DIR/odpor.md" ] && [ "$MD_LEN" -gt 200 ]' "odpor.md generated ($MD_LEN chars)"
check '[ -f "$RUN_DIR/odpor.docx" ] && [ "$DOCX_SIZE" -gt 1000 ]' "odpor.docx converted ($DOCX_SIZE B)"
check '[ -f "$RUN_DIR/odpor.pdf" ] && [ "$PDF_SIZE" -gt 1000 ]' "odpor.pdf converted ($PDF_SIZE B)"

echo ""

# --- Phase 4: Content quality ---

echo "--- Phase 4: Content quality ---"
echo ""

# Legal structure
check 'echo "$MARKDOWN" | grep -qP "§\s*\d+"' "Contains § references (e.g. § 125h)"
check 'echo "$MARKDOWN" | grep -qi "zákon\|Sb\.\|zákona"' "References Czech legislation"
check 'echo "$MARKDOWN" | grep -qi "odpor\|námit\|rozklad\|nesouhlasí\|napadá"' "Contains contestation language"
check 'echo "$MARKDOWN" | grep -qi "vygenerován\|umělé inteligence\|AI\|advokát"' "Contains AI disclaimer"
check 'echo "$MARKDOWN" | grep -qiP "\d+/\d+\s*Sb\."' "Cites specific laws (e.g. 361/2000 Sb.)"

# Anti-hallucination
check '! echo "$MARKDOWN" | grep -qi "jednaci_cislo\|datum_rozhodnuti\|nazev_soudu"' "No hallucinated DB column names"
check '! echo "$MARKDOWN" | grep -qi "Error:\|SQL error\|Remote error\|FATAL"' "No error messages in output"

echo ""

# --- Summary ---

echo "========================================"
echo "  Results: $((TESTS - FAILURES))/$TESTS passed"
if [ "$FAILURES" -gt 0 ]; then
  echo -e "  ${RED}$FAILURES test(s) failed${NC}"
else
  echo -e "  ${GREEN}All tests passed${NC}"
fi
echo "========================================"
echo ""
info "Output saved to $RUN_DIR/"
echo ""

exit "$FAILURES"

#!/bin/bash
#
# E2E test for Garaaage Legal desktop extension via Claude Code CLI.
#
# Spawns the extension as an MCP server, gives Claude a PDF + prompt,
# and validates the output contains expected legal elements.
#
# Usage:
#   ./scripts/e2e-extension.sh <pdf> [prompt]
#
# Examples:
#   ./scripts/e2e-extension.sh test-pdfs/pokuta.pdf "rozporuj tuto výzvu"
#   ./scripts/e2e-extension.sh test-pdfs/zaloba.pdf "analyzuj tuto žalobu a navrhni obranu"
#   ./scripts/e2e-extension.sh test-pdfs/pokuta.pdf  # default prompt: "rozporuj tuto výzvu"
#
# Required env vars:
#   MCP_REMOTE_URL     — Railway MCP server URL
#   MCP_REMOTE_SECRET  — OAuth secret
#
# Optional:
#   E2E_BUDGET         — max USD per run (default: 2.00)
#   E2E_MODEL          — model to use (default: sonnet)
#   E2E_TIMEOUT        — timeout in seconds (default: 120)

set -euo pipefail

# --- Configuration ---

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXTENSION_DIR="$PROJECT_DIR/desktop-extension"

PDF_PATH="${1:-}"
USER_PROMPT="${2:-rozporuj tuto výzvu}"
BUDGET="${E2E_BUDGET:-5.00}"
MODEL="${E2E_MODEL:-sonnet}"
TIMEOUT="${E2E_TIMEOUT:-300}"

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
echo "=== Garaaage Legal Extension — E2E Test ==="
echo ""

if [ -z "$PDF_PATH" ]; then
  echo "Usage: $0 <pdf> [prompt]"
  echo ""
  echo "Examples:"
  echo "  $0 test-pdfs/pokuta.pdf \"rozporuj tuto výzvu\""
  echo "  $0 test-pdfs/zaloba.pdf \"analyzuj tuto žalobu a navrhni obranu\""
  exit 1
fi

if [ ! -f "$PDF_PATH" ]; then
  echo "Error: File not found: $PDF_PATH"
  exit 1
fi

PDF_PATH="$(cd "$(dirname "$PDF_PATH")" && pwd)/$(basename "$PDF_PATH")"

if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found. Install Claude Code first."
  exit 1
fi

if [ -z "${MCP_REMOTE_URL:-}" ] || [ -z "${MCP_REMOTE_SECRET:-}" ]; then
  echo "Error: MCP_REMOTE_URL and MCP_REMOTE_SECRET must be set."
  echo ""
  echo "  export MCP_REMOTE_URL=https://garaaage-scrapers-production.up.railway.app"
  echo "  export MCP_REMOTE_SECRET=<secret>"
  exit 1
fi

# --- Build MCP config ---

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

info "Server:  $MCP_REMOTE_URL"
info "Model:   $MODEL"
info "Budget:  \$$BUDGET"
info "Timeout: ${TIMEOUT}s"
info "PDF:     $PDF_PATH"
info "Prompt:  $USER_PROMPT"
echo ""

# --- Phase 1: Tool connectivity ---

echo "--- Phase 1: Tool connectivity ---"
echo ""

TOOL_PROMPT="Pomocí garaaage-legal MCP serveru:
1. Zavolej get_stats() a vypiš počty záznamů
2. Zavolej get_schema(source='judikaty') a vypiš první 3 tabulky
3. Zavolej search(source='judikaty', table='decisions', query='zprostředkování', columns=['pravni_veta'], limit=3) a vypiš výsledky
4. Zavolej read_paragraphs(source='esbirka', citace='89/2012 Sb.', paragraphs=['2445'])
Vypiš výsledky každého volání stručně."

STDERR_FILE=$(mktemp)
TOOL_OUTPUT=$(timeout "$TIMEOUT" claude -p "$TOOL_PROMPT" \
  --model "$MODEL" \
  --output-format text \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --allowedTools "mcp__garaaage-legal__get_stats mcp__garaaage-legal__get_schema mcp__garaaage-legal__search mcp__garaaage-legal__read_paragraphs mcp__garaaage-legal__query mcp__garaaage-legal__get_decision mcp__garaaage-legal__get_law_context" \
  --max-budget-usd "$BUDGET" 2>"$STDERR_FILE") || true

if [ -s "$STDERR_FILE" ] && [ "${#TOOL_OUTPUT}" -eq 0 ]; then
  warn "Phase 1 stderr:"
  head -5 "$STDERR_FILE" | while read -r line; do warn "  $line"; done
fi

TOOL_LEN=${#TOOL_OUTPUT}

check '[ "$TOOL_LEN" -gt 100 ]' "Tool output not empty ($TOOL_LEN chars)"
check 'echo "$TOOL_OUTPUT" | grep -qi "judikaty\|decisions\|esbirka"' "Contains data source references"
check 'echo "$TOOL_OUTPUT" | grep -qi "685\|567\|107"' "get_stats returned row counts"
check 'echo "$TOOL_OUTPUT" | grep -qi "zprostředk"' "Search returned results"
check 'echo "$TOOL_OUTPUT" | grep -qi "2445\|zprostředkovatel\|zavazuje"' "read_paragraphs returned § 2445"
check '! echo "$TOOL_OUTPUT" | grep -qi "error\|failed\|neexistuj"' "No errors in tool responses"

echo ""

# --- Phase 2: Full legal workflow (PDF analysis) ---

echo "--- Phase 2: Full legal workflow ---"
echo ""

LEGAL_PROMPT="Přečti soubor $PDF_PATH.
Poté za pomocí garaaage-legal nástrojů (search, read_paragraphs, get_decision, get_law_context): $USER_PROMPT
Napiš kompletní právní analýzu v češtině jako markdown."

info "Running full legal workflow (this may take 30-60s)..."
echo ""

STDERR_FILE2=$(mktemp)
LEGAL_OUTPUT=$(timeout "$TIMEOUT" claude -p "$LEGAL_PROMPT" \
  --model "$MODEL" \
  --output-format text \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --allowedTools "Read mcp__garaaage-legal__get_stats mcp__garaaage-legal__get_schema mcp__garaaage-legal__search mcp__garaaage-legal__read_paragraphs mcp__garaaage-legal__query mcp__garaaage-legal__get_decision mcp__garaaage-legal__get_law_context" \
  --max-budget-usd "$BUDGET" 2>"$STDERR_FILE2") || true

if [ -s "$STDERR_FILE2" ] && [ "${#LEGAL_OUTPUT}" -eq 0 ]; then
  warn "Phase 2 stderr:"
  head -10 "$STDERR_FILE2" | while read -r line; do warn "  $line"; done
fi

LEGAL_LEN=${#LEGAL_OUTPUT}

# Content checks
check '[ "$LEGAL_LEN" -gt 2000 ]' "Output length > 2000 chars ($LEGAL_LEN chars)"
check 'echo "$LEGAL_OUTPUT" | grep -qP "§\s*\d+"' "Contains § references (e.g. § 125h)"
check 'echo "$LEGAL_OUTPUT" | grep -qi "zákon\|OZ\|Sb\."' "References Czech legislation"
check 'echo "$LEGAL_OUTPUT" | grep -qi "vygenerován\|AI\|revizi\|advokát\|automaticky"' "Contains AI disclaimer"
check 'echo "$LEGAL_OUTPUT" | grep -qi "odpor\|námit\|rozporov\|nesouhlasí\|napadá"' "Contains contestation language"

# Quality checks
check '! echo "$LEGAL_OUTPUT" | grep -qi "jednaci_cislo\|datum_rozhodnuti"' "No hallucinated column names"
check '! echo "$LEGAL_OUTPUT" | grep -qi "Error:\|SQL error\|Remote error"' "No tool errors in output"

# Tool usage checks — Claude should reference laws or case numbers
check 'echo "$LEGAL_OUTPUT" | grep -qiP "\d+/\d+\s*Sb\.|č\.\s*\d+|Cdo|ÚS\s|OZ|NOZ"' "References specific laws or case numbers"

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

# Save output for inspection
OUTPUT_DIR="$PROJECT_DIR/test-output"
mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
echo "$TOOL_OUTPUT" > "$OUTPUT_DIR/e2e_tools_${TIMESTAMP}.md"
echo "$LEGAL_OUTPUT" > "$OUTPUT_DIR/e2e_legal_${TIMESTAMP}.md"
[ -s "${STDERR_FILE2:-}" ] && cp "$STDERR_FILE2" "$OUTPUT_DIR/e2e_stderr_${TIMESTAMP}.log"
info "Output saved to $OUTPUT_DIR/e2e_*_${TIMESTAMP}.*"
echo ""

# Cleanup
rm -f "${STDERR_FILE:-}" "${STDERR_FILE2:-}"

exit "$FAILURES"

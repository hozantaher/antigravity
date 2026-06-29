#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Learning loop — build Czech few-shot block from override JSONL
# ════════════════════════════════════════════════════════════════════════
#
# Vstup: JSONL z `extract-overrides.sh` na stdin (1 row per line).
# Výstup: prompt template fragment na stdout — připraven k vložení do
# Ollama Modelfile FEW_SHOT sekce nebo do system prompt v
# features/platform/llm-runner/internal/handler/generate.go (`defaultGenerateSystem`).
#
# Per ADR-006 §D5 quarterly cron flow:
#   extract-overrides.sh \
#     | build-few-shot.sh --top 10 \
#     > prompts/few-shot-2026-Q2.txt
#   # Operator review → manual paste into Modelfile / generate.go
#
# Format (česky, per llm-runner generate.go convention):
#
#   ### Příklad 1
#   Kontext: <thread_context>
#   AI návrh: <ai_suggestion>
#   Lidská editace: <final_output>
#
#   ### Příklad 2
#   ...
#
# Volby:
#   --top <n>           Max examples (default: 10)
#   --skip-rejected     Pomine rejected rows (final_output je null)
#                       — užitečné pokud chceš jen edits jako positive
#                       teaching signal.
#   --max-context <n>   Truncate thread_context na n chars (default: 500)
#
# Hard rules:
#   - feedback_no_fabricated_test_data: skript nikdy negeneruje synthetic
#     examples — přepouští 1:1 to, co operator skutečně udělal.
#   - feedback_no_speculation: pokud řádek nemá final_output a není
#     rejected (možná NULL kvůli historickým migracím), skip; nedoplňujem.
#
# Exit codes:
#   0  ok
#   1  generic failure
#   2  jq není dostupný
#   3  invalid argument
# ════════════════════════════════════════════════════════════════════════

set -euo pipefail

TOP=10
SKIP_REJECTED=0
MAX_CONTEXT=500

while [[ $# -gt 0 ]]; do
  case "$1" in
    --top) TOP="$2"; shift 2 ;;
    --skip-rejected) SKIP_REJECTED=1; shift ;;
    --max-context) MAX_CONTEXT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 3
      ;;
  esac
done

if ! [[ "$TOP" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --top must be a positive integer (got: $TOP)" >&2
  exit 3
fi
if ! [[ "$MAX_CONTEXT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --max-context must be a non-negative integer (got: $MAX_CONTEXT)" >&2
  exit 3
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not on PATH" >&2
  exit 2
fi

# Print header so the operator/reviewer sees what they're about to paste.
echo "# Few-shot block — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# Source: ai_suggestion_audit (operator overrides)"
echo "# Top: ${TOP}"
echo

# Stream input with jq so we don't load the entire file into memory.
# `--arg` passes shell vars; numeric flags use --argjson.
COUNT=0
while IFS= read -r line; do
  if [[ -z "$line" ]]; then
    continue
  fi

  # Validate JSON shape; skip malformed rows defensively.
  if ! echo "$line" | jq -e . >/dev/null 2>&1; then
    continue
  fi

  ACTION=$(echo "$line" | jq -r '.operator_action // ""')
  AI_SUGGESTION=$(echo "$line" | jq -r '.ai_suggestion // ""')
  FINAL_OUTPUT=$(echo "$line" | jq -r '.final_output // ""')
  CONTEXT=$(echo "$line" | jq -r '.thread_context // ""')

  # Per hard rule: rejected = no final_output. Skip on flag, otherwise
  # render with a "rejected" marker (negative teaching signal).
  if [[ "$ACTION" == "rejected" && "$SKIP_REJECTED" == "1" ]]; then
    continue
  fi
  # Skip rows without an AI suggestion — nothing to teach about.
  if [[ -z "$AI_SUGGESTION" ]]; then
    continue
  fi

  # Truncate context to MAX_CONTEXT chars to keep prompt size bounded.
  if [[ ${#CONTEXT} -gt $MAX_CONTEXT ]]; then
    CONTEXT="${CONTEXT:0:$MAX_CONTEXT}…"
  fi

  COUNT=$((COUNT + 1))
  echo "### Příklad ${COUNT}"
  if [[ -n "$CONTEXT" ]]; then
    echo "Kontext: ${CONTEXT}"
  fi
  echo "AI návrh: ${AI_SUGGESTION}"
  if [[ "$ACTION" == "rejected" ]]; then
    echo "Operátor: zamítnuto (návrh neodeslán)"
  else
    echo "Lidská editace: ${FINAL_OUTPUT}"
  fi
  echo

  if [[ $COUNT -ge $TOP ]]; then
    break
  fi
done

if [[ $COUNT -eq 0 ]]; then
  echo "# (žádné použitelné override examples na vstupu)"
fi

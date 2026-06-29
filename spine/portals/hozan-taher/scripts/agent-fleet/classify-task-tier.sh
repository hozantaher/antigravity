#!/usr/bin/env bash
# classify-task-tier.sh — pre-spawn deterministic model-tier classifier
#
# Cíl (T2.1, north-star aspirace #1): every Agent spawn proposal MUSÍ
# nejprve projít přes tento script, který deterministicky vybere
# model tier (haiku / sonnet / opus) podle title/branch prefixu +
# override keywords. Nahrazuje manual "Sonnet vs Haiku?" rozhodnutí
# co podle PR #422 inventáře vede k 55 % Haiku-grade tasks na Sonnet.
#
# Heuristiky:
#   ~/.claude/projects/.../memory/feedback_haiku_classifier_heuristics.md
#   ~/.claude/projects/.../memory/feedback_subagent_token_economy.md
#
# Usage:
#   echo "feat(bff): wire reply pipeline"      | scripts/agent-fleet/classify-task-tier.sh
#   scripts/agent-fleet/classify-task-tier.sh "chore(deps): bump vite"
#   scripts/agent-fleet/classify-task-tier.sh --explain "perf(sender): batch flush"
#
# Output:
#   stdout: jeden řádek — `haiku` | `sonnet` | `opus`
#   stderr: pokud --explain, decision trace
#
# Exit codes:
#   0  classified (output platný)
#   1  unable to classify (empty input nebo neznámý prefix bez override)
#   2  argument error
#
# Dependencies: pure bash 3.2+; no node, no python, no jq.

set -u

# ---------------------------------------------------------------------------
# Argumenty
# ---------------------------------------------------------------------------

EXPLAIN=false
TITLE=""

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# *//;s/^#$//'
  exit 2
}

for arg in "$@"; do
  case "$arg" in
    --explain) EXPLAIN=true ;;
    --help|-h) usage ;;
    --*)
      printf '[classify] unknown flag: %s\n' "$arg" >&2
      exit 2
      ;;
    *)
      if [ -z "$TITLE" ]; then
        TITLE="$arg"
      else
        TITLE="$TITLE $arg"
      fi
      ;;
  esac
done

# Pokud title přes argument neexistuje, čti stdin.
if [ -z "$TITLE" ]; then
  if [ ! -t 0 ]; then
    TITLE=$(cat)
  fi
fi

# Strip leading/trailing whitespace + trim na 1 řádek.
TITLE=$(printf '%s' "$TITLE" | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

if [ -z "$TITLE" ]; then
  printf '[classify] error: empty input (provide title via stdin nebo argument)\n' >&2
  exit 1
fi

# Lower-cased verze pro keyword matching (case-insensitive).
LC_TITLE=$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]')

explain() {
  if [ "$EXPLAIN" = true ]; then
    printf '[classify] %s\n' "$*" >&2
  fi
}

# ---------------------------------------------------------------------------
# Override keywords (priority over prefix mapping)
# ---------------------------------------------------------------------------

# Opus triggers — extrémně rare; jen pokud title explicitně signalizuje
# cross-cutting reasoning across many packages nebo architectural revision.
OPUS_TRIGGERS=(
  "cross-cutting refactor"
  "multi-pass audit"
  "architectural revision"
  "monolith split"
)

for kw in "${OPUS_TRIGGERS[@]}"; do
  case "$LC_TITLE" in
    *"$kw"*)
      explain "opus trigger matched: '$kw'"
      printf 'opus\n'
      exit 0
      ;;
  esac
done

# Sonnet triggers — design / security / concurrency / vision keywords
# overrides default haiku tier.
SONNET_TRIGGERS=(
  "wire"
  "integrate"
  "pipeline"
  "architecture"
  "design"
  "security"
  " auth"
  "crypto"
  "hmac"
  "gdpr cascade"
  "vision"
  " llm"
  "inference"
  "concurrent"
  " race"
  " lock"
)

# Haiku triggers — mechanical / drift / cleanup / formatting keywords
# overrides default sonnet tier.
HAIKU_TRIGGERS=(
  "cleanup"
  "drift"
  "sweep"
  "consolidat"
  "dead code"
  "orphan"
  "bump baseline"
  "rebaseline"
  "snapshot"
  "lint"
  "format"
  "gofmt"
  "goimports"
  "align test"
)

match_keyword() {
  # $1 = haystack lowercased, $2..N = patterns
  local hay=$1; shift
  for pat in "$@"; do
    case "$hay" in
      *"$pat"*) return 0 ;;
    esac
  done
  return 1
}

# Override keywords mají přednost před prefix mapping. Sonnet trigger wins
# nad Haiku trigger (security/auth always > cleanup), takže evalujeme Sonnet
# až po Haiku-default-tier, ale Sonnet override se kontroluje PRVNÍ pokud
# title obsahuje hard sonnet keyword.

if match_keyword "$LC_TITLE" "${SONNET_TRIGGERS[@]}"; then
  SONNET_OVERRIDE=true
else
  SONNET_OVERRIDE=false
fi

if match_keyword "$LC_TITLE" "${HAIKU_TRIGGERS[@]}"; then
  HAIKU_OVERRIDE=true
else
  HAIKU_OVERRIDE=false
fi

# Sonnet override má vyšší prioritu — security/concurrent/auth nikdy
# nemůže klesnout na haiku jen proto, že title obsahuje "cleanup".
if [ "$SONNET_OVERRIDE" = true ]; then
  explain "sonnet keyword override matched"
  printf 'sonnet\n'
  exit 0
fi

if [ "$HAIKU_OVERRIDE" = true ]; then
  explain "haiku keyword override matched"
  printf 'haiku\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Prefix-based default mapping
# ---------------------------------------------------------------------------

# Extract prefix typu `chore`, `chore(scope)`, `feat(scope)`, atd.
# Konvenční commit format: `type(scope): description` — colon je MANDATORY,
# bez colonu nelze spolehlivě extrahovat type, takže "no prefix" → unknown.
case "$LC_TITLE" in
  *:*) ;;
  *)
    explain "no colon in title — cannot extract conventional commit prefix"
    printf '[classify] error: no conventional-commit prefix (chybí colon) v "%s"\n' "$TITLE" >&2
    exit 1
    ;;
esac

PREFIX=$(printf '%s' "$LC_TITLE" | sed -E 's/^([a-z]+(\([^)]*\))?):.*/\1/')
# Pokud sed-extract neredukoval string, prefix neodpovídá konvenci (např. "wat foo: bar").
if [ "$PREFIX" = "$LC_TITLE" ]; then
  explain "title nematches conventional commit format (type[(scope)]: ...)"
  printf '[classify] error: title nematches "type(scope): ..." format\n' >&2
  exit 1
fi
TYPE=$(printf '%s' "$PREFIX" | sed -E 's/^([a-z]+).*/\1/')
SCOPE=$(printf '%s' "$PREFIX" | sed -nE 's/^[a-z]+\(([^)]+)\)$/\1/p')

explain "prefix='$PREFIX' type='$TYPE' scope='$SCOPE'"

case "$TYPE" in
  chore)
    # Mechanical maintenance — vždy haiku.
    explain "type=chore → haiku"
    printf 'haiku\n'
    exit 0
    ;;
  docs)
    # docs(adr) a docs(strategy) jsou design/vision → sonnet.
    case "$SCOPE" in
      adr|strategy)
        explain "type=docs scope=$SCOPE → sonnet (design)"
        printf 'sonnet\n'
        exit 0
        ;;
      *)
        explain "type=docs → haiku"
        printf 'haiku\n'
        exit 0
        ;;
    esac
    ;;
  test)
    # test(contract|audit|unit) = haiku; test(integration|e2e) = sonnet.
    case "$SCOPE" in
      contract|audit|unit)
        explain "type=test scope=$SCOPE → haiku"
        printf 'haiku\n'
        exit 0
        ;;
      integration|e2e)
        explain "type=test scope=$SCOPE → sonnet"
        printf 'sonnet\n'
        exit 0
        ;;
      *)
        # Bez scope → conservative default haiku (snapshot/coverage typicky).
        explain "type=test no-scope → haiku (default)"
        printf 'haiku\n'
        exit 0
        ;;
    esac
    ;;
  fix)
    # fix(test) = haiku (test repair). fix(<modul>) = sonnet (production code).
    case "$SCOPE" in
      test)
        explain "type=fix scope=test → haiku"
        printf 'haiku\n'
        exit 0
        ;;
      *)
        explain "type=fix → sonnet (production code change)"
        printf 'sonnet\n'
        exit 0
        ;;
    esac
    ;;
  refactor)
    # Bez další signal info — design refactor je obvykle sonnet, mechanical
    # rename je haiku (caught by HAIKU_OVERRIDE výše). Default = sonnet.
    explain "type=refactor → sonnet (default; haiku triggers caught earlier)"
    printf 'sonnet\n'
    exit 0
    ;;
  feat|perf|sec)
    explain "type=$TYPE → sonnet"
    printf 'sonnet\n'
    exit 0
    ;;
  audit)
    # audit(inventory) je context-dependent; default haiku, escalate na sonnet
    # přes keyword override (např. "deep" + audit). Conservative default haiku.
    explain "type=audit → haiku (default; deep/multi-pass keyword would override)"
    printf 'haiku\n'
    exit 0
    ;;
  ci)
    # CI changes obvykle mechanical wiring → haiku.
    explain "type=ci → haiku"
    printf 'haiku\n'
    exit 0
    ;;
  *)
    explain "unknown prefix '$TYPE' — unable to classify"
    printf '[classify] error: unknown prefix "%s" — extend table v ' "$TYPE" >&2
    printf 'feedback_haiku_classifier_heuristics.md\n' >&2
    exit 1
    ;;
esac

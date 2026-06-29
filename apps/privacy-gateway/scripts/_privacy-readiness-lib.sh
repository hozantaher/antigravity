#!/bin/sh

set -eu

load_readiness_output() {
  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  READINESS_OUTPUT="$("${script_dir}/show-privacy-rc-readiness.sh")"
  export READINESS_OUTPUT
}

readiness_field() {
  key="$1"
  printf '%s\n' "${READINESS_OUTPUT:-}" | sed -n "s/^${key}: //p" | head -n 1
}

split_blockers_lines() {
  blockers="${1:-}"
  if [ -z "${blockers}" ] || [ "${blockers}" = "unknown" ] || [ "${blockers}" = "none" ]; then
    return 0
  fi

  printf '%s\n' "${blockers}" \
    | tr ';' '\n' \
    | sed -e 's/^ *//' -e 's/ *$//' \
    | sed '/^$/d'
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

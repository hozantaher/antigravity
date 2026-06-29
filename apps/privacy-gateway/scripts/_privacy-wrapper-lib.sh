#!/bin/sh

set -eu

run_privacy_gateway_script() {
  target_name="$1"
  shift

  script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  root_dir="$(CDPATH= cd -- "${script_dir}/.." && pwd)"
  privacy_gateway_dir="${root_dir}/services/privacy-gateway"
  target_script="${privacy_gateway_dir}/scripts/${target_name}"

  if [ ! -x "${target_script}" ]; then
    echo "FAIL: expected executable script not found: ${target_script}"
    echo "Hint: ensure services/privacy-gateway/scripts/${target_name} exists and is executable."
    exit 1
  fi

  cd "${privacy_gateway_dir}"
  "${target_script}" "$@"
}

#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/sandboxed-home/claude-data"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[clean]${NC} $1"; }
warn() { echo -e "${YELLOW}[clean]${NC} $1"; }

if [ ! -d "${DATA_DIR}" ]; then
    info "No claude-data directory found. Nothing to clean."
    exit 0
fi

BEFORE=$(du -sm "${DATA_DIR}" 2>/dev/null | cut -f1)

CACHE_DIRS=(
    "Cache"
    "Code Cache"
    "blob_storage"
    "vm_bundles"
    "Crashpad"
    "DawnGraphiteCache"
    "DawnWebGPUCache"
    "GPUCache"
    "sentry"
)

for dir in "${CACHE_DIRS[@]}"; do
    TARGET="${DATA_DIR}/${dir}"
    if [ -d "${TARGET}" ]; then
        SIZE=$(du -sh "${TARGET}" 2>/dev/null | cut -f1)
        info "Removing ${dir}/ (${SIZE})"
        rm -rf "${TARGET}"
    fi
done

AFTER=$(du -sm "${DATA_DIR}" 2>/dev/null | cut -f1)
SAVED=$((BEFORE - AFTER))

echo ""
info "Cleaned ${SAVED} MB. Data dir: ${AFTER} MB."
info "Preserved: Local Storage/ (auth tokens), config.json, Cookies"

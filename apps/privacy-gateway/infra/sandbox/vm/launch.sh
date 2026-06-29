#!/bin/bash
set -e

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

VM_NAME="claude-sandbox"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[vm]${NC} $1"; }
warn()  { echo -e "${YELLOW}[vm]${NC} $1"; }
error() { echo -e "${RED}[vm]${NC} $1"; }

# Find UTM
UTM_APP=$(find /opt/homebrew/Caskroom/utm -name "UTM.app" -maxdepth 3 2>/dev/null | head -1)
[ -z "${UTM_APP}" ] && UTM_APP="/Applications/UTM.app"

if [ ! -d "${UTM_APP}" ]; then
    error "UTM not found. Install: brew install --cask utm"
    exit 1
fi

UTMCTL="${UTM_APP}/Contents/MacOS/utmctl"

# Start UTM if not running
if ! pgrep -q UTM; then
    info "Starting UTM..."
    open "${UTM_APP}"
    sleep 3
fi

# Check VM exists
if ! "${UTMCTL}" list 2>/dev/null | grep -q "${VM_NAME}"; then
    error "VM '${VM_NAME}' not found in UTM."
    echo "     Run setup-vm.sh first, then create the VM in UTM GUI."
    exit 1
fi

# Start or report status
STATUS=$("${UTMCTL}" status "${VM_NAME}" 2>/dev/null || echo "unknown")
if echo "${STATUS}" | grep -qi "started"; then
    info "VM already running."
elif echo "${STATUS}" | grep -qi "paused"; then
    info "Resuming paused VM..."
    "${UTMCTL}" start "${VM_NAME}"
else
    info "Starting ${VM_NAME}..."
    "${UTMCTL}" start "${VM_NAME}"
fi

echo ""
echo -e "${BOLD}${GREEN}Claude Sandbox VM running.${NC}"
echo -e "  User: ${BOLD}claude${NC} / Password: ${BOLD}claude${NC}"
echo -e "  Stop: ${YELLOW}${UTMCTL} stop ${VM_NAME}${NC}"

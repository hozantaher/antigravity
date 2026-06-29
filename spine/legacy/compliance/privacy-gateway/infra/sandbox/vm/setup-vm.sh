#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="${SCRIPT_DIR}"
VM_NAME="claude-sandbox"
DISK_SIZE="20G"
RAM_MB=4096
CPU_CORES=4

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[vm]${NC} $1"; }
warn()  { echo -e "${YELLOW}[vm]${NC} $1"; }
error() { echo -e "${RED}[vm]${NC} $1"; }

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

# ── Check dependencies ──
if ! command -v qemu-img &>/dev/null; then
    info "Installing qemu (for qemu-img)..."
    brew install qemu
fi

UTM_APP=$(find /opt/homebrew/Caskroom/utm -name "UTM.app" -maxdepth 3 2>/dev/null | head -1)
if [ -z "${UTM_APP}" ]; then
    UTM_APP="/Applications/UTM.app"
fi

if [ ! -d "${UTM_APP}" ]; then
    error "UTM not found. Install: brew install --cask utm"
    exit 1
fi

UTMCTL="${UTM_APP}/Contents/MacOS/utmctl"
if [ ! -x "${UTMCTL}" ]; then
    error "utmctl not found at ${UTMCTL}"
    exit 1
fi

# ── Check cloud image ──
IMG="${VM_DIR}/ubuntu-noble-arm64.img"
if [ ! -f "${IMG}" ]; then
    info "Downloading Ubuntu 24.04 ARM64 cloud image..."
    curl -L --retry 3 --retry-delay 5 -o "${IMG}.tmp" \
        "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img"
    # Verify minimum size (cloud images are >500MB)
    FILE_SIZE=$(stat -f%z "${IMG}.tmp" 2>/dev/null || stat -c%s "${IMG}.tmp" 2>/dev/null)
    if [ "${FILE_SIZE}" -lt 100000000 ]; then
        error "Downloaded image too small (${FILE_SIZE} bytes). Corrupt download?"
        rm -f "${IMG}.tmp"
        exit 1
    fi
    mv "${IMG}.tmp" "${IMG}"
    info "Image downloaded: $(du -h "${IMG}" | cut -f1)"
else
    info "Cloud image already exists: $(du -h "${IMG}" | cut -f1)"
fi

# ── Create cloud-init ISO ──
info "Creating cloud-init seed ISO..."
SEED_ISO="${VM_DIR}/seed.iso"

if command -v mkisofs &>/dev/null; then
    MKISO="mkisofs"
elif command -v genisoimage &>/dev/null; then
    MKISO="genisoimage"
else
    # Use hdiutil on macOS as fallback
    SEED_DIR=$(mktemp -d)
    cp "${VM_DIR}/user-data" "${SEED_DIR}/user-data"
    cp "${VM_DIR}/meta-data" "${SEED_DIR}/meta-data"
    hdiutil makehybrid -o "${SEED_ISO}" "${SEED_DIR}" \
        -joliet -iso -default-volume-name cidata 2>/dev/null
    rm -rf "${SEED_DIR}"
    MKISO="done"
fi

if [ "${MKISO}" != "done" ]; then
    ${MKISO} -output "${SEED_ISO}" -volid cidata -joliet -rock \
        "${VM_DIR}/user-data" "${VM_DIR}/meta-data"
fi

# ── Prepare disk ──
DISK="${VM_DIR}/claude-sandbox-disk.qcow2"
if [ ! -f "${DISK}" ]; then
    info "Creating VM disk (${DISK_SIZE})..."
    cp "${IMG}" "${DISK}"
    qemu-img resize "${DISK}" "${DISK_SIZE}"
else
    info "VM disk already exists (use --reset-disk to recreate)"
fi

if [ "$1" = "--reset-disk" ]; then
    warn "Resetting VM disk from base image..."
    cp "${IMG}" "${DISK}"
    qemu-img resize "${DISK}" "${DISK_SIZE}"
fi

info "VM disk ready: ${DISK} ($(du -h "${DISK}" | cut -f1))"
info "Cloud-init ISO ready: ${SEED_ISO}"

echo ""
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${CYAN}  Claude Sandbox VM — Setup Complete${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Now create the VM in UTM:"
echo ""
echo -e "  1. Open UTM"
echo -e "  2. Create New VM → Virtualize → Linux"
echo -e "  3. Boot ISO: ${YELLOW}skip (no boot ISO)${NC}"
echo -e "  4. Hardware: ${GREEN}${RAM_MB} MB RAM, ${CPU_CORES} cores${NC}"
echo -e "  5. Storage: ${GREEN}Import → ${DISK}${NC}"
echo -e "  6. Add drive: ${GREEN}Import → ${SEED_ISO} (USB, read-only)${NC}"
echo -e "  7. Enable: ${GREEN}Clipboard sharing, Directory sharing${NC}"
echo ""
echo -e "  After first boot, cloud-init will:"
echo -e "    - Install Ubuntu Desktop + Claude Desktop"
echo -e "    - Create user: ${GREEN}claude${NC} / password: ${GREEN}claude${NC}"
echo -e "    - Auto-login and reboot to GUI"
echo ""
echo -e "  ${YELLOW}First boot takes ~10 minutes (package installation).${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════${NC}"

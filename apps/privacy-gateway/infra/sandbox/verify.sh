#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${SCRIPT_DIR}/claude-desktop.sb"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0

pass() {
    echo -e "  ${GREEN}PASS${NC}  $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "  ${RED}FAIL${NC}  $1"
    FAIL=$((FAIL + 1))
}

echo -e "${BOLD}Claude Sandbox — Verification${NC}"
echo ""

# Test 1: Profile parses
if sandbox-exec -f "${PROFILE}" /usr/bin/true 2>/dev/null; then
    pass "Profile parses"
else
    fail "Profile parses"
fi

# Test 2: Filesystem isolation — SSH keys blocked
if sandbox-exec -f "${PROFILE}" cat ~/.ssh/id_rsa 2>/dev/null; then
    fail "Filesystem isolation (cat ~/.ssh/id_rsa should be denied)"
else
    pass "Filesystem isolation (cat ~/.ssh/id_rsa → denied)"
fi

# Test 3: Process block — osascript
if sandbox-exec -f "${PROFILE}" /usr/bin/osascript -e 'display dialog "test"' 2>/dev/null; then
    fail "Process block (osascript should be denied)"
else
    pass "Process block (osascript → denied)"
fi

# Test 4: Process block — curl
if sandbox-exec -f "${PROFILE}" /usr/bin/curl http://example.com:8080 2>/dev/null; then
    fail "Process block (curl should be denied)"
else
    pass "Process block (curl → denied)"
fi

# Test 5: Process block — ssh
if sandbox-exec -f "${PROFILE}" /usr/bin/ssh localhost 2>/dev/null; then
    fail "Process block (ssh should be denied)"
else
    pass "Process block (ssh → denied)"
fi

echo ""
echo -e "${BOLD}Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"

if [ "${FAIL}" -gt 0 ]; then
    echo -e "${RED}Sandbox verification failed. Review claude-desktop.sb.${NC}"
    exit 1
fi

echo -e "${GREEN}All checks passed. Sandbox is operational.${NC}"
echo ""
echo -e "${YELLOW}Note: Claude Desktop launch (GUI) must be verified manually:${NC}"
echo "  ./launch.sh → send a message → confirm response"

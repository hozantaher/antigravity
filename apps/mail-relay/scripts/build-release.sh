#!/bin/bash
# Build release binaries for all supported platforms
#
# Usage: bash scripts/build-release.sh [version]
# Output: dist/<version>/<os>-<arch>/

set -euo pipefail

VERSION="${1:-0.1.0}"
DIST="dist/$VERSION"
MODULE="anti-trace-relay"

PLATFORMS=(
  "linux/amd64"
  "linux/arm64"
  "darwin/amd64"
  "darwin/arm64"
  "windows/amd64"
)

echo "=== Building $MODULE v$VERSION ==="
echo ""

mkdir -p "$DIST"

for PLATFORM in "${PLATFORMS[@]}"; do
  OS="${PLATFORM%/*}"
  ARCH="${PLATFORM#*/}"
  DIR="$DIST/${OS}-${ARCH}"
  mkdir -p "$DIR"

  EXT=""
  if [ "$OS" = "windows" ]; then
    EXT=".exe"
  fi

  echo "[$OS/$ARCH] Building relay..."
  CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" go build \
    -ldflags="-s -w" \
    -o "$DIR/anti-trace-relay${EXT}" \
    ./cmd/anti-trace-relay/

  echo "[$OS/$ARCH] Building submit..."
  CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" go build \
    -ldflags="-s -w" \
    -o "$DIR/submit${EXT}" \
    ./cmd/submit/

  echo "[$OS/$ARCH] Building receive..."
  CGO_ENABLED=0 GOOS="$OS" GOARCH="$ARCH" go build \
    -ldflags="-s -w" \
    -o "$DIR/receive${EXT}" \
    ./cmd/receive/

  # Show sizes
  RELAY_SIZE=$(ls -lh "$DIR/anti-trace-relay${EXT}" | awk '{print $5}')
  SUBMIT_SIZE=$(ls -lh "$DIR/submit${EXT}" | awk '{print $5}')
  RECEIVE_SIZE=$(ls -lh "$DIR/receive${EXT}" | awk '{print $5}')
  echo "  relay: $RELAY_SIZE  submit: $SUBMIT_SIZE  receive: $RECEIVE_SIZE"
  echo ""
done

# Generate checksums
echo "Generating checksums..."
cd "$DIST"
find . -type f \( -name "anti-trace-relay*" -o -name "submit*" -o -name "receive*" \) | sort | while read f; do
  shasum -a 256 "$f"
done > SHA256SUMS
cd - > /dev/null

echo "=== Build complete ==="
echo ""
echo "Artifacts: $DIST/"
ls -la "$DIST/"
echo ""
echo "Checksums: $DIST/SHA256SUMS"
cat "$DIST/SHA256SUMS"

#!/bin/sh
set -e

# Download/update databases in background — server starts immediately
# Database is in PostgreSQL (Railway) — no local download needed

echo "Starting MCP server on port ${MCP_PORT:-3002}..."
exec "$@"

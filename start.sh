#!/bin/bash
cd "$(dirname "$0")"
echo "========================================"
echo "  AI PR Review Assistant - Web UI"
echo "  http://localhost:3300"
echo "========================================"
npx tsx src/server.ts

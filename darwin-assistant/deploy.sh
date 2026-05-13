#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "==> Installing dependencies (with devDeps for build)..."
npm install

echo "==> Building TypeScript..."
npx tsc

echo "==> Pruning dev dependencies..."
npm prune --omit=dev 2>/dev/null || true

echo "==> Restarting JARVIS service..."
sudo systemctl restart jarvis

echo "==> Status:"
systemctl status jarvis --no-pager -l

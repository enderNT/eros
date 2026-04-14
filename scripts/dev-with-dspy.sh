#!/bin/sh
set -eu

if [ ! -x ".venv/bin/python" ]; then
  echo "Missing .venv. Create it with: python3 -m venv .venv && ./.venv/bin/pip install -r dspy_service/requirements.txt"
  exit 1
fi

cleanup() {
  if [ -n "${BUN_PID:-}" ]; then
    kill "$BUN_PID" 2>/dev/null || true
  fi
  if [ -n "${DSPY_PID:-}" ]; then
    kill "$DSPY_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

./.venv/bin/python -m uvicorn app:app --app-dir dspy_service --host "${DSPY_HOST:-0.0.0.0}" --port "${DSPY_PORT:-8001}" --reload &
DSPY_PID=$!

bun --watch src/index.ts &
BUN_PID=$!

wait "$BUN_PID" "$DSPY_PID"

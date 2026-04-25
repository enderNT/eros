#!/bin/sh
set -eu

if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

exec bun ./scripts/export-dspy-task-traces.ts "$@"

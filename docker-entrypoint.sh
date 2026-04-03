#!/bin/sh
set -eu

HOST="${APP_HOST:-0.0.0.0}"
PORT_TO_USE="${PORT:-${APP_PORT:-8000}}"

exec python -m uvicorn app.main:create_app \
  --factory \
  --host "${HOST}" \
  --port "${PORT_TO_USE}"

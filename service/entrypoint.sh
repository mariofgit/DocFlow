#!/bin/sh
set -e
# Production-style ASGI server (same image ECS Fargate and local Docker Compose).
# GUNICORN_TIMEOUT must exceed the app sync limit (120s) so workers are not killed mid-conversion.
exec gunicorn main:app \
  -k uvicorn.workers.UvicornWorker \
  --bind "0.0.0.0:${PORT:-8080}" \
  --workers "${GUNICORN_WORKERS:-2}" \
  --timeout "${GUNICORN_TIMEOUT:-130}" \
  --graceful-timeout 30 \
  --access-logfile - \
  --error-logfile -

# syntax=docker/dockerfile:1
# Multi-stage build: same Dockerfile is used by docker-compose (local) and CDK `fromAsset(service/)` (ECS Fargate).

# -----------------------------------------------------------------------------
# Builder: Python deps + Docling model warm-up (shrinks cold start on Fargate).
# -----------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install -r requirements.txt

COPY . .

# Pre-download models / init DocumentConverter at build time (network during build).
RUN python -c "from docling.document_converter import DocumentConverter; DocumentConverter()"

# -----------------------------------------------------------------------------
# Runtime: minimal OS libs + venv + app (no compilers / build deps).
# -----------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8080 \
    GUNICORN_WORKERS=2 \
    GUNICORN_TIMEOUT=130

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY --from=builder /app /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]

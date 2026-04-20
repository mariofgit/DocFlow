#!/usr/bin/env bash
# Demo: convert a local PDF to Markdown via the Docling API (Docker Compose or local uvicorn).
set -euo pipefail

BASE_URL="${DOCLING_BASE_URL:-http://127.0.0.1:8080}"
API_KEY="${DOCLING_API_KEY:?Set DOCLING_API_KEY (same as in .env)}"
PDF_PATH="${1:-samples/local-demo.pdf}"

if [[ ! -f "$PDF_PATH" ]]; then
  echo "Usage: DOCLING_API_KEY=... $0 [path/to/file.pdf]"
  echo "Missing file: $PDF_PATH"
  echo "Place a small PDF at samples/local-demo.pdf or pass a path."
  exit 1
fi

echo "POST $BASE_URL/api/v1/convert (markdown, ocr on) ..."
curl -sS -X POST "${BASE_URL}/api/v1/convert" \
  -H "X-API-Key: ${API_KEY}" \
  -F "file=@${PDF_PATH}" \
  -F "output_format=markdown" \
  -F "ocr_enabled=true" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("content", d))'

echo ""
echo "Done."

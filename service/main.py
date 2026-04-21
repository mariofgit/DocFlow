"""
Docling document conversion API (Phase 1: sync only).
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from converter import convert_file

MAX_SYNC_BYTES = 10 * 1024 * 1024


def _sync_timeout_seconds() -> float:
    raw = os.environ.get("SYNC_TIMEOUT_SECONDS", "120").strip()
    try:
        return max(30.0, min(float(raw), 600.0))
    except ValueError:
        return 120.0

API_KEY_ENV = "DOCLING_API_KEY"
# Local-only alias (ECS should use DOCLING_API_KEY from Secrets Manager).
API_KEY_LOCAL_ALIAS = "API_KEY"
# Solo entorno local: inyecta DOCLING_API_KEY en la página /ui/ (no usar en ECS público).
INJECT_UI_KEY_ENV = "DOCFLOW_UI_PREFILL_API_KEY"


def _expected_api_key() -> str | None:
    return os.environ.get(API_KEY_ENV) or os.environ.get(API_KEY_LOCAL_ALIAS)


def _path_exempt_from_api_key(path: str) -> bool:
    """Static UI and health checks are public; conversion stays behind X-API-Key (PRD)."""
    if path in ("/health", "/healthz"):
        return True
    if path == "/":
        return True
    if path.startswith("/ui"):
        return True
    if path.startswith("/docflow-assets"):
        return True
    if path == "/favicon.ico":
        return True
    if path.startswith("/.well-known"):
        return True
    return False


def _inject_ui_api_key_enabled() -> bool:
    v = os.environ.get(INJECT_UI_KEY_ENV, "").strip().lower()
    return v in ("1", "true", "yes", "on")


class ApiKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if _path_exempt_from_api_key(path):
            return await call_next(request)
        expected = _expected_api_key()
        if not expected:
            return JSONResponse(
                status_code=500,
                content={
                    "detail": "Server misconfiguration: set DOCLING_API_KEY (or API_KEY for local dev)",
                },
            )
        got = (request.headers.get("X-API-Key") or "").strip()
        if got != (expected or "").strip():
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        return await call_next(request)


class MaxBodySizeMiddleware(BaseHTTPMiddleware):
    """Reject large POST /api/v1/convert requests using Content-Length when present."""

    async def dispatch(self, request: Request, call_next):
        if request.method == "POST" and request.url.path == "/api/v1/convert":
            cl = request.headers.get("content-length")
            if cl is not None:
                try:
                    n = int(cl)
                except ValueError:
                    return await call_next(request)
                if n > MAX_SYNC_BYTES:
                    return JSONResponse(
                        status_code=413,
                        content={
                            "detail": (
                                "Payload too large for synchronous conversion (max 10 MB). "
                                "Use the async endpoint (Phase 2) for larger files."
                            )
                        },
                    )
        return await call_next(request)


app = FastAPI(title="Docling conversion service", version="0.1.0")
app.add_middleware(MaxBodySizeMiddleware)
app.add_middleware(ApiKeyMiddleware)

_UI_DIR = Path(__file__).resolve().parent / "ui"
_UI_INDEX = _UI_DIR / "index.html"
_UI_ASSETS = _UI_DIR / "assets"


@app.get("/ui")
async def ui_slash_redirect():
    return RedirectResponse(url="/ui/", status_code=302)


@app.get("/ui/", response_class=HTMLResponse)
@app.get("/ui/index.html", response_class=HTMLResponse)
async def docflow_ui_index():
    """Sirve la UI; opcionalmente inyecta la clave si DOCFLOW_UI_PREFILL_API_KEY está activo (solo local)."""
    if not _UI_INDEX.is_file():
        return HTMLResponse("UI no encontrada", status_code=404)
    html = _UI_INDEX.read_text(encoding="utf-8")
    if _inject_ui_api_key_enabled():
        key = _expected_api_key() or ""
        inject = f"<script>window.__DOCFLOW_PREFILL_API_KEY__={json.dumps(key)};</script>\n"
    else:
        inject = ""
    marker = "<!-- DOCFLOW_UI_INJECT -->"
    if marker in html:
        html = html.replace(marker, inject, 1)
    else:
        html = inject + html
    return HTMLResponse(html)


if _UI_ASSETS.is_dir():
    app.mount(
        "/docflow-assets",
        StaticFiles(directory=str(_UI_ASSETS)),
        name="docflow_ui_assets",
    )


@app.get("/")
async def root():
    if _UI_INDEX.is_file():
        return RedirectResponse(url="/ui/", status_code=302)
    return JSONResponse({"service": "docling", "health": "/health"})


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)


def _page_count(doc) -> int | None:
    if hasattr(doc, "pages") and doc.pages is not None:
        try:
            return len(doc.pages)
        except TypeError:
            return None
    return None


@app.post("/api/v1/convert")
async def convert(
    file: UploadFile = File(...),
    output_format: str = Form("markdown"),
    ocr_enabled: bool = Form(True),
):
    sync_timeout = _sync_timeout_seconds()
    if output_format not in ("markdown", "json"):
        raise HTTPException(
            status_code=400,
            detail='output_format must be "markdown" or "json"',
        )

    filename = file.filename or "document"
    suffix = Path(filename).suffix.lower() or ".bin"
    data = await file.read()
    if len(data) > MAX_SYNC_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                "Payload too large for synchronous conversion (max 10 MB). "
                "Use the async endpoint (Phase 2) for larger files."
            ),
        )

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:

        def _run():
            return convert_file(tmp_path, ocr_enabled=ocr_enabled)

        doc, elapsed, ocr_flag = await asyncio.wait_for(
            asyncio.to_thread(_run),
            timeout=sync_timeout,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"Conversion exceeded {int(sync_timeout)} seconds",
        ) from None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    processing_ms = int(round(elapsed * 1000))
    pages = _page_count(doc)

    if output_format == "markdown":
        content = doc.export_to_markdown()
        body = {
            "status": "success",
            "filename": filename,
            "output_format": "markdown",
            "content": content,
            "metadata": {
                "pages": pages,
                "processing_time_ms": processing_ms,
                "ocr_applied": ocr_flag,
            },
        }
        return JSONResponse(content=jsonable_encoder(body))

    payload = doc.export_to_dict()
    body = {
        "status": "success",
        "filename": filename,
        "output_format": "json",
        "content": payload,
        "metadata": {
            "pages": pages,
            "processing_time_ms": processing_ms,
            "ocr_applied": ocr_flag,
        },
    }
    return JSONResponse(content=jsonable_encoder(body))

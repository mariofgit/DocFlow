"""Docling DocumentConverter wiring (sync conversion, optional OCR for PDF)."""

from __future__ import annotations

import time
from threading import Lock
from typing import Any

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

_converters: dict[bool, DocumentConverter] = {}
_lock = Lock()


def _get_converter(ocr_enabled: bool) -> DocumentConverter:
    with _lock:
        if ocr_enabled not in _converters:
            pdf_opts = PdfPipelineOptions()
            pdf_opts.do_ocr = ocr_enabled
            _converters[ocr_enabled] = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_opts),
                }
            )
        return _converters[ocr_enabled]


def convert_file(path: str, *, ocr_enabled: bool) -> tuple[Any, float, bool]:
    """
    Returns (docling_document, processing_time_seconds, ocr_applied).
    ocr_applied reflects the PDF pipeline flag; other formats use library defaults.
    """
    t0 = time.perf_counter()
    converter = _get_converter(ocr_enabled)
    result = converter.convert(path)
    elapsed = time.perf_counter() - t0
    doc = result.document
    return doc, elapsed, ocr_enabled

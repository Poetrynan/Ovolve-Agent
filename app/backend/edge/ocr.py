"""edge/ocr.py - Optical character recognition wrapper.

Prefers PaddleOCR (PP-OCR) when installed. When it isn't, ``OCR.available``
reports False and inference returns a clear failure — never raises.
"""
from __future__ import annotations
import os
from typing import Optional
from result import Result

try:
    from paddleocr import PaddleOCR  # type: ignore
    _HAS_PADDLE = True
except ImportError:
    PaddleOCR = None  # type: ignore
    _HAS_PADDLE = False


class OCR:
    """PP-OCR text recognition.

    Args:
        lang: Recognition language code (``ch`` / ``en`` / etc.).
        use_gpu: Whether to attempt GPU inference (falls back to CPU on
            failure).
    """

    def __init__(self, lang: str = "ch", use_gpu: bool = False) -> None:
        self.lang = lang
        self.use_gpu = use_gpu
        self._engine = None
        if _HAS_PADDLE:
            try:
                self._engine = PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=use_gpu)
            except Exception:
                # Model download or GPU init may fail — the backend simply
                # reports unavailable so the caller can degrade.
                self._engine = None

    @property
    def available(self) -> bool:
        return self._engine is not None

    def recognize(self, image_path: str) -> Result:
        """Extract text from an image file.

        Args:
            image_path: Path to the image.

        Returns:
            Result with a dict::

                {"text": "joined text",
                 "lines": [{"text": ..., "bbox": [...], "confidence": ...}]}
        """
        if not self.available:
            return Result.failure("PaddleOCR not available", code="OCRUnavailable")
        if not os.path.exists(image_path):
            return Result.failure(f"Image not found: {image_path}", code="ImageNotFound")
        try:
            raw = self._engine.ocr(image_path, cls=True)
        except Exception as e:
            return Result.failure(f"OCR failed: {e}", code="OCRFailed")

        lines: list[dict] = []
        for page in raw or []:
            if not page:
                continue
            for entry in page:
                if not entry or len(entry) < 2:
                    continue
                bbox, (text, conf) = entry[0], entry[1]
                lines.append({
                    "text": text,
                    "bbox": bbox,
                    "confidence": float(conf),
                })
        joined = "\n".join(line["text"] for line in lines)
        return Result.success({"text": joined, "lines": lines})

"""edge package - On-device inference backends (OpenVINO / ONNX / PP-OCR).

Import ``edge.pick_backend()`` for automatic selection.
"""
from edge.base import EdgeBackend, NullBackend, pick_backend

__all__ = ["EdgeBackend", "NullBackend", "pick_backend"]

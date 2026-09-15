"""edge/openvino_backend.py - Intel OpenVINO inference backend.

Wraps ``openvino.runtime`` when available. Fails gracefully (reports
``available=False``) when the library is missing so the higher-level
``pick_backend`` selector can fall through to ONNX or Null.
"""
from __future__ import annotations
from typing import Any, Optional
from result import Result
from edge.base import EdgeBackend

try:
    import openvino as ov  # type: ignore
    _HAS_OPENVINO = True
except ImportError:
    ov = None  # type: ignore
    _HAS_OPENVINO = False


class OpenVINOBackend(EdgeBackend):
    """OpenVINO inference backend.

    Args:
        device: Target device: CPU / GPU / NPU / AUTO.
    """

    name = "openvino"

    def __init__(self, device: str = "AUTO") -> None:
        self.device = device
        self._core: Any = None
        self._model: Any = None
        self._compiled: Any = None
        if _HAS_OPENVINO:
            self._core = ov.Core()

    @property
    def available(self) -> bool:
        """Whether the openvino package imported successfully."""
        return _HAS_OPENVINO

    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        """Load and compile an OpenVINO IR / ONNX model.

        Args:
            model_path: Path to .xml/.onnx/.bin.
            **kwargs: device override.

        Returns:
            Result with compiled model metadata on success.
        """
        if not self.available:
            return Result.failure("OpenVINO not installed", code="LibraryMissing")
        try:
            device = kwargs.get("device", self.device)
            self._model = self._core.read_model(model_path)
            self._compiled = self._core.compile_model(self._model, device)
        except Exception as e:
            return Result.failure(f"OpenVINO load_model failed: {e}", code="LoadFailed")
        return Result.success({
            "device": device,
            "input_names": [t.get_any_name() for t in self._compiled.inputs],
            "output_names": [t.get_any_name() for t in self._compiled.outputs],
        })

    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        """Run inference. ``inputs`` should be a dict of {input_name: ndarray}
        or a single ndarray for a single-input model.

        Args:
            inputs: Numpy array or dict of arrays.

        Returns:
            Result with the raw output tensors.
        """
        if not self.available or self._compiled is None:
            return Result.failure("No model loaded", code="NoModel")
        try:
            request = self._compiled.create_infer_request()
            outputs = request.infer(inputs)
        except Exception as e:
            return Result.failure(f"OpenVINO infer failed: {e}", code="InferFailed")
        # Convert to name-keyed dict for consumer convenience
        result = {t.get_any_name(): outputs[t] for t in self._compiled.outputs}
        return Result.success(result)

    def unload(self) -> None:
        """Release compiled model resources."""
        self._compiled = None
        self._model = None

    def get_metadata(self) -> dict:
        return {
            **super().get_metadata(),
            "device": self.device,
            "loaded": self._compiled is not None,
        }

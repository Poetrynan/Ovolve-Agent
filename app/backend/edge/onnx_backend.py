"""edge/onnx_backend.py - ONNX Runtime cross-platform inference backend."""
from __future__ import annotations
from typing import Any
from result import Result
from edge.base import EdgeBackend

try:
    import onnxruntime as ort  # type: ignore
    _HAS_ONNX = True
except ImportError:
    ort = None  # type: ignore
    _HAS_ONNX = False


class ONNXBackend(EdgeBackend):
    """ONNX Runtime backend for cross-platform inference.

    Args:
        providers: Ordered list of execution providers. Defaults to CPU only
            because that is the only provider ORT installs by default; call
            sites that want GPU should pass ``["CUDAExecutionProvider", ...]``.
    """

    name = "onnx"

    def __init__(self, providers: list[str] = None) -> None:
        self.providers = providers or ["CPUExecutionProvider"]
        self._session: Any = None

    @property
    def available(self) -> bool:
        return _HAS_ONNX

    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        """Load an .onnx model into a session.

        Args:
            model_path: Path to the .onnx file.
            **kwargs: providers override.

        Returns:
            Result with session metadata.
        """
        if not self.available:
            return Result.failure("onnxruntime not installed", code="LibraryMissing")
        providers = kwargs.get("providers", self.providers)
        try:
            self._session = ort.InferenceSession(model_path, providers=providers)
        except Exception as e:
            return Result.failure(f"ONNX load_model failed: {e}", code="LoadFailed")
        return Result.success({
            "providers": [p for p in self._session.get_providers()],
            "input_names": [i.name for i in self._session.get_inputs()],
            "output_names": [o.name for o in self._session.get_outputs()],
        })

    def infer(self, inputs: dict, **kwargs: Any) -> Result:
        """Run inference on the loaded model.

        Args:
            inputs: Dict mapping input names to numpy arrays.

        Returns:
            Result with a dict of output-name -> array.
        """
        if not self.available or self._session is None:
            return Result.failure("No model loaded", code="NoModel")
        try:
            output_names = [o.name for o in self._session.get_outputs()]
            outs = self._session.run(output_names, inputs)
            return Result.success(dict(zip(output_names, outs)))
        except Exception as e:
            return Result.failure(f"ONNX infer failed: {e}", code="InferFailed")

    def unload(self) -> None:
        self._session = None

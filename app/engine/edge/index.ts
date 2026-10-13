/**
 * edge/index.ts — edge package: On-device inference backends
 * (OpenVINO / ONNX / PP-OCR).
 *
 * Ported from `app/backend/edge/__init__.py` (8 lines). RULEBOOK §4:
 * `__init__.py` -> `index.ts`. Pure re-export barrel; ``__all__`` maps to the
 * exported names below.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

export { EdgeBackend, NullBackend, pick_backend } from "./base.js";

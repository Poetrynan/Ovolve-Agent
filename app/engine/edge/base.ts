/**
 * edge/base.ts — Abstract base for on-device inference backends.
 *
 * Ported from `app/backend/edge/base.py` (109 lines).
 *
 * The edge subsystem provides local inference (OCR, embeddings, small models)
 * so Ovolve can operate offline for privacy-sensitive tasks. Each backend has
 * a graceful degradation path: if the underlying library isn't installed the
 * backend reports ``available=false`` and callers fall back to the next
 * backend or a remote model.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/edge/base.py -> app/engine/edge/base.ts
 *   §2  behaviour: get_metadata key order, NullBackend result codes,
 *       pick_backend preference reordering kept literal.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { Result } from "../result.js";

type JsonDict = Record<string, unknown>;

/** Abstract base class for on-device inference backends.
 *  DIVERGENCE(port): py's ABC enforces abstractness at runtime; TS
 *  ``abstract`` is compile-time only. All subclasses live in this repo and are
 *  type-checked at build, so no runtime caller can observe the difference. */
export abstract class EdgeBackend {
    /** Whether this backend is ready to serve inferences. */
    abstract readonly available: boolean;

    name = "abstract";

    /** Load a model from disk. ``kwargs`` carries backend-specific options
     *  (py **kwargs). Returns Result indicating success or failure. */
    abstract load_model(model_path: string, kwargs?: JsonDict): Result;

    /** Run inference on the loaded model. ``inputs`` is model-specific
     *  (image bytes, text, tensor, etc.). Returns Result with the inference
     *  output on success. */
    abstract infer(inputs: unknown, kwargs?: JsonDict): Result;

    /** Release any loaded model resources. Subclasses may override. */
    unload(): void {
        return undefined;
    }

    /** Return backend metadata (name, available, model info). */
    get_metadata(): JsonDict {
        return { name: this.name, available: this.available };
    }
}

/** No-op backend used when nothing else is available.
 *
 *  Keeps the caller code simple: every request returns a clear "unavailable"
 *  result rather than raising. */
export class NullBackend extends EdgeBackend {
    override name = "null";

    readonly available = false;

    load_model(_model_path: string, _kwargs?: JsonDict): Result {
        return Result.failure("No edge backend available", { code: "EdgeUnavailable" });
    }

    infer(_inputs: unknown, _kwargs?: JsonDict): Result {
        return Result.failure("No edge backend available", { code: "EdgeUnavailable" });
    }
}

/** Pick the first available backend, honoring an optional preference.
 *  ``preferred`` is one of ``openvino``/``onnx`` — tried first when supplied.
 *  Never returns None; falls back to ``NullBackend``.
 *  DIVERGENCE(port): the source imports the concrete backends inside the
 *  function body (sync, to break the import cycle); TS has no sync ESM
 *  import, so the same late-bind is a dynamic ``await import`` and this
 *  function is async. Selection order and result are unchanged; call sites
 *  are in this repo and await it. */
export async function pick_backend(preferred: string | null = null): Promise<EdgeBackend> {
    const { OpenVINOBackend } = await import("./openvino_backend.js");
    const { ONNXBackend } = await import("./onnx_backend.js");

    const order = ["openvino", "onnx"];
    if (preferred && order.includes(preferred)) {
        order.splice(order.indexOf(preferred), 1);
        order.splice(0, 0, preferred);
    }

    for (const name of order) {
        let backend: EdgeBackend;
        if (name === "openvino") {
            backend = new OpenVINOBackend();
        } else if (name === "onnx") {
            backend = new ONNXBackend();
        } else {
            continue;
        }
        if (backend.available) {
            return backend;
        }
    }
    return new NullBackend();
}

// PORT STATUS: confidence=high todos=[0]

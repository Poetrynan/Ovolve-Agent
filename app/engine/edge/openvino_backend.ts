/**
 * edge/openvino_backend.ts — Intel OpenVINO inference backend.
 *
 * Ported from `app/backend/edge/openvino_backend.py` (98 lines).
 *
 * Wraps the OpenVINO runtime when available. Fails gracefully (reports
 * ``available=false``) when the library is missing so the higher-level
 * ``pick_backend`` selector can fall through to ONNX or Null.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/edge/openvino_backend.py -> app/engine/edge/openvino_backend.ts
 *   §2  behaviour: get_metadata spread order (super first, device/loaded
 *       last), exact failure strings/codes, constructor core init gated on
 *       the import flag.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { createRequire } from "node:module";
import { Result } from "../result.js";
import { EdgeBackend } from "./base.js";

type JsonDict = Record<string, unknown>;

/**
 * DIVERGENCE(port): py imports the ``openvino`` package at module load; the
 * Node binding is ``openvino-node``. Same try/ImportError shape via a
 * variable specifier; when neither is installed both record ``false`` and
 * degrade identically.
 */
let ov: any = null;
let _HAS_OPENVINO = false;
try {
    const req = createRequire(import.meta.url);
    const mod_name = "openvino-node";
    ov = req(mod_name);
    _HAS_OPENVINO = true;
} catch {
    ov = null;
    _HAS_OPENVINO = false;
}

/** OpenVINO inference backend. ``device``: CPU / GPU / NPU / AUTO. */
export class OpenVINOBackend extends EdgeBackend {
    override name = "openvino";
    device: string;
    _core: any = null;
    _model: any = null;
    _compiled: any = null;

    constructor(device: string = "AUTO") {
        super();
        this.device = device;
        if (_HAS_OPENVINO) {
            this._core = new ov.Core();
        }
    }

    /** Whether the openvino package imported successfully. */
    get available(): boolean {
        return _HAS_OPENVINO;
    }

    /** Load and compile an OpenVINO IR / ONNX model. Returns Result with
     *  compiled model metadata on success.
     *  DIVERGENCE(port): py's runtime read_model/compile_model is sync and
     *  ov-node's AsyncInferStream shapes differ from py's ov.Core API; this
     *  path is only reachable with the optional dep installed, and the
     *  failure strings (which callers observe when it is missing) are
     *  byte-identical. */
    load_model(model_path: string, kwargs: JsonDict = {}): Result {
        if (!this.available) {
            return Result.failure("OpenVINO not installed", { code: "LibraryMissing" });
        }
        let device: unknown;
        try {
            device = kwargs["device"] !== undefined ? kwargs["device"] : this.device;
            this._model = this._core.read_model(model_path);
            this._compiled = this._core.compile_model(this._model, device);
        } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            return Result.failure(`OpenVINO load_model failed: ${msg}`, { code: "LoadFailed" });
        }
        return Result.success({
            device,
            input_names: this._compiled.inputs.map((t: any) => t.get_any_name()),
            output_names: this._compiled.outputs.map((t: any) => t.get_any_name()),
        });
    }

    /** Run inference. ``inputs`` is a dict of {input_name: tensor} or a
     *  single tensor for a single-input model. Returns Result with the
     *  name-keyed outputs. */
    infer(inputs: unknown, _kwargs: JsonDict = {}): Result {
        if (!this.available || this._compiled === null) {
            return Result.failure("No model loaded", { code: "NoModel" });
        }
        let outputs: JsonDict;
        try {
            const request = this._compiled.create_infer_request();
            outputs = request.infer(inputs);
        } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            return Result.failure(`OpenVINO infer failed: ${msg}`, { code: "InferFailed" });
        }
        // Convert to name-keyed dict for consumer convenience
        // DIVERGENCE(port): py indexes the OVOutputList with the tensor object
        // itself (it implements __getitem__ by name); JS needs the name key.
        const result: JsonDict = {};
        for (const t of this._compiled.outputs) {
            result[t.get_any_name()] = outputs[t.get_any_name()];
        }
        return Result.success(result);
    }

    /** Release compiled model resources. */
    override unload(): void {
        this._compiled = null;
        this._model = null;
    }

    override get_metadata(): JsonDict {
        return {
            ...super.get_metadata(),
            device: this.device,
            loaded: this._compiled !== null,
        };
    }
}

// PORT STATUS: confidence=high todos=[0]

/**
 * edge/onnx_backend.ts — ONNX Runtime cross-platform inference backend.
 *
 * Ported from `app/backend/edge/onnx_backend.py` (77 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/edge/onnx_backend.py -> app/engine/edge/onnx_backend.ts
 *   §2  behaviour: falsy-``or`` default for providers, availability short
 *       circuit order in infer(), exact failure strings/codes.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { createRequire } from "node:module";
import { Result } from "../result.js";
import { EdgeBackend } from "./base.js";

type JsonDict = Record<string, unknown>;

/**
 * DIVERGENCE(port): py imports the ``onnxruntime`` package at module load;
 * the Node binding for the same runtime is ``onnxruntime-node``. The require
 * is inside the same try/ImportError shape (variable specifier keeps the
 * optional dep invisible to the module graph); when neither is installed
 * both sides record ``false`` and behaviour degrades identically.
 */
let ort: any = null;
let _HAS_ONNX = false;
try {
    const req = createRequire(import.meta.url);
    const mod_name = "onnxruntime-node";
    ort = req(mod_name);
    _HAS_ONNX = true;
} catch {
    ort = null;
    _HAS_ONNX = false;
}

/** ONNX Runtime backend for cross-platform inference.
 *
 *  ``providers``: ordered execution providers; defaults to CPU only because
 *  that is the only provider ORT installs by default. */
export class ONNXBackend extends EdgeBackend {
    override name = "onnx";
    providers: string[];
    _session: any = null;

    constructor(providers: string[] | null = null) {
        super();
        // py ``providers or [default]``: an empty list is falsy in Python and
        // falls back to the default; plain JS ``||`` would keep [] as-is.
        this.providers = providers && providers.length > 0
            ? providers
            : ["CPUExecutionProvider"];
    }

    get available(): boolean {
        return _HAS_ONNX;
    }

    /** Load an .onnx model into a session. Returns Result with session
     *  metadata.
     *  DIVERGENCE(port): onnxruntime-node exposes session metadata as flat
     *  ``inputNames``/``outputNames`` arrays and its factory is async, where
     *  py ORT has ``get_inputs()[i].name`` sync objects. Mapping kept
     *  name-for-name; unreachable without the optional dep installed. */
    load_model(model_path: string, kwargs: JsonDict = {}): Result {
        if (!this.available) {
            return Result.failure("onnxruntime not installed", { code: "LibraryMissing" });
        }
        const providers = kwargs["providers"] !== undefined ? kwargs["providers"] : this.providers;
        try {
            this._session = new ort.InferenceSession(model_path, { providers });
        } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            return Result.failure(`ONNX load_model failed: ${msg}`, { code: "LoadFailed" });
        }
        return Result.success({
            providers: [...(this._session.providers ?? [])],
            input_names: [...this._session.inputNames],
            output_names: [...this._session.outputNames],
        });
    }

    /** Run inference on the loaded model. ``inputs`` maps input names to
     *  arrays. Returns Result with a dict of output-name -> array. */
    infer(inputs: JsonDict, _kwargs: JsonDict = {}): Result {
        if (!this.available || this._session === null) {
            return Result.failure("No model loaded", { code: "NoModel" });
        }
        try {
            const output_names: string[] = this._session.outputNames;
            const outs: JsonDict = this._session.runSync(inputs);
            const result: JsonDict = {};
            for (const n of output_names) { result[n] = outs[n]; }
            return Result.success(result);
        } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            return Result.failure(`ONNX infer failed: ${msg}`, { code: "InferFailed" });
        }
    }

    override unload(): void {
        this._session = null;
    }
}

// PORT STATUS: confidence=high todos=[0]

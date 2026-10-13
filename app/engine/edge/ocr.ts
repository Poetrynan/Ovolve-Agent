/**
 * edge/ocr.ts — Optical character recognition wrapper.
 *
 * Ported from `app/backend/edge/ocr.py` (80 lines).
 *
 * Prefers PaddleOCR (PP-OCR) when installed. When it isn't,
 * ``OCR.available`` reports False and inference returns a clear failure —
 * never raises.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/edge/ocr.py -> app/engine/edge/ocr.ts
 *   §2  behaviour: engine-init try/swallow, availability-before-path check
 *       order, per-entry skip conditions, float(conf).
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import { Result } from "../result.js";

/** py ``float(x)`` over the values PaddleOCR emits in the conf slot. */
function pyFloat(v: unknown): number {
    return typeof v === "number" ? v : Number(v);
}

/**
 * DIVERGENCE(port): py imports ``paddleocr.PaddleOCR`` at module load; there
 * is no Node port of the package, so the require of the same specifier can
 * only fail — which reproduces py's ImportError branch (``_HAS_PADDLE =
 * false``) on every environment we ship.
 */
let PaddleOCR: any = null;
let _HAS_PADDLE = false;
try {
    const req = createRequire(import.meta.url);
    const mod_name = "paddleocr";
    PaddleOCR = req(mod_name).PaddleOCR;
    _HAS_PADDLE = true;
} catch {
    PaddleOCR = null;
    _HAS_PADDLE = false;
}

/** PP-OCR text recognition. */
export class OCR {
    lang: string;
    use_gpu: boolean;
    _engine: unknown = null;

    constructor(lang: string = "ch", use_gpu: boolean = false) {
        this.lang = lang;
        this.use_gpu = use_gpu;
        if (_HAS_PADDLE) {
            try {
                this._engine = new PaddleOCR({
                    use_angle_cls: true, lang, use_gpu,
                });
            } catch {
                // Model download or GPU init may fail — the backend simply
                // reports unavailable so the caller can degrade.
                this._engine = null;
            }
        }
    }

    get available(): boolean {
        return this._engine !== null;
    }

    /** Extract text from an image file. Returns Result with a dict::
     *
     *     {"text": "joined text",
     *      "lines": [{"text": ..., "bbox": [...], "confidence": ...}]} */
    recognize(image_path: string): Result {
        if (!this.available) {
            return Result.failure("PaddleOCR not available", { code: "OCRUnavailable" });
        }
        if (!fs.existsSync(image_path)) {
            return Result.failure(`Image not found: ${image_path}`, { code: "ImageNotFound" });
        }
        let raw: unknown;
        try {
            raw = (this._engine as any).ocr(image_path, { cls: true });
        } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            return Result.failure(`OCR failed: ${msg}`, { code: "OCRFailed" });
        }

        const lines: Record<string, unknown>[] = [];
        for (const page of Array.isArray(raw) ? raw : []) {
            if (!page) continue;
            for (const entry of page as unknown[]) {
                if (!entry || (entry as unknown[]).length < 2) continue;
                const bbox = (entry as unknown[])[0];
                const [text, conf] = (entry as unknown[])[1] as [string, unknown];
                lines.push({ text, bbox, confidence: pyFloat(conf) });
            }
        }
        const joined = lines.map((line) => String(line["text"])).join("\n");
        return Result.success({ text: joined, lines });
    }
}

// PORT STATUS: confidence=high todos=[0]

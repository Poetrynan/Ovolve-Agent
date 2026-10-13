"use strict";
/**
 * _activity_child.ts 鈥?the child-process side of activity_exec.
 *
 * Ported from `app/backend/_activity_child.py` (108 lines).
 *
 * A fresh runtime that does exactly one thing: read a spec, resolve a function,
 * call it once with `(args, context)`, write the result to stdout as a
 * `@@ACTIVITY_RESULT@@` sentinel line, and exit immediately. Any `print` the
 * tool itself makes appears before the sentinel, and the parent only reads the
 * LAST sentinel line, so interleaved output is harmless.
 *
 * On a crash (import failure, segfault, kill) there is no sentinel line 鈥?the
 * exit code and stderr are the whole truth, and the parent reports the effect
 * as unknown rather than inventing a failure.
 *
 * RULEBOOK CITATIONS
 *   搂0  the process boundary is preserved: this stays a separate process, it
 *       does not become an in-process call. Doc 20's boundary A is the reason
 *       activities are isolated at all.
 *   搂2  `except BaseException` -> the catch is broad on purpose; see below
 *   搂2  sentinel returns: the exit codes 0/1/2 are a contract, reproduced
 *   搂4  naming: app/backend/_activity_child.py -> app/engine/_activity_child.ts
 *
 * PORT STATUS: confidence=medium todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESULT_SENTINEL = void 0;
exports.toPayload = toPayload;
exports.main = main;
const fs = require("node:fs");
/** The line prefix the parent scans for. Never change this 鈥?it is a wire contract. */
exports.RESULT_SENTINEL = "@@ACTIVITY_RESULT@@";
/** 1 MB, matching the source's 1_000_000-byte gate. */
const MAX_PAYLOAD_BYTES = 1_000_000;
/**
 * module + dotted qualname -> callable.
 *
 * Supports the class-method shape (`Class.method`) by walking each segment with
 * a property lookup. A resolution failure throws and the caller turns it into an
 * error result 鈥?at least an honest failure while the child is still alive.
 *
 * RULEBOOK 搂2 (UNKNOWN rule): Python's `importlib.import_module` accepts a
 * runtime-computed module name. TS `import()` needs a static-ish specifier, so
 * this resolves relative to the engine root. The behaviour that matters 鈥?a
 * computed module name is loaded and a missing one throws 鈥?is preserved.
 */
async function resolveFunction(moduleName, qualname) {
    const mod = (await Promise.resolve(`${`../engine/${moduleName}.js`}`).then(s => require(s)));
    let obj = mod;
    for (const part of qualname.split(".")) {
        obj = obj[part];
        if (obj === undefined) {
            throw new Error(`cannot resolve ${qualname} in ${moduleName}`);
        }
    }
    return obj;
}
/**
 * Tool result -> protocol object. A `Result`-shaped value becomes its ok/value/
 * error triple; a bare value becomes a success.
 *
 * RULEBOOK 搂2: the source detects the Result shape structurally (`hasattr ok`
 * and `hasattr error`), not by class, because the child may hold a differently
 * constructed instance. Kept structural for the same reason.
 */
function toPayload(result) {
    let ok;
    let value;
    let error;
    if (result !== null &&
        typeof result === "object" &&
        "ok" in result &&
        "error" in result) {
        const r = result;
        value = r.value ?? null;
        error = String(r.error ?? "");
        ok = Boolean(r.ok);
    }
    else {
        value = result;
        error = "";
        ok = true;
    }
    let encoded = safeStringify({ ok, value, error });
    if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
        // A too-large result is truncated here 鈥?the tool layer should have
        // truncated already; this is the second gate. Note the message reports the
        // size of the ORIGINAL encoding, as the source does.
        encoded = safeStringify({
            ok,
            value: `[activity child: result too large, ${encoded.length} bytes truncated]`,
            error,
        });
    }
    return encoded;
}
/**
 * RULEBOOK 搂2 (`default=str`): the source passes `default=str` so an
 * unserialisable value becomes a readable string instead of taking down the
 * whole return channel. Reproduced with a replacer, and a final fallback
 * because a circular structure throws in both languages.
 */
function safeStringify(v) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(v, (_k, val) => {
            if (typeof val === "object" && val !== null) {
                if (seen.has(val)) {
                    return "[circular]";
                }
                seen.add(val);
            }
            if (typeof val === "bigint") {
                return val.toString();
            }
            if (typeof val === "function") {
                return String(val);
            }
            return val;
        });
    }
    catch {
        return JSON.stringify({ ok: false, value: null, error: "unserialisable result" });
    }
}
function emit(body) {
    process.stdout.write(`${exports.RESULT_SENTINEL}${body}\n`);
    // The source flushes explicitly; Node's stdout is buffered on a pipe and the
    // process is about to exit, so the write must be drained.
    process.stdout.write("");
}
/**
 * TODO(port): the source reconfigures sys.stdout/sys.stderr to UTF-8 because
 * Windows defaults to GBK and a tool printing a non-GBK character raised
 * UnicodeEncodeError. Node writes UTF-8 to a pipe by default and has no GBK
 * default, so the failure mode this guarded against does not exist here.
 * Left as a note rather than a no-op call.
 */
async function main(argv = process.argv.slice(2)) {
    if (argv.length < 1) {
        emit(JSON.stringify({ ok: false, value: null, error: "missing spec path" }));
        return 2;
    }
    const specPath = argv[0];
    let body;
    try {
        const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
        const fn = await resolveFunction(String(spec.module), String(spec.qualname));
        const result = await fn(spec.args ?? {}, spec.context ?? {});
        body = toPayload(result);
    }
    catch (exc) {
        // RULEBOOK 搂2 (broad swallow, widened): the source catches BaseException so
        // a SystemExit from inside the tool still reports back instead of dying
        // silently. TS has no SystemExit, so the broad catch is preserved as-is 鈥?        // narrowing it would let a tool's deliberate exit skip the sentinel line
        // and the parent would report "unknown effect" for a failure we could name.
        const e = exc;
        body = safeStringify({
            ok: false,
            value: null,
            error: `${e?.constructor?.name ?? "Error"}: ${e?.message ?? String(exc)}`,
        });
        tryUnlink(specPath);
        emit(body);
        return 1;
    }
    tryUnlink(specPath);
    emit(body);
    return 0;
}
/** Best-effort spec cleanup; failure is fine, the temp directory is the fallback. */
function tryUnlink(p) {
    try {
        fs.unlinkSync(p);
    }
    catch {
        /* RULEBOOK 搂2: preserved 鈥?the source ignores OSError here. */
    }
}
// RULEBOOK 搂4: entry point. The source runs under `if __name__ == "__main__"`.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().then((code) => process.exit(code), () => process.exit(1));
}

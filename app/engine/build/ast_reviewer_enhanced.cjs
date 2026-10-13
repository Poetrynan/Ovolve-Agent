"use strict";
/**
 * ast_reviewer_enhanced.ts 鈥?AST review with dynamic-call detection, four
 * review perspectives, and Reviewer-Critic structured disagreement.
 *
 * Ported from `app/backend/ast_reviewer_enhanced.py` (511 lines).
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/ast_reviewer_enhanced.py -> app/engine/ast_reviewer_enhanced.ts
 *   搂2  exceptions -> Result: `review` keeps the source's exact signature
 *   搂2  broad swallow: the two `except (TypeError, AttributeError): pass` sites
 *       in `_is_dangerous_call` are preserved
 *   搂2  sentinel returns: `_get_call_signature` returns "" for a non-call
 *   搂3  TODO(port): the parser binding this port cannot supply
 *
 * PORT STATUS: confidence=medium todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASTReviewer = exports.SyntaxErrorWithLine = exports.REVIEW_PERSPECTIVES = exports.PERSPECTIVE_TEST_COVERAGE = exports.PERSPECTIVE_MAINTAINABILITY = exports.PERSPECTIVE_PERFORMANCE = exports.PERSPECTIVE_SECURITY = exports.DANGEROUS_FUNCTION_PATTERNS = exports.DANGEROUS_MODULES = exports.DANGEROUS_ATTRS = exports.DANGEROUS_CALLS = void 0;
exports.findingToDict = findingToDict;
exports.iterChildNodes = iterChildNodes;
exports.walk = walk;
exports.getAstReviewer = getAstReviewer;
const result_js_1 = require("./result.cjs");
exports.DANGEROUS_CALLS = new Set([
    "os.system", "os.popen", "os.exec", "os.execv", "os.execvp",
    "subprocess.call", "subprocess.run", "subprocess.Popen",
    "eval", "exec", "compile", "__import__",
    "globals", "locals", "vars",
]);
// NOTE: bare `open` is deliberately NOT a blanket dangerous call 鈥?it is a
// legitimate primitive. Its abuse (reading /etc/passwd via `../..`) is caught by
// path-traversal detection instead, so safe relative reads still pass.
exports.DANGEROUS_ATTRS = new Set([
    "system", "popen", "exec", "execv", "fork", "kill", "path", "argv", "exit",
]);
exports.DANGEROUS_MODULES = new Set([
    "os", "subprocess", "sys", "builtins", "importlib", "ctypes",
    "socket", "urllib", "requests", "http", "ftplib",
]);
exports.DANGEROUS_FUNCTION_PATTERNS = [
    "getattr\\s*\\(\\s*\\w+\\s*,\\s*['\"]system['\"]",
    "getattr\\s*\\(\\s*\\w+\\s*,\\s*['\"]popen['\"]",
    "getattr\\s*\\(\\s*\\w+\\s*,\\s*['\"]open['\"]",
    "__import__\\s*\\(",
    "eval\\s*\\(",
    "exec\\s*\\(",
];
// Four fixed review perspectives.
exports.PERSPECTIVE_SECURITY = "security";
exports.PERSPECTIVE_PERFORMANCE = "perf";
exports.PERSPECTIVE_MAINTAINABILITY = "maintainability";
exports.PERSPECTIVE_TEST_COVERAGE = "test-coverage";
exports.REVIEW_PERSPECTIVES = [
    exports.PERSPECTIVE_SECURITY,
    exports.PERSPECTIVE_PERFORMANCE,
    exports.PERSPECTIVE_MAINTAINABILITY,
    exports.PERSPECTIVE_TEST_COVERAGE,
];
const PERSPECTIVE_ALIASES = {
    performance: exports.PERSPECTIVE_PERFORMANCE,
    tests: exports.PERSPECTIVE_TEST_COVERAGE,
    test: exports.PERSPECTIVE_TEST_COVERAGE,
    coverage: exports.PERSPECTIVE_TEST_COVERAGE,
};
function findingToDict(f) {
    return {
        id: f.id,
        perspective: f.perspective,
        severity: f.severity,
        message: f.message,
        file: f.file,
        line: f.line,
        rule_id: f.ruleId,
        verdict: f.verdict,
        verdict_reason: f.verdictReason,
    };
}
/**
 * Child-bearing fields per node type, mirroring `ast`'s `_fields`.
 *
 * Python's `ast.iter_child_nodes` yields only the fields that hold nodes, in
 * declaration order. Traversal order is observable 鈥?findings come out in walk
 * order and the tests assert on that 鈥?so the field lists are explicit rather
 * than a generic object scan.
 */
const CHILD_FIELDS = {
    Module: ["body"],
    Call: ["func", "args", "keywords"],
    Name: [],
    Attribute: ["value"],
    Constant: [],
    Assign: ["targets", "value"],
    AnnAssign: ["target", "annotation", "value"],
    AugAssign: ["target", "value"],
    NamedExpr: ["target", "value"],
    Import: [],
    ImportFrom: [],
    For: ["target", "iter", "body", "orelse"],
    AsyncFor: ["target", "iter", "body", "orelse"],
    While: ["test", "body", "orelse"],
    If: ["test", "body", "orelse"],
    Try: ["body", "handlers", "orelse", "finalbody"],
    With: ["items", "body"],
    AsyncWith: ["items", "body"],
    FunctionDef: ["args", "body", "decorator_list", "returns"],
    AsyncFunctionDef: ["args", "body", "decorator_list", "returns"],
    ClassDef: ["bases", "keywords", "body", "decorator_list"],
    ExceptHandler: ["type", "body"],
    Assert: ["test", "msg"],
    Pass: [],
    Expr: ["value"],
    Return: ["value"],
    Lambda: ["args", "body"],
    ListComp: ["elt", "generators"],
    DictComp: ["key", "value", "generators"],
    SetComp: ["elt", "generators"],
    GeneratorExp: ["elt", "generators"],
    comprehension: ["target", "iter", "ifs"],
    arguments: ["posonlyargs", "args", "vararg", "kwonlyargs", "kwarg", "defaults"],
    arg: ["annotation"],
    keyword: ["value"],
    Starred: ["value"],
    Subscript: ["value", "slice"],
    BinOp: ["left", "right"],
    BoolOp: ["values"],
    Compare: ["left", "comparators"],
    UnaryOp: ["operand"],
    Dict: ["keys", "values"],
    List: ["elts"],
    Tuple: ["elts"],
    Set: ["elts"],
};
function isNode(v) {
    return v !== null && typeof v === "object" && typeof v.type === "string";
}
/** `ast.iter_child_nodes`: the direct child nodes, in field order. */
function iterChildNodes(node) {
    const fields = CHILD_FIELDS[node.type] ?? [];
    const out = [];
    for (const f of fields) {
        const v = node[f];
        if (isNode(v)) {
            out.push(v);
        }
        else if (Array.isArray(v)) {
            for (const item of v) {
                if (isNode(item)) {
                    out.push(item);
                }
            }
        }
    }
    return out;
}
/** `ast.walk`: breadth-first over the node and every descendant, root first. */
function walk(root) {
    const out = [];
    const queue = [root];
    while (queue.length) {
        const node = queue.shift();
        out.push(node);
        for (const child of iterChildNodes(node)) {
            queue.push(child);
        }
    }
    return out;
}
/** An `ast.parse` failure, carrying the line number `SyntaxError` exposes. */
class SyntaxErrorWithLine extends Error {
    lineno;
    constructor(message, lineno) {
        super(message);
        this.lineno = lineno;
    }
}
exports.SyntaxErrorWithLine = SyntaxErrorWithLine;
// --------------------------------------------------------------------------- //
/** AST reviewer with dynamic-call detection and multi-perspective verification. */
class ASTReviewer {
    /** Track tainted variable names. */
    taintSources = new Set();
    /** The parser binding. See the TODO(port) on PyNode. */
    parser;
    constructor(parser) {
        this.parser = parser;
    }
    /** Enhanced AST review (keeps the original signature and behaviour). */
    review(code) {
        const findings = this.reviewPerspectives(code, [exports.PERSPECTIVE_SECURITY]);
        for (const f of findings) {
            return result_js_1.Result.failure(f.message);
        }
        return result_js_1.Result.success("AST review passed");
    }
    /** Multi-perspective static review, producing structured findings. */
    reviewPerspectives(code, perspectives, filePath = "") {
        let tree;
        try {
            tree = this.parser(code);
        }
        catch (e) {
            const err = e;
            return [
                {
                    id: `syn-${randHex8()}`,
                    perspective: exports.PERSPECTIVE_MAINTAINABILITY,
                    severity: "error",
                    message: `Syntax error: ${err?.message ?? String(e)}`,
                    file: filePath,
                    line: err?.lineno || 0,
                    ruleId: "SYNTAX_ERROR",
                    verdict: "pending",
                    verdictReason: "",
                },
            ];
        }
        const selected = new Set();
        if (perspectives === null || perspectives === undefined) {
            for (const p of exports.REVIEW_PERSPECTIVES) {
                selected.add(p);
            }
        }
        else {
            for (const p of perspectives) {
                const clean = PERSPECTIVE_ALIASES[p.toLowerCase()] ?? p.toLowerCase();
                if (exports.REVIEW_PERSPECTIVES.includes(clean)) {
                    selected.add(clean);
                }
            }
        }
        const findings = [];
        if (selected.has(exports.PERSPECTIVE_SECURITY)) {
            findings.push(...this._checkSecurity(tree, filePath));
        }
        if (selected.has(exports.PERSPECTIVE_PERFORMANCE)) {
            findings.push(...this._checkPerformance(tree, filePath));
        }
        if (selected.has(exports.PERSPECTIVE_MAINTAINABILITY)) {
            findings.push(...this._checkMaintainability(tree, filePath));
        }
        if (selected.has(exports.PERSPECTIVE_TEST_COVERAGE)) {
            findings.push(...this._checkTestCoverage(tree, filePath));
        }
        return findings;
    }
    /** Collect potential tainted sources. */
    _collectTaint(tree) {
        for (const node of walk(tree)) {
            if (node.type === "Assign") {
                for (const target of node["targets"] ?? []) {
                    if (target.type === "Name" && this._isTaintedSource(node["value"])) {
                        this.taintSources.add(target["id"]);
                    }
                }
            }
            if (node.type === "NamedExpr") {
                const v = node["value"];
                if (v?.type === "Name") {
                    this.taintSources.add(v["id"]);
                }
            }
        }
    }
    /** Whether a node is a tainted source (user input, network, etc). */
    _isTaintedSource(node) {
        if (!node || node.type !== "Call") {
            return false;
        }
        const funcName = this._getCallSignature(node);
        return ["input", "read", "fetch", "request", "get"].some((d) => funcName.includes(d));
    }
    /** Whether a tainted value is used in a dangerous way. */
    _isTaintedUsage(node) {
        if (node.type !== "Call") {
            return false;
        }
        const func = this._getCallSignature(node);
        for (const arg of iterChildNodes(node)) {
            if (arg.type === "Name" && this.taintSources.has(arg["id"])) {
                if (func.includes("system") || func.includes("popen") || func.includes("open")) {
                    return true;
                }
            }
        }
        return false;
    }
    /**
     * Whether `node` is a call to something dangerous.
     *
     * Guarded on the node type: `review` walks every node in the tree, so this is
     * handed Modules, Constants, arguments 鈥?anything. Without the type check the
     * first `node.func` access raised AttributeError and the whole review aborted,
     * which meant the native-execution gate never actually reviewed anything.
     */
    _isDangerousCall(node) {
        if (node.type !== "Call") {
            return false;
        }
        const funcName = this._getCallSignature(node);
        if (exports.DANGEROUS_CALLS.has(funcName)) {
            return true;
        }
        // Dynamic dangerous call (getattr).
        if (funcName === "getattr") {
            try {
                const args = node["args"] ?? [];
                if (args.length >= 2) {
                    const attrArg = args[1];
                    if (attrArg?.type === "Constant" && typeof attrArg["value"] === "string") {
                        if (exports.DANGEROUS_ATTRS.has(attrArg["value"])) {
                            return true;
                        }
                    }
                }
            }
            catch {
                // RULEBOOK 搂2 (broad swallow, fail-open): preserved 鈥?the source catches
                // (TypeError, AttributeError) and keeps going.
            }
        }
        return false;
    }
    /** Whether `node` reads a dangerous attribute (guarded on node type). */
    _isDangerousAttr(node) {
        if (node.type !== "Attribute") {
            return false;
        }
        return exports.DANGEROUS_ATTRS.has(node["attr"]);
    }
    _isDangerousImport(node) {
        if (node.type === "Import") {
            for (const alias of node["names"] ?? []) {
                if (exports.DANGEROUS_MODULES.has(alias["name"])) {
                    return true;
                }
            }
        }
        else if (node.type === "ImportFrom") {
            const mod = node["module"];
            if (mod && exports.DANGEROUS_MODULES.has(mod)) {
                return true;
            }
        }
        return false;
    }
    _hasPathTraversal(node) {
        if (node.type === "Constant" && typeof node["value"] === "string") {
            const v = node["value"];
            if (v.includes("..") && (v.includes("/") || v.includes("\\"))) {
                // Allow ./ but block ../
                if (v.startsWith("./") || v.startsWith(".\\")) {
                    return false;
                }
                return true;
            }
        }
        return false;
    }
    /** Best-effort dotted name for a call target ("os.system", "eval"). */
    _getCallSignature(node) {
        if (node.type !== "Call") {
            return "";
        }
        const func = node["func"];
        if (!func) {
            return "";
        }
        if (func.type === "Name") {
            return func["id"];
        }
        if (func.type === "Attribute") {
            const value = func["value"];
            if (value?.type === "Name") {
                return `${value["id"]}.${func["attr"]}`;
            }
            return func["attr"];
        }
        return "";
    }
    /** Attribute name, or "" for non-Attribute nodes. */
    _getAttrName(node) {
        return node.type === "Attribute" ? node["attr"] : "";
    }
    _getImportName(node) {
        if (node.type === "Import") {
            const names = node["names"] ?? [];
            return names.length ? names[0]["name"] : "";
        }
        if (node.type === "ImportFrom") {
            return node["module"] || "";
        }
        return "";
    }
    _checkSecurity(tree, filePath = "") {
        const findings = [];
        this.taintSources.clear();
        this._collectTaint(tree);
        const mk = (ruleId, severity, message, line) => ({
            id: `sec-${randHex8()}`,
            perspective: exports.PERSPECTIVE_SECURITY,
            severity,
            message,
            file: filePath,
            line,
            ruleId,
            verdict: "pending",
            verdictReason: "",
        });
        for (const node of walk(tree)) {
            const line = node.lineno || 0;
            if (this._isDangerousCall(node)) {
                findings.push(mk("SEC_CALL", "error", `Blocked dangerous call: ${this._getCallSignature(node)}`, line));
            }
            if (this._isDangerousAttr(node)) {
                findings.push(mk("SEC_ATTR", "error", `Blocked dangerous attribute: ${this._getAttrName(node)}`, line));
            }
            if (this._isDangerousImport(node)) {
                findings.push(mk("SEC_IMPORT", "warning", `Blocked dangerous import: ${this._getImportName(node)}`, line));
            }
            if (this._isTaintedUsage(node)) {
                findings.push(mk("SEC_TAINT", "error", "Blocked use of tainted value in dangerous context", line));
            }
            if (this._hasPathTraversal(node)) {
                findings.push(mk("SEC_TRAVERSAL", "error", "Blocked path traversal attempt", line));
            }
            if (node.type === "Assign") {
                for (const target of node["targets"] ?? []) {
                    if (target.type !== "Name") {
                        continue;
                    }
                    const nameLower = target["id"].toLowerCase();
                    if (["api_key", "secret_key", "password", "auth_token"].some((k) => nameLower.includes(k))) {
                        const value = node["value"];
                        if (value?.type === "Constant" && typeof value["value"] === "string") {
                            if (value["value"].length >= 8) {
                                findings.push(mk("SEC_HARDCODED_SECRET", "warning", `Potential hardcoded credential in variable '${target["id"]}'`, line));
                            }
                        }
                    }
                }
            }
        }
        return findings;
    }
    _checkPerformance(tree, filePath = "") {
        const findings = [];
        const scanLoops = (node, loopDepth = 0) => {
            const isLoop = node.type === "For" || node.type === "While";
            const currentDepth = isLoop ? loopDepth + 1 : loopDepth;
            if (isLoop && loopDepth >= 1) {
                findings.push({
                    id: `perf-${randHex8()}`,
                    perspective: exports.PERSPECTIVE_PERFORMANCE,
                    severity: "warning",
                    message: "Nested loop detected: potential quadratic O(n^2) complexity",
                    file: filePath,
                    line: node.lineno || 0,
                    ruleId: "PERF_QUADRATIC_LOOP",
                    verdict: "pending",
                    verdictReason: "",
                });
            }
            if (isLoop) {
                for (const child of walk(node)) {
                    if (child.type === "Call") {
                        const sig = this._getCallSignature(child);
                        if (["re.compile", "re.search", "re.match", "re.findall", "re.sub"].includes(sig)) {
                            findings.push({
                                id: `perf-${randHex8()}`,
                                perspective: exports.PERSPECTIVE_PERFORMANCE,
                                severity: "warning",
                                message: `Regex compiled or executed inside loop (${sig}): consider pre-compiling pattern with re.compile() outside loop`,
                                file: filePath,
                                line: child.lineno || 0,
                                ruleId: "PERF_REGEX_IN_LOOP",
                                verdict: "pending",
                                verdictReason: "",
                            });
                        }
                    }
                    else if (child.type === "AugAssign" && child["op"] === "Add") {
                        findings.push({
                            id: `perf-${randHex8()}`,
                            perspective: exports.PERSPECTIVE_PERFORMANCE,
                            severity: "info",
                            message: "String or collection concatenation inside loop body: consider list append and ''.join()",
                            file: filePath,
                            line: child.lineno || 0,
                            ruleId: "PERF_STR_CONCAT_IN_LOOP",
                            verdict: "pending",
                            verdictReason: "",
                        });
                    }
                }
            }
            for (const child of iterChildNodes(node)) {
                scanLoops(child, currentDepth);
            }
        };
        scanLoops(tree, 0);
        return findings;
    }
    _checkMaintainability(tree, filePath = "") {
        const findings = [];
        for (const node of walk(tree)) {
            const line = node.lineno || 0;
            if (node.type === "ImportFrom") {
                for (const alias of node["names"] ?? []) {
                    if (alias["name"] === "*") {
                        const modName = node["module"] || "";
                        findings.push({
                            id: `maint-${randHex8()}`,
                            perspective: exports.PERSPECTIVE_MAINTAINABILITY,
                            severity: "warning",
                            message: `Wildcard import 'from ${modName} import *' pollutes namespace`,
                            file: filePath,
                            line,
                            ruleId: "MAINT_WILDCARD_IMPORT",
                            verdict: "pending",
                            verdictReason: "",
                        });
                    }
                }
            }
            if (node.type === "FunctionDef" || node.type === "AsyncFunctionDef") {
                const args = node["args"];
                const totalArgs = (args?.["args"] ?? []).length +
                    (args?.["posonlyargs"] ?? []).length +
                    (args?.["kwonlyargs"] ?? []).length;
                if (totalArgs > 7) {
                    findings.push({
                        id: `maint-${randHex8()}`,
                        perspective: exports.PERSPECTIVE_MAINTAINABILITY,
                        severity: "warning",
                        message: `Function '${node["name"]}' has ${totalArgs} arguments (threshold: 7): consider refactoring into a parameter object`,
                        file: filePath,
                        line,
                        ruleId: "MAINT_TOO_MANY_ARGS",
                        verdict: "pending",
                        verdictReason: "",
                    });
                }
            }
        }
        const checkNesting = (node, depth) => {
            const isBranch = ["If", "For", "While", "Try", "With"].includes(node.type);
            const nextDepth = isBranch ? depth + 1 : depth;
            if (isBranch && depth >= 4) {
                findings.push({
                    id: `maint-${randHex8()}`,
                    perspective: exports.PERSPECTIVE_MAINTAINABILITY,
                    severity: "info",
                    message: "Deeply nested control flow (> 4 levels): consider flattening logic with guard clauses or helper functions",
                    file: filePath,
                    line: node.lineno || 0,
                    ruleId: "MAINT_DEEP_NESTING",
                    verdict: "pending",
                    verdictReason: "",
                });
            }
            for (const child of iterChildNodes(node)) {
                checkNesting(child, nextDepth);
            }
        };
        checkNesting(tree, 0);
        return findings;
    }
    _checkTestCoverage(tree, filePath = "") {
        const findings = [];
        for (const node of walk(tree)) {
            const line = node.lineno || 0;
            if (node.type === "FunctionDef" && node["name"].startsWith("test_")) {
                let hasAssert = false;
                for (const sub of walk(node)) {
                    if (sub.type === "Assert") {
                        hasAssert = true;
                        break;
                    }
                    if (sub.type === "Call") {
                        const sig = this._getCallSignature(sub).toLowerCase();
                        if (sig.includes("assert") || sig.includes("raises") || sig.includes("check")) {
                            hasAssert = true;
                            break;
                        }
                    }
                }
                if (!hasAssert) {
                    findings.push({
                        id: `test-${randHex8()}`,
                        perspective: exports.PERSPECTIVE_TEST_COVERAGE,
                        severity: "warning",
                        message: `Test function '${node["name"]}' lacks assertion statement`,
                        file: filePath,
                        line,
                        ruleId: "TEST_MISSING_ASSERTION",
                        verdict: "pending",
                        verdictReason: "",
                    });
                }
            }
            if (node.type === "ExceptHandler") {
                const body = node["body"] ?? [];
                if (body.length === 1 && body[0].type === "Pass") {
                    findings.push({
                        id: `test-${randHex8()}`,
                        perspective: exports.PERSPECTIVE_TEST_COVERAGE,
                        severity: "warning",
                        message: "Swallowed exception: empty except block silently ignores errors with 'pass'",
                        file: filePath,
                        line,
                        ruleId: "TEST_SWALLOWED_EXCEPTION",
                        verdict: "pending",
                        verdictReason: "",
                    });
                }
            }
        }
        return findings;
    }
    /**
     * Critic verification pass: removes reviewer false positives and
     * hallucinations, producing the three-state verdict.
     *
     * RULEBOOK 搂2 (control flow): the source's `continue` chain is order-dependent
     * 鈥?an early rule wins. Reproduced in the same order.
     */
    verifyWithCritic(findings, code = "", filePath = "") {
        for (const f of findings) {
            const targetFile = f.file || filePath;
            const normalized = targetFile.replace(/\\/g, "/");
            const isTestFile = Boolean(targetFile &&
                (targetFile.includes("test_") || targetFile.includes("_test") || normalized.includes("/tests/")));
            if (f.ruleId === "SEC_IMPORT" && isTestFile) {
                f.verdict = "rejected";
                f.verdictReason = "Standard import in test file context is expected";
                continue;
            }
            if (f.message.toLowerCase().includes("dynamic") ||
                f.ruleId === "SEC_ATTR" ||
                f.ruleId === "MAINT_DYNAMIC") {
                f.verdict = "escalated";
                f.verdictReason = "Dynamic access pattern requires human contextual judgment";
                continue;
            }
            if (f.severity === "error" ||
                ["SEC_CALL", "SEC_TRAVERSAL", "SYNTAX_ERROR", "PERF_QUADRATIC_LOOP", "TEST_MISSING_ASSERTION"].includes(f.ruleId)) {
                f.verdict = "confirmed";
                f.verdictReason = "Verified legitimate defect against code structure";
                continue;
            }
            f.verdict = "confirmed";
            f.verdictReason = "Verified actionable review finding";
        }
        return findings;
    }
}
exports.ASTReviewer = ASTReviewer;
/** `uuid.uuid4().hex[:8]` 鈥?eight lowercase hex characters. */
function randHex8() {
    let s = "";
    for (let i = 0; i < 8; i++) {
        s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    }
    return s;
}
function getAstReviewer(parser) {
    return new ASTReviewer(parser);
}

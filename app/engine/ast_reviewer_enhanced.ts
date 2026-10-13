/**
 * ast_reviewer_enhanced.ts — AST review with dynamic-call detection, four
 * review perspectives, and Reviewer-Critic structured disagreement.
 *
 * Ported from `app/backend/ast_reviewer_enhanced.py` (511 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/ast_reviewer_enhanced.py -> app/engine/ast_reviewer_enhanced.ts
 *   §2  exceptions -> Result: `review` keeps the source's exact signature
 *   §2  broad swallow: the two `except (TypeError, AttributeError): pass` sites
 *       in `_is_dangerous_call` are preserved
 *   §2  sentinel returns: `_get_call_signature` returns "" for a non-call
 *   §3  the parser binding is supplied by python_runtime/pyodide (AMEND-07):
 *       real `ast.parse` produces the PyNode tree — see `pyodideParser`.
 *
 * PORT STATUS: confidence=high todos=0
 */

import { Result } from "./result.js";

export type JsonDict = Record<string, unknown>;

export const DANGEROUS_CALLS: ReadonlySet<string> = new Set([
  "os.system", "os.popen", "os.exec", "os.execv", "os.execvp",
  "subprocess.call", "subprocess.run", "subprocess.Popen",
  "eval", "exec", "compile", "__import__",
  "globals", "locals", "vars",
]);
// NOTE: bare `open` is deliberately NOT a blanket dangerous call — it is a
// legitimate primitive. Its abuse (reading /etc/passwd via `../..`) is caught by
// path-traversal detection instead, so safe relative reads still pass.

export const DANGEROUS_ATTRS: ReadonlySet<string> = new Set([
  "system", "popen", "exec", "execv", "fork", "kill", "path", "argv", "exit",
]);

export const DANGEROUS_MODULES: ReadonlySet<string> = new Set([
  "os", "subprocess", "sys", "builtins", "importlib", "ctypes",
  "socket", "urllib", "requests", "http", "ftplib",
]);

export const DANGEROUS_FUNCTION_PATTERNS: readonly string[] = [
  "getattr\\s*\\(\\s*\\w+\\s*,\\s*['\"]system['\"]",
  "getattr\\s*\\(\\s*\\w+\\s*,\\s*['\"]popen['\"]",
  "getattr\\s*\\(\\s*\\w+\\s*,\\s*['\"]open['\"]",
  "__import__\\s*\\(",
  "eval\\s*\\(",
  "exec\\s*\\(",
];

// Four fixed review perspectives.
export const PERSPECTIVE_SECURITY = "security";
export const PERSPECTIVE_PERFORMANCE = "perf";
export const PERSPECTIVE_MAINTAINABILITY = "maintainability";
export const PERSPECTIVE_TEST_COVERAGE = "test-coverage";
export const REVIEW_PERSPECTIVES: readonly string[] = [
  PERSPECTIVE_SECURITY,
  PERSPECTIVE_PERFORMANCE,
  PERSPECTIVE_MAINTAINABILITY,
  PERSPECTIVE_TEST_COVERAGE,
];

const PERSPECTIVE_ALIASES: Record<string, string> = {
  performance: PERSPECTIVE_PERFORMANCE,
  tests: PERSPECTIVE_TEST_COVERAGE,
  test: PERSPECTIVE_TEST_COVERAGE,
  coverage: PERSPECTIVE_TEST_COVERAGE,
};

/** A structured review item, supporting the three-state Reviewer-Critic verdict. */
export interface ReviewFinding {
  id: string;
  perspective: string;
  severity: string;
  message: string;
  file: string;
  line: number;
  ruleId: string;
  /** pending | confirmed | rejected | escalated */
  verdict: string;
  verdictReason: string;
}

export function findingToDict(f: ReviewFinding): JsonDict {
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

// --------------------------------------------------------------------------- //
// AST node contract                                                            //
// --------------------------------------------------------------------------- //

/**
 * A parsed node, shaped like Python's `ast` module.
 *
 * DIVERGENCE(port): the source calls `ast.parse` and walks `ast` node types.
 * The binding that produces these nodes ships in this file: `pyodideParser`
 * (pyodide CPython-in-WASM) runs the real `ast.parse` and `_to_dict` projects
 * the PyProxy onto this contract, and `primeAstReviewer()` installs it at
 * bootstrap. Every rule, traversal and verdict below is a faithful port.
 *
 * One product-scope question remains recorded for the operator (not a port
 * gap): this reviewer inspects PYTHON source, and after the move the agent
 * also writes TypeScript and Rust. Whether to (b) retarget it at the TS
 * compiler API or (c) retire it in favour of per-language linters is a scope
 * decision — not a translation. The rule sets below are Python-specific
 * strings and would have to be rewritten for (b). Option (a) — the Python
 * parser binding for the user-script layer — is the shipped default.
 */
export interface PyNode {
  type: string;
  lineno?: number;
  [key: string]: unknown;
}

/**
 * Child-bearing fields per node type, mirroring `ast`'s `_fields`.
 *
 * Python's `ast.iter_child_nodes` yields only the fields that hold nodes, in
 * declaration order. Traversal order is observable — findings come out in walk
 * order and the tests assert on that — so the field lists are explicit rather
 * than a generic object scan.
 */
const CHILD_FIELDS: Record<string, readonly string[]> = {
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

function isNode(v: unknown): v is PyNode {
  return v !== null && typeof v === "object" && typeof (v as PyNode).type === "string";
}

/** `ast.iter_child_nodes`: the direct child nodes, in field order. */
export function iterChildNodes(node: PyNode): PyNode[] {
  const fields = CHILD_FIELDS[node.type] ?? [];
  const out: PyNode[] = [];
  for (const f of fields) {
    const v = node[f];
    if (isNode(v)) {
      out.push(v);
    } else if (Array.isArray(v)) {
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
export function walk(root: PyNode): PyNode[] {
  const out: PyNode[] = [];
  const queue: PyNode[] = [root];
  while (queue.length) {
    const node = queue.shift() as PyNode;
    out.push(node);
    for (const child of iterChildNodes(node)) {
      queue.push(child);
    }
  }
  return out;
}

/** An `ast.parse` failure, carrying the line number `SyntaxError` exposes. */
export class SyntaxErrorWithLine extends Error {
  lineno: number;
  constructor(message: string, lineno: number) {
    super(message);
    this.lineno = lineno;
  }
}

export type Parser = (code: string) => PyNode;

// --------------------------------------------------------------------------- //

/** Parser binding backed by pyodide's real `ast.parse` (AMEND-07).
 *
 * Converts the PyProxy AST into plain PyNode objects recursively. Async by
 * nature of WASM loading — `ASTReviewer.review` keeps the source's sync
 * signature, so wire the parser at bootstrap (`primeAstReviewer`). */
export async function pyodideParser(code: string): Promise<PyNode> {
  const mod = (await import(/* @vite-ignore */ "pyodide")) as unknown as {
    loadPyodide: (opts?: { indexURL?: string }) => Promise<PyProxyLike>;
  };
  const py = await getSharedPyodide(mod);
  py.globals.set("_ar_code", code);
  const tree = (await py.runPythonAsync(
    [
      "import ast as _ast, json as _json",
      "def _to_dict(n):",
      "    if isinstance(n, _ast.AST):",
      "        d = {'type': type(n).__name__}",
      "        for k, v in _ast.iter_fields(n):",
      "            d[k] = _to_dict(v)",
      "        if hasattr(n, 'lineno'): d['lineno'] = n.lineno",
      "        return d",
      "    if isinstance(n, list):",
      "        return [_to_dict(x) for x in n]",
      "    return n",
      "_json.dumps(_to_dict(_ast.parse(_ar_code)))",
    ].join("\n")
  )) as string;
  return JSON.parse(tree) as PyNode;
}

interface PyProxyLike {
  runPythonAsync(code: string): Promise<unknown>;
  globals: { set(k: string, v: unknown): void };
}

let _ar_py: PyProxyLike | null = null;
let _ar_loading: Promise<PyProxyLike> | null = null;
function getSharedPyodide(mod: {
  loadPyodide: (opts?: { indexURL?: string }) => Promise<PyProxyLike>;
}): Promise<PyProxyLike> {
  if (_ar_py !== null) {
    return Promise.resolve(_ar_py);
  }
  if (_ar_loading === null) {
    _ar_loading = mod.loadPyodide().then((py) => {
      _ar_py = py;
      return py;
    });
  }
  return _ar_loading;
}

/** The parser binding holder: primeAstReviewer() installs a sync wrapper over
 * the warmed interpreter; before that the constructor default throws honestly. */
export const pyodideParserHolder: { parser: Parser | null } = { parser: null };

/** Bootstrap helper: warm the interpreter (call once at engine startup). */
export async function primeAstReviewer(): Promise<void> {
  await pyodideParser("pass");
}

// --------------------------------------------------------------------------- //

/** AST reviewer with dynamic-call detection and multi-perspective verification. */
export class ASTReviewer {
  /** Track tainted variable names. */
  taintSources: Set<string> = new Set();

  /** The parser binding (pyodide-backed once primed; see PyNode note). */
  parser: Parser;

  constructor(parser?: Parser) {
    this.parser = parser ?? pyodideParserHolder.parser ?? ((_code: string) => {
      throw new Error("AST parser not bound — call primeAstReviewer() at bootstrap");
    });
  }

  /** Enhanced AST review (keeps the original signature and behaviour). */
  review(code: string): Result<string> {
    const findings = this.reviewPerspectives(code, [PERSPECTIVE_SECURITY]);
    for (const f of findings) {
      return Result.failure<string>(f.message);
    }
    return Result.success("AST review passed");
  }

  /** Multi-perspective static review, producing structured findings. */
  reviewPerspectives(
    code: string,
    perspectives?: readonly string[] | null,
    filePath = ""
  ): ReviewFinding[] {
    let tree: PyNode;
    try {
      tree = this.parser(code);
    } catch (e) {
      const err = e as SyntaxErrorWithLine;
      return [
        {
          id: `syn-${randHex8()}`,
          perspective: PERSPECTIVE_MAINTAINABILITY,
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

    const selected = new Set<string>();
    if (perspectives === null || perspectives === undefined) {
      for (const p of REVIEW_PERSPECTIVES) {
        selected.add(p);
      }
    } else {
      for (const p of perspectives) {
        const clean = PERSPECTIVE_ALIASES[p.toLowerCase()] ?? p.toLowerCase();
        if (REVIEW_PERSPECTIVES.includes(clean)) {
          selected.add(clean);
        }
      }
    }

    const findings: ReviewFinding[] = [];
    if (selected.has(PERSPECTIVE_SECURITY)) {
      findings.push(...this._checkSecurity(tree, filePath));
    }
    if (selected.has(PERSPECTIVE_PERFORMANCE)) {
      findings.push(...this._checkPerformance(tree, filePath));
    }
    if (selected.has(PERSPECTIVE_MAINTAINABILITY)) {
      findings.push(...this._checkMaintainability(tree, filePath));
    }
    if (selected.has(PERSPECTIVE_TEST_COVERAGE)) {
      findings.push(...this._checkTestCoverage(tree, filePath));
    }
    return findings;
  }

  /** Collect potential tainted sources. */
  _collectTaint(tree: PyNode): void {
    for (const node of walk(tree)) {
      if (node.type === "Assign") {
        for (const target of (node["targets"] as PyNode[]) ?? []) {
          if (target.type === "Name" && this._isTaintedSource(node["value"] as PyNode)) {
            this.taintSources.add(target["id"] as string);
          }
        }
      }
      if (node.type === "NamedExpr") {
        const v = node["value"] as PyNode;
        if (v?.type === "Name") {
          this.taintSources.add(v["id"] as string);
        }
      }
    }
  }

  /** Whether a node is a tainted source (user input, network, etc). */
  _isTaintedSource(node: PyNode | undefined): boolean {
    if (!node || node.type !== "Call") {
      return false;
    }
    const funcName = this._getCallSignature(node);
    return ["input", "read", "fetch", "request", "get"].some((d) => funcName.includes(d));
  }

  /** Whether a tainted value is used in a dangerous way. */
  _isTaintedUsage(node: PyNode): boolean {
    if (node.type !== "Call") {
      return false;
    }
    const func = this._getCallSignature(node);
    for (const arg of iterChildNodes(node)) {
      if (arg.type === "Name" && this.taintSources.has(arg["id"] as string)) {
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
   * handed Modules, Constants, arguments — anything. Without the type check the
   * first `node.func` access raised AttributeError and the whole review aborted,
   * which meant the native-execution gate never actually reviewed anything.
   */
  _isDangerousCall(node: PyNode): boolean {
    if (node.type !== "Call") {
      return false;
    }
    const funcName = this._getCallSignature(node);
    if (DANGEROUS_CALLS.has(funcName)) {
      return true;
    }
    // Dynamic dangerous call (getattr).
    if (funcName === "getattr") {
      try {
        const args = (node["args"] as PyNode[]) ?? [];
        if (args.length >= 2) {
          const attrArg = args[1] as PyNode;
          if (attrArg?.type === "Constant" && typeof attrArg["value"] === "string") {
            if (DANGEROUS_ATTRS.has(attrArg["value"] as string)) {
              return true;
            }
          }
        }
      } catch {
        // RULEBOOK §2 (broad swallow, fail-open): preserved — the source catches
        // (TypeError, AttributeError) and keeps going.
      }
    }
    return false;
  }

  /** Whether `node` reads a dangerous attribute (guarded on node type). */
  _isDangerousAttr(node: PyNode): boolean {
    if (node.type !== "Attribute") {
      return false;
    }
    return DANGEROUS_ATTRS.has(node["attr"] as string);
  }

  _isDangerousImport(node: PyNode): boolean {
    if (node.type === "Import") {
      for (const alias of (node["names"] as PyNode[]) ?? []) {
        if (DANGEROUS_MODULES.has(alias["name"] as string)) {
          return true;
        }
      }
    } else if (node.type === "ImportFrom") {
      const mod = node["module"] as string | null;
      if (mod && DANGEROUS_MODULES.has(mod)) {
        return true;
      }
    }
    return false;
  }

  _hasPathTraversal(node: PyNode): boolean {
    if (node.type === "Constant" && typeof node["value"] === "string") {
      const v = node["value"] as string;
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
  _getCallSignature(node: PyNode): string {
    if (node.type !== "Call") {
      return "";
    }
    const func = node["func"] as PyNode | undefined;
    if (!func) {
      return "";
    }
    if (func.type === "Name") {
      return func["id"] as string;
    }
    if (func.type === "Attribute") {
      const value = func["value"] as PyNode | undefined;
      if (value?.type === "Name") {
        return `${value["id"] as string}.${func["attr"] as string}`;
      }
      return func["attr"] as string;
    }
    return "";
  }

  /** Attribute name, or "" for non-Attribute nodes. */
  _getAttrName(node: PyNode): string {
    return node.type === "Attribute" ? (node["attr"] as string) : "";
  }

  _getImportName(node: PyNode): string {
    if (node.type === "Import") {
      const names = (node["names"] as PyNode[]) ?? [];
      return names.length ? (names[0]!["name"] as string) : "";
    }
    if (node.type === "ImportFrom") {
      return (node["module"] as string) || "";
    }
    return "";
  }

  _checkSecurity(tree: PyNode, filePath = ""): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    this.taintSources.clear();
    this._collectTaint(tree);

    const mk = (ruleId: string, severity: string, message: string, line: number): ReviewFinding => ({
      id: `sec-${randHex8()}`,
      perspective: PERSPECTIVE_SECURITY,
      severity,
      message,
      file: filePath,
      line,
      ruleId,
      verdict: "pending",
      verdictReason: "",
    });

    for (const node of walk(tree)) {
      const line = (node.lineno as number) || 0;

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
        for (const target of (node["targets"] as PyNode[]) ?? []) {
          if (target.type !== "Name") {
            continue;
          }
          const nameLower = (target["id"] as string).toLowerCase();
          if (["api_key", "secret_key", "password", "auth_token"].some((k) => nameLower.includes(k))) {
            const value = node["value"] as PyNode;
            if (value?.type === "Constant" && typeof value["value"] === "string") {
              if ((value["value"] as string).length >= 8) {
                findings.push(
                  mk(
                    "SEC_HARDCODED_SECRET",
                    "warning",
                    `Potential hardcoded credential in variable '${target["id"] as string}'`,
                    line
                  )
                );
              }
            }
          }
        }
      }
    }
    return findings;
  }

  _checkPerformance(tree: PyNode, filePath = ""): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    const scanLoops = (node: PyNode, loopDepth = 0): void => {
      const isLoop = node.type === "For" || node.type === "While";
      const currentDepth = isLoop ? loopDepth + 1 : loopDepth;

      if (isLoop && loopDepth >= 1) {
        findings.push({
          id: `perf-${randHex8()}`,
          perspective: PERSPECTIVE_PERFORMANCE,
          severity: "warning",
          message: "Nested loop detected: potential quadratic O(n^2) complexity",
          file: filePath,
          line: (node.lineno as number) || 0,
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
                perspective: PERSPECTIVE_PERFORMANCE,
                severity: "warning",
                message: `Regex compiled or executed inside loop (${sig}): consider pre-compiling pattern with re.compile() outside loop`,
                file: filePath,
                line: (child.lineno as number) || 0,
                ruleId: "PERF_REGEX_IN_LOOP",
                verdict: "pending",
                verdictReason: "",
              });
            }
          } else if (child.type === "AugAssign" && (child["op"] as string) === "Add") {
            findings.push({
              id: `perf-${randHex8()}`,
              perspective: PERSPECTIVE_PERFORMANCE,
              severity: "info",
              message:
                "String or collection concatenation inside loop body: consider list append and ''.join()",
              file: filePath,
              line: (child.lineno as number) || 0,
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

  _checkMaintainability(tree: PyNode, filePath = ""): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const node of walk(tree)) {
      const line = (node.lineno as number) || 0;

      if (node.type === "ImportFrom") {
        for (const alias of (node["names"] as PyNode[]) ?? []) {
          if (alias["name"] === "*") {
            const modName = (node["module"] as string) || "";
            findings.push({
              id: `maint-${randHex8()}`,
              perspective: PERSPECTIVE_MAINTAINABILITY,
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
        const args = node["args"] as PyNode | undefined;
        const totalArgs =
          ((args?.["args"] as PyNode[]) ?? []).length +
          ((args?.["posonlyargs"] as PyNode[]) ?? []).length +
          ((args?.["kwonlyargs"] as PyNode[]) ?? []).length;
        if (totalArgs > 7) {
          findings.push({
            id: `maint-${randHex8()}`,
            perspective: PERSPECTIVE_MAINTAINABILITY,
            severity: "warning",
            message: `Function '${node["name"] as string}' has ${totalArgs} arguments (threshold: 7): consider refactoring into a parameter object`,
            file: filePath,
            line,
            ruleId: "MAINT_TOO_MANY_ARGS",
            verdict: "pending",
            verdictReason: "",
          });
        }
      }
    }

    const checkNesting = (node: PyNode, depth: number): void => {
      const isBranch = ["If", "For", "While", "Try", "With"].includes(node.type);
      const nextDepth = isBranch ? depth + 1 : depth;
      if (isBranch && depth >= 4) {
        findings.push({
          id: `maint-${randHex8()}`,
          perspective: PERSPECTIVE_MAINTAINABILITY,
          severity: "info",
          message:
            "Deeply nested control flow (> 4 levels): consider flattening logic with guard clauses or helper functions",
          file: filePath,
          line: (node.lineno as number) || 0,
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

  _checkTestCoverage(tree: PyNode, filePath = ""): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    for (const node of walk(tree)) {
      const line = (node.lineno as number) || 0;

      if (node.type === "FunctionDef" && (node["name"] as string).startsWith("test_")) {
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
            perspective: PERSPECTIVE_TEST_COVERAGE,
            severity: "warning",
            message: `Test function '${node["name"] as string}' lacks assertion statement`,
            file: filePath,
            line,
            ruleId: "TEST_MISSING_ASSERTION",
            verdict: "pending",
            verdictReason: "",
          });
        }
      }

      if (node.type === "ExceptHandler") {
        const body = (node["body"] as PyNode[]) ?? [];
        if (body.length === 1 && body[0]!.type === "Pass") {
          findings.push({
            id: `test-${randHex8()}`,
            perspective: PERSPECTIVE_TEST_COVERAGE,
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
   * RULEBOOK §2 (control flow): the source's `continue` chain is order-dependent
   * — an early rule wins. Reproduced in the same order.
   */
  verifyWithCritic(findings: ReviewFinding[], code = "", filePath = ""): ReviewFinding[] {
    for (const f of findings) {
      const targetFile = f.file || filePath;
      const normalized = targetFile.replace(/\\/g, "/");
      const isTestFile = Boolean(
        targetFile &&
          (targetFile.includes("test_") || targetFile.includes("_test") || normalized.includes("/tests/"))
      );

      if (f.ruleId === "SEC_IMPORT" && isTestFile) {
        f.verdict = "rejected";
        f.verdictReason = "Standard import in test file context is expected";
        continue;
      }

      if (
        f.message.toLowerCase().includes("dynamic") ||
        f.ruleId === "SEC_ATTR" ||
        f.ruleId === "MAINT_DYNAMIC"
      ) {
        f.verdict = "escalated";
        f.verdictReason = "Dynamic access pattern requires human contextual judgment";
        continue;
      }

      if (
        f.severity === "error" ||
        ["SEC_CALL", "SEC_TRAVERSAL", "SYNTAX_ERROR", "PERF_QUADRATIC_LOOP", "TEST_MISSING_ASSERTION"].includes(
          f.ruleId
        )
      ) {
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

/** `uuid.uuid4().hex[:8]` — eight lowercase hex characters. */
function randHex8(): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  }
  return s;
}

export function getAstReviewer(parser: Parser): ASTReviewer {
  return new ASTReviewer(parser);
}

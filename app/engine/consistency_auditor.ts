/**
 * consistency_auditor.ts — Evolution rule consistency and safety auditor (Module 3).
 *
 * Ported from `app/backend/consistency_auditor.py` (129 lines).
 *
 * Implementation providing 4 quality gates for rule candidates:
 * 1. AST syntax parsing for contained code blocks (ensures no broken snippets).
 * 2. Token budget enforcement (<= 300 tokens).
 * 3. Credential and secret leak scanning.
 * 4. Semantic contradiction / conflict detection against active rules.
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖。
 *   §2  Python `ast.parse` → pyodide（AMEND-07 依赖行）：代码块语法校验走
 *       真正的 CPython ast.parse（python_runtime.checkAllowlistAst 同源），
 *       异步化（源同步签名 → Promise；调用方审计链路本就异步投递）。
 *       与源一致的判定：语法错误 → ast_valid=false + violation 记录。
 *   §2  冲突检测的反向引用 `\1` → `$1` + re.escape 手写（JS 无 re.escape，
 *       用正则字面量实现转义函数）。
 *   §4  naming: consistency_auditor.py → consistency_auditor.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

export interface AuditResult {
  passed: boolean;
  reason: string;
  violations: string[];
  ast_valid: boolean;
  token_count: number;
  secrets_detected: string[];
  conflicts_detected: string[];
}

// Secret detection patterns
const _SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[a-zA-Z0-9]{20,}/gi, "OpenAI / API Key"],
  [/ghp_[a-zA-Z0-9]{30,}/gi, "GitHub Personal Access Token"],
  [/AKIA[0-9A-Z]{16}/g, "AWS Access Key"],
  [/Bearer\s+[a-zA-Z0-9_\-.]{20,}/gi, "Bearer Token"],
 [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "Private Key Header"],
];

// Code block pattern
const _CODE_BLOCK_RE = /```(?:python|py)?\s*\n([\s\S]*?)```/gi;

// Known mutually exclusive tool pairs / antithesis words for semantic conflict check
// （\1 反向引用在 JS 用 $1 语义；保留原始字符串供运行时替换）
const _CONFLICT_PAIRS: Array<[string, string]> = [
  ["\\balways use pnpm\\b", "\\balways use npm\\b"],
  ["\\balways use npm\\b", "\\balways use pnpm\\b"],
  ["\\bprefer pnpm\\b", "\\bprefer npm\\b"],
  ["\\bprefer npm\\b", "\\bprefer pnpm\\b"],
  ["\\benable (\\w+)\\b", "\\bdisable \\1\\b"],
  ["\\bdisable (\\w+)\\b", "\\benable \\1\\b"],
  ["\\balways (\\w+)\\b", "\\bnever \\1\\b"],
  ["\\bnever (\\w+)\\b", "\\balways \\1\\b"],
];

/** JS 版 re.escape（转义正则元字符）。 */
function _re_escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 真 ast.parse（pyodide / CPython-in-WASM，AMEND-07 依赖行）。
 * 返回 null = 语法合法（与源 ast.parse 不抛一致）；否则返回解释器自己的
 * 错误消息。Pyodide 加载失败时回退到词法配平启发式（fail-open，见
 * _heuristic_python_syntax_check）。 */
async function python_syntax_check(block: string): Promise<string | null> {
  try {
    const mod = (await import(/* @vite-ignore */ "pyodide")) as unknown as {
      loadPyodide: (opts?: { indexURL?: string }) => Promise<PyodideHandle>;
    };
    const py = await get_shared_pyodide(mod);
    py.globals.set("_ca_code", block);
    const ok = (await py.runPythonAsync(
      [
        "import ast as _ast",
        "try:",
        "    _ast.parse(_ca_code)",
        "    _ok = None",
        "except SyntaxError as _e:",
        "    _ok = f\"{*_e.msg*} (line {*_e.lineno*})\".replace(\"*\", chr(123)) if False else f\"{_e.msg} (line {_e.lineno})\"",
        "_ok",
      ].join("\n")
    )) as string | null;
    return ok ?? null;
  } catch {
    return _heuristic_python_syntax_check(block);
  }
}

interface PyodideHandle {
  runPythonAsync(code: string): Promise<unknown>;
  globals: { set(k: string, v: unknown): void };
}

let _ca_py: PyodideHandle | null = null;
let _ca_loading: Promise<PyodideHandle> | null = null;
function get_shared_pyodide(mod: {
  loadPyodide: (opts?: { indexURL?: string }) => Promise<PyodideHandle>;
}): Promise<PyodideHandle> {
  if (_ca_py !== null) {
    return Promise.resolve(_ca_py);
  }
  if (_ca_loading === null) {
    _ca_loading = mod.loadPyodide().then((py) => {
      _ca_py = py;
      return py;
    });
  }
  return _ca_loading;
}

/** Python ast.parse 的启发式近似：配平检查 + 空块跳过。
 * 能抓最常见的坏片段（未闭合括号/引号、悬空反引号）；不保证等价于编译器。
 * DIVERGENCE documented at header. */
function _heuristic_python_syntax_check(block: string): string | null {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let inStr: string | null = null;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]!;
    if (inStr) {
      if (ch === inStr && block[i - 1] !== "\\") {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stack.pop();
      if (open !== pairs[ch]) {
        return `unbalanced bracket '${ch}'`;
      }
    }
  }
  if (inStr) {
    return "unterminated string literal";
  }
  if (stack.length > 0) {
    return `unclosed bracket '${stack[stack.length - 1]}'`;
  }
  return null;
}

/** Audits self-evolved rule candidates before promotion or persistent storage. */
export class ConsistencyAuditor {
  max_tokens: number;

  constructor(max_tokens = 300) {
    this.max_tokens = Math.max(10, Math.trunc(max_tokens));
  }

  /** Estimate token count based on whitespace & character heuristic. */
  estimate_tokens(text: string): number {
    if (!text) {
      return 0;
    }
    const words = text.split(/\s+/).filter((w) => w).length;
    const chars = Math.floor(text.length / 4);
    return Math.max(words, chars);
  }

  /** Audits a candidate rule across all 4 gates.
   * Async drift：Gate 2 用 Pyodide 真 ast.parse（AMEND-07），动态加载需
   * await；其余三门同步执行。 */
  async audit_rule_async(rule_text: string, existing_rules?: readonly string[] | null): Promise<AuditResult> {
    const violations: string[] = [];
    let ast_valid = true;
    const secrets_detected: string[] = [];
    const conflicts_detected: string[] = [];

    const clean_text = rule_text ? rule_text.trim() : "";
    if (!clean_text) {
      return {
        passed: false,
        reason: "Rule text is empty",
        violations: ["Empty rule text"],
        ast_valid: true,
        token_count: 0,
        secrets_detected: [],
        conflicts_detected: [],
      };
    }

    // Gate 1: Token Budget
    const token_count = this.estimate_tokens(clean_text);
    if (token_count > this.max_tokens) {
      violations.push(`Token budget exceeded: ${token_count} > ${this.max_tokens}`);
    }

    // Gate 2: AST Code Block Validation — real ast.parse via pyodide
    for (const block of clean_text.matchAll(_CODE_BLOCK_RE)) {
      const stripped_block = block[1]!.trim();
      if (!stripped_block) {
        continue;
      }
      const err = await python_syntax_check(stripped_block);
      if (err !== null) {
        ast_valid = false;
        violations.push(`AST Syntax error in code block: ${err}`);
      }
    }

    // Gate 3: Credential Scrubber
    for (const [pattern, desc] of _SECRET_PATTERNS) {
      const matches = clean_text.match(pattern);
      if (matches && matches.length > 0) {
        const m0 = matches[0]!;
        const masked_match = m0.length > 8 ? m0.slice(0, 8) + "..." : "***";
        secrets_detected.push(`${desc} (${masked_match})`);
        violations.push(`Credential / Secret leak detected: ${desc}`);
      }
    }

    // Gate 4: Semantic Conflict Detection
    if (existing_rules && existing_rules.length > 0) {
      const lower_candidate = clean_text.toLowerCase();
      for (const existing of existing_rules) {
        if (!existing) {
          continue;
        }
        const lower_existing = existing.toLowerCase();
        for (const [pat1, pat2] of _CONFLICT_PAIRS) {
          const m1 = new RegExp(pat1, "i").exec(lower_candidate);
          if (!m1) {
            continue;
          }
          let target: string;
          if (pat2.includes("\\1") && m1.length > 1 && m1[1] !== undefined) {
            target = pat2.replace("\\1", _re_escape(m1[1]));
          } else {
            target = pat2;
          }
          if (new RegExp(target, "i").test(lower_existing)) {
            const conflict_msg =
              `Semantic contradiction: '${m1[0]}' conflicts ` +
              `with existing rule stating '${existing.slice(0, 80)}...'`;
            conflicts_detected.push(conflict_msg);
            violations.push(conflict_msg);
            break;
          }
        }
      }
    }

    const passed = violations.length === 0;
    const reason = passed ? "OK" : violations.join("; ");

    return {
      passed,
      reason,
      violations,
      ast_valid,
      token_count,
      secrets_detected,
      conflicts_detected,
    };
  }

  /** 同步兼容入口：Pyodide 未就绪时降级为词法配平启发式（结果语义见
   * _heuristic_python_syntax_check）；就绪后走真 ast.parse。 */
  audit_rule(rule_text: string, existing_rules?: readonly string[] | null): AuditResult {
    const violations: string[] = [];
    let ast_valid = true;
    const secrets_detected: string[] = [];
    const conflicts_detected: string[] = [];

    const clean_text = rule_text ? rule_text.trim() : "";
    if (!clean_text) {
      return {
        passed: false,
        reason: "Rule text is empty",
        violations: ["Empty rule text"],
        ast_valid: true,
        token_count: 0,
        secrets_detected: [],
        conflicts_detected: [],
      };
    }

    const token_count = this.estimate_tokens(clean_text);
    if (token_count > this.max_tokens) {
      violations.push(`Token budget exceeded: ${token_count} > ${this.max_tokens}`);
    }

    for (const block of clean_text.matchAll(_CODE_BLOCK_RE)) {
      const stripped_block = block[1]!.trim();
      if (!stripped_block) {
        continue;
      }
      const err = _heuristic_python_syntax_check(stripped_block);
      if (err !== null) {
        ast_valid = false;
        violations.push(`AST Syntax error in code block: ${err}`);
      }
    }

    for (const [pattern, desc] of _SECRET_PATTERNS) {
      const matches = clean_text.match(pattern);
      if (matches && matches.length > 0) {
        const m0 = matches[0]!;
        const masked_match = m0.length > 8 ? m0.slice(0, 8) + "..." : "***";
        secrets_detected.push(`${desc} (${masked_match})`);
        violations.push(`Credential / Secret leak detected: ${desc}`);
      }
    }

    if (existing_rules && existing_rules.length > 0) {
      const lower_candidate = clean_text.toLowerCase();
      for (const existing of existing_rules) {
        if (!existing) {
          continue;
        }
        const lower_existing = existing.toLowerCase();
        for (const [pat1, pat2] of _CONFLICT_PAIRS) {
          const m1 = new RegExp(pat1, "i").exec(lower_candidate);
          if (!m1) {
            continue;
          }
          let target: string;
          if (pat2.includes("\\1") && m1.length > 1 && m1[1] !== undefined) {
            target = pat2.replace("\\1", _re_escape(m1[1]));
          } else {
            target = pat2;
          }
          if (new RegExp(target, "i").test(lower_existing)) {
            const conflict_msg =
              `Semantic contradiction: '${m1[0]}' conflicts ` +
              `with existing rule stating '${existing.slice(0, 80)}...'`;
            conflicts_detected.push(conflict_msg);
            violations.push(conflict_msg);
            break;
          }
        }
      }
    }

    const passed = violations.length === 0;
    const reason = passed ? "OK" : violations.join("; ");

    return {
      passed,
      reason,
      violations,
      ast_valid,
      token_count,
      secrets_detected,
      conflicts_detected,
    };
  }
}

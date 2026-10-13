/**
 * command_classifier.ts — 命令内容分级器：shell 文本 → 级别 + 风险旗标。
 *
 * Ported from `app/backend/command_classifier.py` (623 lines, wave-5 TS).
 *
 * ## 解决什么
 *
 * 工具级的风险表（TOOL_RISK_LEVELS）回答的是"这个**工具**多危险"，但
 * shell_executor 的危险程度完全取决于**命令文本**——同一个工具，`ls` 和
 * `mkfs` 天差地别。本模块补上内容这一维：对命令文本做机械解析（command_guard
 * 原语）+ 规则表定级，作为工具策略管道的 COMMAND 层。
 *
 * ## 级别模型（四级，与权限档位解耦）
 *
 *     ALLOW      机械安全——不带旗标，不参与定级
 *     REVIEW     需确认——网络出口、提权、装包、杀进程等"合理但要看一眼"
 *     RESTRICTED 高危——破坏性、系统状态、远程代码执行、持久化。
 *                这类操作的失误不可撤回，因此**不参与自动放行**：无论权限档位
 *                如何都至少落到 ASK（CRITICAL 语义，只有显式人工批准可过）；
 *                收紧到 DENY 由 `restrictedAction` 控制，默认 ask。
 *
 * 规则表只收**形态**（shape），不收业务：`rm` 本身不是红线（日常清构建产物），
 * `rm -rf /` 才是。每条规则带注释说明"为什么这条在此级别"——分级表里一条
 * 没有理由的规则，三个月后就是一条没人敢删也没人敢改的黑巫术。
 *
 * ## 网络出口策略
 *
 * 命令文本里出现的 host 会过一道白/黑名单（声明式，config 可调）：
 * deny 命中 → RESTRICTED；closed 模式下 allow 不命中 → REVIEW（未知出口
 * "问一下"而不是"直接死"，企业内网白名单没配全时降级体验可控）。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/command_classifier.py -> app/engine/command_classifier.ts.
 *       Public python names (snake_case) and dataclass field names kept verbatim;
 *       `from rust_adapters import command_guard as cg` resolves to the absorbed
 *       primitives in ./command_guard.ts.
 *   §2  `class Tier(str, Enum)` — same finding as tool_policy §2: CPython 3.13
 *       hashes a str-Enum member by VALUE, so plain string constants carry every
 *       `==` / dict-key behaviour. `to_dict()` reads `self.tier.value`, so a
 *       NON-member still crashes with python's AttributeError text (enumValue).
 *   §2  every truth gate goes through pyTruth: `if self.words:`, `str(command or
 *       "")`, `c.get("allow") or []`, `if not verbs:`, `extract_hosts(text) or
 *       ()`, `if outcome:`, `if hosts:`, `if rule.why:`, `if not text:`.
 *   §2  dataclass `field(default_factory=list)` allocates a FRESH list per
 *       instance AND fires only when the argument is OMITTED — `CommandVerdict(
 *       Tier.ALLOW, None)` really stores None. Same for Rule.words/regex/why.
 *   §2  `tokens[:3]`, `tokens[i+1:]`, `verdict.reasons[:3]` are python slices
 *       (out-of-range tolerant, never undefined) — kept as .slice().
 *   §2  `t.split(".", 1)[0]` / `low.split(".", 1)[0]` take the FIRST label only,
 *       so `mkfs.ext4` hits `mkfs` while `sudoers` is never swallowed by `sudo`.
 *       dotHead() mirrors it (JS split's limit argument would be a lie here).
 *   §2  `_INSTALL_TABLE.get(tok)` distinguishes "absent" (None) from "present
 *       with empty verbs" (取包即执行) — Map.get() returns undefined, so the
 *       branch tests for undefined, never for falsiness.
 *   §2  regex word boundaries: python `\b` is unicode-aware (word = str.isalnum()
 *       or "_"), JS `\b` is ASCII-only, so `删除passwd文件` matches CG-CR-01 in
 *       JS but not in python. pyRe() rewrites every `\b` into an equivalent
 *       lookaround pair over [\p{L}\p{N}_] and turns on the `u` flag — this keeps
 *       CJK-adjacent command text (the normal case here) behaving identically.
 *   §2  present-but-null: `args.get(key)` / `guard.get("restrictedAction","")`
 *       return the stored null instead of the default — dictGet.
 *   §2  `req.context[KEY] = ...` on a non-mapping context (None, a list) raises
 *       TypeError and the surrounding except swallows it, so the audit entry is
 *       simply skipped. JS would happily attach the property to an array, so
 *       setItem() reproduces the raise first.
 *   §2  `json.load(f).get("permissions")` raises AttributeError when the JSON
 *       root is not an object (a list has no `.get`); the surrounding except then
 *       falls back to the default policy. getAttr() reproduces the raise.
 *   §2  the IPv4 fallback in classify() step 3 does NOT lowercase the matches
 *       (extract_hosts does), and `dict.fromkeys` dedupe is therefore
 *       case-sensitive on that path. Kept verbatim, including the order.
 *   §2  `_EGRESS_HINT_WORDS` is a tuple concat that repeats "curl"/"wget" (they
 *       are already in _FETCHERS) and is read by nothing in this module. Kept
 *       with its duplicates — deleting dead state is not a port's job.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, enum identity): python can tell the member `Tier.RESTRICTED`
 *       apart from the literal "restricted" — `is` says no, `==` says yes — while
 *       here they are the same value. Equivalence argument: every tier in this
 *       module is assigned from the exported constants, so each `is` comparison
 *       only ever sees members; a non-member still dies in to_dict() with
 *       python's own AttributeError text. Only a caller that hand-wrote a raw
 *       literal would see a difference, and no producer in this tree does.
 *       Pinned as SKIP(repr-divergent) by the parity probe.
 *   DIVERGENCE(port, pyStr of containers): `str(command or "")` renders a
 *       python container with repr(); pyStr() reproduces that for arrays and
 *       plain objects, but a python float that is integral renders "1.0" there
 *       and "1" here (JSON.parse loses the distinction). Only reachable when a
 *       caller hands classify() a non-str argument; pinned, not exercised.
 *   The pipeline-level `try/except Exception` around each rule and each primitive
 *   stays a broad swallow — a broken rule must not take the classifier down
 *   ("单条规则坏了不拖垮整体——宁缺勿崩"), so no error is allowed to escape
 *   classify().
 *   DIVERGENCE(port, seam): the config path is read through
 *       CLASSIFIER_SEAMS.configPath() rather than inline. Equivalence argument:
 *       the default expression resolves to the identical file (engine/ and
 *       backend/ both sit one level under app/), the parse and the except
 *       fallback are unchanged, and the only caller that overrides it is the
 *       parity probe — which has the same lever on the python side (rebinding
 *       the module's `__file__`). Shipped behaviour cannot differ.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import {
    PolicyAction,
    PolicyDecision,
    PolicyLayer,
    type PolicyLayerFn,
    type PolicyRequest,
} from "./tool_policy.js";
import {
    domainSuffixMatch,
    extractHosts,
    fetchPipeExec,
    splitSegments,
    tokenize,
} from "./command_guard.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class AttributeErrorP extends Error {
    constructor(obj: unknown, attr = "value") {
        super(`'${pyTypeName(obj)}' object has no attribute '${attr}'`);
        this.name = "AttributeError";
    }
}

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return v.name || "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python `dict.get(key, dflt)`: present-but-null returns null, not dflt. */
function dictGet(dict: unknown, key: string, dflt: unknown = null): unknown {
    if (dict !== null && typeof dict === "object" && !Array.isArray(dict) &&
        key in (dict as Record<string, unknown>)) {
        return (dict as Record<string, unknown>)[key];
    }
    return dflt;
}

/** python `obj.get(key)` as an ATTRIBUTE access: non-dict receivers raise. */
function getAttr(obj: unknown, key: string, dflt?: unknown): unknown {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw new AttributeErrorP(obj, "get");
    }
    return dflt === undefined ? dictGet(obj, key) : dictGet(obj, key, dflt);
}

/** python `for x in v`: arrays, strings (chars), Map/Set, plain objects (keys). */
function pyIter(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (v instanceof Set) return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v !== null && typeof v === "object") return Object.keys(v as object);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `obj[key] = value`: only mappings accept a string key, a list or None
 *  raises TypeError. The one call site swallows the error, so what matters is
 *  that the write is SKIPPED — JS would happily hang a property off an array. */
function setItem(obj: unknown, key: string, val: unknown): void {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw new TypeErrorP(`'${pyTypeName(obj)}' object does not support item assignment`);
    }
    (obj as JsonDict)[key] = val;
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStr(v);
}

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (v === null) return "None";
    if (v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number" || typeof v === "string") return String(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "set(" + (v.size ? "{...}" : "()") + ")";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
}

/** python `s.split()` — whitespace runs, no empty leading/trailing token. */
function pySplit(s: string): string[] {
    return s.split(/\s+/).filter((t) => t.length > 0);
}

/** python `s.split(".", 1)[0]` — the first dot-label, whole string if none. */
function dotHead(s: string): string {
    const i = s.indexOf(".");
    return i < 0 ? s : s.slice(0, i);
}

/**
 * python's `\b` is unicode-aware, JS's is ASCII-only. Rewrite every `\b` into
 * the position-equivalent lookaround pair over python's word class (letters,
 * numbers, underscore) and compile with `u` so \p{...} works.
 */
const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = "(?:(?<=" + WORD + ")(?!" + WORD + ")|(?<!" + WORD + ")(?=" + WORD + "))";
function pyRe(source: string, flags = ""): RegExp {
    return new RegExp(source.split("\\b").join(BOUNDARY), "u" + flags);
}

type JsonDict = Record<string, unknown>;

/** python `x.value` on a `str`-Enum member: non-members raise AttributeError. */
function enumValue(v: string, domain: Set<string>): string {
    if (typeof v === "string" && domain.has(v)) return v;
    throw new AttributeErrorP(v);
}

// ── 级别模型 ─────────────────────────────────────────────────────────────────

/** 命令文本的机械定级。ALLOW 不产生裁决；REVIEW→ASK；RESTRICTED→ASK（可收紧为 DENY）。 */
export const Tier = {
    ALLOW: "allow",
    REVIEW: "review",
    RESTRICTED: "restricted",
} as const;
export type TierValue = (typeof Tier)[keyof typeof Tier];

const TIER_VALUES = new Set<string>(Object.values(Tier));

// ── 风险旗标 ─────────────────────────────────────────────────────────────────

/** 风险旗标（audit/UI 用，与级别正交：一条命令可以同时带 network + privilege）。 */
export const FLAG_NETWORK = "network-egress";
export const FLAG_DESTRUCTIVE = "fs-destructive";
export const FLAG_SYSTEM_STATE = "system-state";
export const FLAG_REMOTE_EXEC = "remote-code-exec";
export const FLAG_ELEVATION = "privilege-escalation";
export const FLAG_PERSISTENCE = "persistence";
export const FLAG_PROCESS_KILL = "process-kill";
export const FLAG_CREDENTIAL = "credential-access";

// ── 规则 ─────────────────────────────────────────────────────────────────────

/** 一条分级规则 = 命中的机械形态 + 它在此级别的原因。 */
export class Rule {
    rule_id: string;
    flag: string;
    tier: TierValue;
    // 命中判定：命令 token 首词或任意位置匹配（大小写不敏感）
    words: string[];
    regex: RegExp | null;
    why: string;
    /** 结构化判定：词表与正则都压不平的二维关系（见 _INSTALL_TABLE） */
    matcher: ((tokens: string[]) => unknown) | null;

    constructor(rule_id: string, flag: string, tier: TierValue,
                words?: string[] | null, regex?: RegExp | null,
                why?: string, matcher?: ((tokens: string[]) => unknown) | null) {
        // dataclass defaults fire only when the argument is OMITTED, so an
        // explicit null really stores null (and `if self.words:` is then False).
        this.rule_id = rule_id;
        this.flag = flag;
        this.tier = tier;
        this.words = words === undefined ? [] : words as string[];
        this.regex = regex === undefined ? null : regex;
        this.why = why === undefined ? "" : why;
        this.matcher = matcher === undefined ? null : matcher;
    }

    hit(tokens: string[], text: string): boolean {
        // 词表匹配带"首标签等价"：Windows 下可执行文件常带扩展名
        // （mkfs.ext4、shutdown.exe），首个 '.' 前的部分与词表相等即命中。
        // 只切第一段标签——"sudoers" 不会被 "sudo" 误吞。
        if (pyTruth(this.words)) {
            for (const t of tokens) {
                if ((this.words as string[]).includes(t) ||
                    (this.words as string[]).includes(dotHead(t))) {
                    return true;
                }
            }
        }
        if (this.regex !== null && this.regex.test(text)) return true;
        if (this.matcher !== null) return pyTruth(this.matcher(tokens));
        return false;
    }
}

// ── RESTRICTED：失误不可撤回的形态 ────────────────────────────────────────────
// 级别理由统一写进每条规则的 why，不在这里重复。

const _R: TierValue = Tier.RESTRICTED;

export const _DESTRUCTIVE_RULES: Rule[] = [
    new Rule("CG-FS-01", FLAG_DESTRUCTIVE, _R,
        undefined,
        pyRe("\\brm\\s+(-[a-z]*[rf][a-z]*\\s+)*(/|~|\\*)", "i"),
        "rm 连打 -r/-f 且目标落在根/家目录/通配——整棵树的不可撤回删除"),
    new Rule("CG-FS-02", FLAG_DESTRUCTIVE, _R,
        ["mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.ntfs"],
        undefined,
        "直接在块设备上造文件系统，盘上原有数据全部蒸发"),
    new Rule("CG-FS-03", FLAG_DESTRUCTIVE, _R,
        undefined,
        pyRe("\\bdd\\b[^\\n|;]*\\bof=/dev/", "i"),
        "dd 直写块设备——等于绕过文件系统裸写磁盘"),
    new Rule("CG-FS-04", FLAG_DESTRUCTIVE, _R,
        ["format", "diskpart", "parted"],
        undefined,
        "Windows/Linux 卷级格式化与磁盘分区操作，同属不可逆盘面操作"),
    new Rule("CG-FS-05", FLAG_DESTRUCTIVE, _R,
        undefined,
        pyRe("\\b(rd|rmdir)\\s+/s\\b|\\bdel\\s+/(f|s|q)\\b", "i"),
        "Windows 递归/强制删除整棵目录"),
    new Rule("CG-FS-06", FLAG_DESTRUCTIVE, _R,
        ["shred", "wipe"],
        undefined,
        "覆写式抹除，比删除更彻底，同样不可撤回"),
    new Rule("CG-FS-07", FLAG_DESTRUCTIVE, _R,
        ["ddrescue", "sdelete"],
        undefined,
        "裸盘级读写/安全擦除专用工具——作用对象是盘面而非文件，误用不可撤回"),
];

export const _SYSTEM_RULES: Rule[] = [
    new Rule("CG-SY-01", FLAG_SYSTEM_STATE, _R,
        ["shutdown", "reboot", "halt", "poweroff"],
        undefined,
        "改变系统电源状态——用户手里没开着的保存工作会直接丢"),
    new Rule("CG-SY-02", FLAG_SYSTEM_STATE, Tier.REVIEW,
        ["systemctl"],
        undefined,
        "管理系统服务（启停/开关自启）改变系统运行态，要看一眼"),
];

export const _REMOTE_EXEC_RULES: Rule[] = [
    // fetch_pipe_exec 的机械检测本身是 RESTRICTED（远程代码直进本机 shell，
    // 来源内容未审计——这是远程执行类命令的经典投毒面）
    new Rule("CG-RX-01", FLAG_REMOTE_EXEC, _R,
        undefined,
        null,  // 由 fetch_pipe_exec 特判，见 classify()
        "网络取回的内容被管道/命令替换直接送进本机解释器——执行的是" +
        "运行时才确定的代码，任何静态白名单都约束不了它"),
];

export const _PERSISTENCE_RULES: Rule[] = [
    new Rule("CG-PS-01", FLAG_PERSISTENCE, _R,
        undefined,
        pyRe("\\b(schtasks\\s+/create|crontab\\s+-|at\\s+)\\b", "i"),
        "写定时任务 = 写持久化入口，影响面超出本次会话"),
    new Rule("CG-PS-02", FLAG_PERSISTENCE, _R,
        undefined,
        pyRe("\\breg\\s+(add|delete)\\b", "i"),
        "注册表写/删是系统级持久状态，回滚成本高"),
];

export const _CREDENTIAL_RULES: Rule[] = [
    new Rule("CG-CR-01", FLAG_CREDENTIAL, _R,
        undefined,
        pyRe("/etc/(shadow|sudoers)|\\b(passwd|chpasswd)\\b", "i"),
        "触碰口令库或 sudoers——认证体系的根基文件"),
];

// 防火墙 = 安全边界本身，代理改边界必须拦下（词表经行业默认拒绝清单交叉核对）

export const _FIREWALL_RULES: Rule[] = [
    new Rule("CG-NG-02", FLAG_SYSTEM_STATE, _R,
        ["iptables", "nft", "nftables", "firewall-cmd", "ufw"],
        undefined,
        "改防火墙规则 = 改机器的安全边界——放错一条口子外面看不见，收回来也不知道"),
];

export const _BOMB_RULES: Rule[] = [
    new Rule("CG-PK-02", FLAG_PROCESS_KILL, _R,
        undefined,
        pyRe(":\\s*\\(\\s*\\)\\s*\\{[^}]*\\|[^}]*&[^}]*\\}\\s*;?\\s*:"),
        "fork 炸弹形态——自我复制的进程爆炸，一条命令拖死整台机器"),
];

// ── 装包判定表（CG-IR-01） ────────────────────────────────────────────────────
//
// "装包"在两个维度上都分化，一条正则压不平：
//   * 同一管理器、不同子命令语义相反：`npm install` 引入外部代码，
//     `npm uninstall` 是移除，`npm test` 跟装包无关。
//     平正则要么漏掉 `npm ci`（按锁文件装，同样是引入外部代码），
//     要么把 `npm uninstall` 一起收进来。
//   * 不同管理器、同一动作叫法不同：npm `add` / gem `install` / apk `add` /
//     go `get` / cargo `install`。
// 所以收成二维表：管理器 → "会把外部代码带进本机"的子命令。逐格可注释、可增删，
// 比一条越写越长的大正则好维护。

/** 管理器前面可能出现的启动器：真正的管理器在它后面
 *  （`sudo apt install`、`python -m pip install`、`bash -c "npm install"`）。
 *  判定顺序是先查表再查启动器，所以一个词可以同时是管理器（如 `uv`）。 */
export const _INSTALL_LAUNCHERS = new Set<string>([
    "sudo", "doas", "env", "nohup", "command", "time", "nice", "stdbuf",
    "winpty", "uv", "python", "python3", "py", "bash", "sh", "zsh",
    "powershell", "pwsh", "cmd",
]);

/** 子命令之前允许出现的修饰词（`yarn global add`） */
export const _INSTALL_MODIFIERS = new Set<string>(["global", "workspace", "workspaces"]);

/** 值为空的元组 = 该管理器"取包即执行"，任何调用都算装包：
 *  `npx some-pkg` 会先把包拉下来再跑，装与执行在同一条命令里完成，
 *  没有子命令可区分。 */
export const _INSTALL_TABLE = new Map<string, string[]>([
    // JS / Node
    ["npm", ["install", "i", "ci", "add", "it"]],
    ["yarn", ["add", "install", "dlx", "global"]],
    ["pnpm", ["add", "install", "i", "dlx"]],
    ["bun", ["add", "install", "x"]],
    ["npx", []],
    ["bunx", []],
    // Python
    ["pip", ["install", "download"]],
    ["pip3", ["install", "download"]],
    ["uv", ["pip", "add", "tool"]],
    ["uvx", []],
    ["poetry", ["add", "install"]],
    ["conda", ["install", "create"]],
    ["mamba", ["install"]],
    // 系统包管理
    ["apt", ["install"]],
    ["apt-get", ["install"]],
    ["brew", ["install", "reinstall", "upgrade"]],
    ["choco", ["install", "upgrade"]],
    ["winget", ["install", "upgrade"]],
    ["dnf", ["install"]],
    ["yum", ["install"]],
    ["apk", ["add"]],
    ["zypper", ["install", "in"]],
    // 其他语言
    ["gem", ["install"]],
    ["cargo", ["install", "add"]],
    ["go", ["get", "install"]],
    ["composer", ["require", "install"]],
    ["bundle", ["install"]],
    ["dotnet", ["add", "restore"]],
]);

/** 跳过开关与修饰词，取出真正的子命令。 */
export function _first_subcommand(rest: string[]): string {
    for (const tok of rest) {
        const low = tok.toLowerCase();
        if (low.startsWith("-") || _INSTALL_MODIFIERS.has(low)) continue;
        return dotHead(low);
    }
    return "";
}

/** 管理器 × 子命令二维命中。见 ``_INSTALL_TABLE``。
 *
 * 只在前三个 token 里找管理器：再往后就是包参数了（`npm i lodash`
 * 里的 `lodash` 不该被当成管理器）。遇到既不是启动器也不是开关的未知词就停
 * ——否则 `grep "npm install" README` 也会被当成装包。
 */
export function _is_install_command(tokens: string[]): boolean {
    for (let i = 0; i < Math.min(tokens.length, 3); i++) {
        const tok = dotHead((tokens[i] as string).toLowerCase());
        const verbs = _INSTALL_TABLE.get(tok);
        if (verbs !== undefined) {
            if (!pyTruth(verbs)) return true;  // 取包即执行型（npx/bunx/uvx）
            return verbs.includes(_first_subcommand(tokens.slice(i + 1)));
        }
        if (tok.startsWith("-") || _INSTALL_LAUNCHERS.has(tok)) continue;
        break;
    }
    return false;
}

// ── REVIEW：合理但要人看一眼的形态 ────────────────────────────────────────────

const _V: TierValue = Tier.REVIEW;

export const _REVIEW_RULES: Rule[] = [
    new Rule("CG-EL-01", FLAG_ELEVATION, _V,
        ["sudo", "su", "runas", "doas"],
        undefined,
        "提权运行——后果以 root/管理员权限落地"),
    new Rule("CG-EL-02", FLAG_ELEVATION, _V,
        undefined,
        pyRe("\\bchmod\\b[^|;&]*\\b777\\b", "i"),
        "放开为全局可写（777）——权限松绑，配合递归时等于把文件系统向所有进程敞开"),
    new Rule("CG-PK-01", FLAG_PROCESS_KILL, _V,
        ["killall", "pkill", "taskkill"],
        undefined,
        "按名杀进程——误伤面大于按 pid 杀"),
    new Rule("CG-IR-01", FLAG_NETWORK, _V,
        undefined, undefined,
        "装包 = 把外部代码引入本机执行环境（依赖链风险）",
        _is_install_command),
    new Rule("CG-NG-01", FLAG_NETWORK, _V,
        ["ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet"],
        undefined,
        "主动建立对外连接/远端会话"),
    new Rule("CG-NG-03", FLAG_NETWORK, _V,
        ["ifconfig", "ipconfig", "iwconfig", "route"],
        undefined,
        "查看/改动网络接口与路由表——诊断常用，但 flush/改路由影响连通性"),
    new Rule("CG-FS-08", FLAG_SYSTEM_STATE, _V,
        ["umount", "fsck"],
        undefined,
        "卸载活动挂载/检查文件系统——时机不对会把用户正用着的卷摘下来"),
];

/** 取回工具词表（fetch_pipe_exec 的"取回"侧） */
export const _FETCHERS: string[] = ["curl", "curlie", "wget", "http", "httpie", "iwr",
    "invoke-webrequest", "invoke-restmethod", "fetch",
    "axel", "aria2c", "lynx", "w3m", "links",
    "xh", "http-prompt"];

/** 执行工具词表（"执行"侧——能直接解释执行输入流的解释器/shell） */
export const _EXECUTORS: string[] = ["sh", "bash", "zsh", "dash", "ksh", "powershell", "pwsh",
    "python", "python3", "node", "perl", "ruby", "php",
    "iex", "invoke-expression"];

/** 网络出口规则：命中取回/联网词的命令才做 host 级策略检查 */
export const _EGRESS_HINT_WORDS: string[] = _FETCHERS.concat(
    ["ssh", "scp", "sftp", "ftp", "nc", "ncat", "git",
        "ping", "rsync", "curl", "wget"]);

// ── 网络出口策略 ──────────────────────────────────────────────────────────────

/** 声明式出口策略：deny 恒胜；closed 模式下 allow 未命中 → REVIEW。 */
export class NetworkEgressPolicy {
    allow: string[];
    deny: string[];
    /** open = 白名单空时放行未知出口；closed = 白名单非空时未知出口要问。 */
    mode: string;

    constructor(allow?: string[] | null, deny?: string[] | null, mode?: string) {
        this.allow = allow === undefined ? [] : allow as string[];
        this.deny = deny === undefined ? [] : deny as string[];
        this.mode = mode === undefined ? "open" : mode;
    }

    static from_config(cfg: unknown): NetworkEgressPolicy {
        const c: JsonDict = (cfg !== null && typeof cfg === "object" && !Array.isArray(cfg))
            ? cfg as JsonDict : {};
        return new NetworkEgressPolicy(
            _norm_list(dictGet(c, "allow")),
            _norm_list(dictGet(c, "deny")),
            pyStr(pyOr(dictGet(c, "mode"), "open")).trim().toLowerCase(),
        );
    }

    /** 返回 [verdict, 命中host] 或 null（无异议）。
     *
     * deny 命中 → restricted；closed 且 allow 非空但无命中 → review；
     * 其余放行。
     */
    check(hosts: string[]): [string, string[]] | null {
        for (const h of hosts) {
            const hit = domainSuffixMatch(h, this.deny);
            if (pyTruth(hit)) return ["restricted", [h, hit as string]];
        }
        if (this.mode === "closed" && pyTruth(this.allow)) {
            for (const h of hosts) {
                if (!pyTruth(domainSuffixMatch(h, this.allow))) return ["review", [h, ""]];
            }
        }
        return null;
    }
}

/** `[str(x).strip().lower() for x in (v or []) if str(x).strip()]` */
function _norm_list(v: unknown): string[] {
    const items = pyIter(pyOr(v, []));
    const out: string[] = [];
    for (const x of items) {
        const s = pyStr(x).trim();
        if (pyTruth(s)) out.push(s.toLowerCase());
    }
    return out;
}

// ── 分级器 ────────────────────────────────────────────────────────────────────

export const _ALL_RULES: Rule[] = ([] as Rule[])
    .concat(_DESTRUCTIVE_RULES, _SYSTEM_RULES, _REMOTE_EXEC_RULES,
        _PERSISTENCE_RULES, _CREDENTIAL_RULES, _FIREWALL_RULES,
        _BOMB_RULES, _REVIEW_RULES);

/** 分级器作用的工具白名单——这些工具的 args 里装的是**命令文本**。
 *  不在此列的工具（read_file 等）内容不是命令，跳过机械解析。 */
export const SHELL_TOOLS = new Set<string>([
    "shell_executor", "bash", "run_command", "python_executor",
    "cmd", "powershell", "shell",
    // Carries a command line the same way the entries above do — risk_control
    // already treats it as one when extracting the command for its own checks.
    "native_action_chain",
]);

/** 命令文本可能落在的 args 键（不同工具命名不一致） */
export const _COMMAND_ARG_KEYS: string[] = ["command", "cmd", "script", "code", "expression", "commandline", "command_text"];

/** 一次命令分级的完整产物——audit/UI 消费这个，而不是裸 Tier。 */
export class CommandVerdict {
    tier: TierValue;
    flags: string[];
    matched: string[];   // rule ids
    hosts: string[];     // 文本中出现的 host
    segments: number;
    reasons: string[];

    constructor(tier: TierValue, flags?: string[] | null, matched?: string[] | null,
                hosts?: string[] | null, segments?: number, reasons?: string[] | null) {
        // field(default_factory=list) allocates a FRESH list per instance.
        this.tier = tier;
        this.flags = flags === undefined ? [] : flags as string[];
        this.matched = matched === undefined ? [] : matched as string[];
        this.hosts = hosts === undefined ? [] : hosts as string[];
        this.segments = segments === undefined ? 0 : segments;
        this.reasons = reasons === undefined ? [] : reasons as string[];
    }

    to_dict(): JsonDict {
        return {
            "tier": enumValue(this.tier, TIER_VALUES),
            "flags": this.flags,
            "matched": this.matched,
            "hosts": this.hosts,
            "segments": this.segments,
            "reasons": this.reasons,
        };
    }

    get is_restricted(): boolean {
        return this.tier === Tier.RESTRICTED;
    }

    get needs_review(): boolean {
        return this.tier === Tier.REVIEW;
    }
}

/** 从工具参数里取命令文本。找不到返回空串（= 无内容可分级）。 */
export function _command_text(args: unknown): string {
    for (const key of _COMMAND_ARG_KEYS) {
        const val = getAttr(args, key);
        if (typeof val === "string" && pyTruth(val.trim())) return val;
    }
    return "";
}

/** IPv4 literal pattern, same text as the adapter's (used by the fallback below). */
const RE_IPV4_FALLBACK = pyRe("\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", "g");

/**
 * 对一段命令文本做完整分级。纯函数；不抛异常（畸形输入→ALLOW 空旗标）。
 *
 * 级别合成规则：RESTRICTED > REVIEW > ALLOW——任一规则命中即抬升，
 * 旗标与命中规则累加，全部进 verdict 供审计。
 */
export function classify(command: unknown, opts?: { egress?: NetworkEgressPolicy | null }): CommandVerdict {
    const egress = opts === undefined ? null : (opts.egress ?? null);
    const verdict = new CommandVerdict(Tier.ALLOW);
    const text = pyStr(pyOr(command, ""));
    if (!pyTruth(text.trim())) return verdict;

    let segments: string[];
    try {
        segments = splitSegments(text);
    } catch {
        segments = [text];
    }
    verdict.segments = segments.length;
    const tokens: string[] = [];
    for (const seg of segments) {
        try {
            for (const t of tokenize(seg)) tokens.push(t.toLowerCase());
        } catch {
            for (const t of pySplit(seg.toLowerCase())) tokens.push(t);
        }
    }

    // 1) 规则表（词表与正则两条命中路径都在 Rule.hit 里，缺一不可——
    //    这里曾有"regex is None 就跳过"的守卫，把全部词表规则静默丢掉了）
    for (const rule of _ALL_RULES) {
        try {
            if (rule.hit(tokens, text)) _absorb(verdict, rule);
        } catch {
            continue;  // 单条规则坏了不拖垮整体——宁缺勿崩
        }
    }

    // 2) 远程取回直执行的机械形态（RESTRICTED，见 CG-RX-01 的 why）。
    //    两个形态面都要看：段内的命令替换（$(curl …|sh) 由适配层判定），
    //    以及**跨段**的管道顺序（`curl x | sh` 被管道拆成两段后，
    //    "取回在前、执行在后"的顺序关系只有整段序列能看见）。
    try {
        let saw_fetch_seg = false;
        let hit_remote_exec = false;
        for (const seg of segments) {
            if (fetchPipeExec(seg, _FETCHERS, _EXECUTORS)) {
                hit_remote_exec = true;
                break;
            }
            const seg_tokens = tokenize(seg).map((t) => t.toLowerCase());
            if (seg_tokens.some((t) => _FETCHERS.includes(t))) {
                saw_fetch_seg = true;
            } else if (saw_fetch_seg && seg_tokens.some((t) => _EXECUTORS.includes(t))) {
                hit_remote_exec = true;
                break;
            }
        }
        if (hit_remote_exec) {
            if (!verdict.flags.includes(FLAG_REMOTE_EXEC)) {
                verdict.flags.push(FLAG_REMOTE_EXEC);
                verdict.matched.push("CG-RX-01");
                verdict.reasons.push((_REMOTE_EXEC_RULES[0] as Rule).why);
            }
            verdict.tier = Tier.RESTRICTED;
        }
    } catch {
        /* pass */
    }

    // 3) 网络出口策略（deny 恒胜 > closed 白名单外要问）
    // 抽取器不可用绝不能让整条命令"看不见出口"——那是把一次故障变成一次静默
    // 放行。退到 IPv4 正则：域名这一维会漏，但取回词（curl/wget…）与装包表
    // 仍在，最坏是少问一次而不是全瞎。
    let hosts: string[];
    try {
        const raw = pyOr(extractHosts(text), []) as string[];
        hosts = Array.from(new Set(raw));
    } catch {
        try {
            const found: string[] = [];
            for (const m of text.matchAll(new RegExp(RE_IPV4_FALLBACK.source, "gu"))) {
                found.push(m[0] as string);
            }
            hosts = Array.from(new Set(found));
        } catch {
            hosts = [];
        }
    }
    verdict.hosts = hosts;
    if (pyTruth(hosts)) {
        // 有出口意图 → 至少 REVIEW 级的网络旗标（级别抬升由 egress 裁决决定，
        // 裸出现 host 不抬级——`pip install` 已有 CG-IR-01 兜着）
        if (!verdict.flags.includes(FLAG_NETWORK)) verdict.flags.push(FLAG_NETWORK);
        const policy = egress !== null && egress !== undefined ? egress : get_egress_policy();
        let outcome: [string, string[]] | null;
        try {
            outcome = policy.check(hosts);
        } catch {
            outcome = null;
        }
        if (pyTruth(outcome)) {
            const kind = (outcome as [string, string[]])[0];
            const detail = (outcome as [string, string[]])[1];
            if (kind === "restricted") {
                verdict.tier = Tier.RESTRICTED;
                verdict.matched.push("CG-EG-DENY");
                verdict.reasons.push(`网络出口命中拒绝名单: ${detail[0]} (规则 ${detail[1]})`);
            } else if (verdict.tier !== Tier.RESTRICTED) {
                verdict.tier = Tier.REVIEW;
                verdict.matched.push("CG-EG-CLOSED");
                verdict.reasons.push(`closed 模式下出口不在白名单: ${detail[0]}`);
            }
        }
    }

    // 4) 级别合成（旗标已在上面逐条累加）
    return verdict;
}

function _absorb(verdict: CommandVerdict, rule: Rule): void {
    if (!verdict.flags.includes(rule.flag)) verdict.flags.push(rule.flag);
    verdict.matched.push(rule.rule_id);
    if (pyTruth(rule.why)) verdict.reasons.push(rule.why);
    if (rule.tier === Tier.RESTRICTED) {
        verdict.tier = Tier.RESTRICTED;
    } else if (rule.tier === Tier.REVIEW && verdict.tier !== Tier.RESTRICTED) {
        verdict.tier = Tier.REVIEW;
    }
}

// ── 配置加载（进程内单份，与 risk_controller 的 config 读取同款纪律） ─────────

/** python computes `os.path.dirname(os.path.abspath(__file__)) + "/../config.json"`
 *  inline at each read. Behind the seam lives exactly that path: engine/ and
 *  backend/ both sit one level under app/, so the default resolves to the same
 *  file either language reads. The override exists so the dual probe (and a
 *  settings page) can point the two caches at a document without touching the
 *  shipped config.json; the python side gets the same lever by rebinding
 *  `__file__`. Default behaviour is byte-identical. */
export const CLASSIFIER_SEAMS = {
    configPath: (): string => path.resolve(
        path.dirname(url.fileURLToPath(import.meta.url)), "..", "config.json"),
};

function _config_json(): unknown {
    return JSON.parse(fs.readFileSync(CLASSIFIER_SEAMS.configPath(), "utf-8"));
}

let _egress: NetworkEgressPolicy | null = null;

/** config.json `permissions.network` → 出口策略。坏配置=默认 open。 */
export function get_egress_policy(): NetworkEgressPolicy {
    if (_egress === null) {
        try {
            const cfg = pyOr(getAttr(_config_json(), "permissions"), {}) as JsonDict;
            _egress = NetworkEgressPolicy.from_config(getAttr(cfg, "network"));
        } catch {
            _egress = new NetworkEgressPolicy();
        }
    }
    return _egress;
}

/** 设置页改完配置后调用——主动失效缓存。 */
export function reload_egress_policy(): NetworkEgressPolicy {
    _egress = null;
    return get_egress_policy();
}

// ── 策略管道层 ────────────────────────────────────────────────────────────────

/** 分级结果在 request.context 里的缓存键（同一次调用的后续层/审计复用） */
export const _CONTEXT_VERDICT_KEY = "_command_verdict";

// ── RESTRICTED 的处置动作（渐进收紧） ──────────────────────────────────────────
//
// 规则表收的是形态，形态必然有交集：`rm -rf /tmp/build` 和 `rm -rf /` 命中
// 同一条 fs-destructive 规则，前者是日常操作、后者是事故。分级器是新增能力，
// 没有线上语料校准误报率，所以第一版 RESTRICTED 统一走 ASK：宁可多问一次，
// 不可误杀一条正常命令打断工作流。等误报收敛后把 `restrictedAction` 切成
// "deny" 即可收紧，无需改结构。

export const _DEFAULT_RESTRICTED_ACTION = "ask";

let _restricted_action_cache: string | null = null;

/** config.json `permissions.commandGuard.restrictedAction` → "ask" | "deny"。 */
export function _restricted_action(): string {
    if (_restricted_action_cache === null) {
        let action = _DEFAULT_RESTRICTED_ACTION;
        try {
            const permissions = pyOr(getAttr(_config_json(), "permissions"), {}) as JsonDict;
            const guard = pyOr(getAttr(permissions, "commandGuard"), {}) as JsonDict;
            const raw = pyStr(getAttr(guard, "restrictedAction", "")).trim().toLowerCase();
            if (raw === "ask" || raw === "deny") action = raw;
        } catch {
            action = _DEFAULT_RESTRICTED_ACTION;  // 坏配置退回宽松档，不静默变严
        }
        _restricted_action_cache = action;
    }
    return _restricted_action_cache;
}

/** 设置页改完配置后调用——主动失效缓存，返回当前生效动作。 */
export function reload_command_guard_config(): string {
    _restricted_action_cache = null;
    return _restricted_action();
}

/** COMMAND 层：对命令类工具做内容分级，REVIEW→ASK；RESTRICTED→ASK/DENY 可配。
 *
 * 层工厂而不是闭包直连：risk_control 在 _install_layers 里注册，测试里
 * 可以独立构造。层内异常由管道兜底（fail-safe = deny）。
 */
export function make_command_guard_layer(): PolicyLayerFn {
    return function _layer(req: PolicyRequest): PolicyDecision | null {
        if (!SHELL_TOOLS.has(req.tool_name)) return null;
        const text = _command_text(req.args);
        if (!pyTruth(text)) return null;
        const verdict = classify(text);
        try {
            setItem(req.context, _CONTEXT_VERDICT_KEY, verdict.to_dict());
        } catch {
            /* context 可能不可写——审计丢了但不影响裁决 */
        }

        if (verdict.is_restricted) {
            const deny = _restricted_action() === "deny";
            return new PolicyDecision(
                deny ? PolicyAction.DENY : PolicyAction.ASK,
                PolicyLayer.COMMAND,
                "command-guard:restricted",
                (deny ? "命令命中高危形态（" : "命令命中高危形态，需确认后执行（") +
                verdict.reasons.slice(0, 3).join("；") + "）",
            );
        }
        if (verdict.needs_review) {
            return new PolicyDecision(
                PolicyAction.ASK,
                PolicyLayer.COMMAND,
                "command-guard:review",
                "命令需要确认（" + verdict.reasons.slice(0, 3).join("；") + "）",
            );
        }
        return null;
    };
}

/** 从工具上下文里取回本次分级的 verdict（审计/展示用）。 */
export function last_verdict(context: unknown): JsonDict | null {
    if (context === null || typeof context !== "object" || Array.isArray(context)) return null;
    const v = dictGet(context, _CONTEXT_VERDICT_KEY);
    return (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as JsonDict : null;
}

// PORT STATUS: confidence=high todos=[0]

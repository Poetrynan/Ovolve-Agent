/**
 * skill_loader.ts — Skill import framework with security checks (core).
 *
 * Port of app/backend/skill_loader.py (1128 lines).
 *
 * Does NOT preload any skills. Only imports and manages on-demand.
 * Import flow: structure check -> frontmatter parse -> security checks ->
 * progressive disclosure loading.
 *
 * # SKILL.md 统一格式（B1）
 *
 *     ---
 *     name: my-skill                    # 必填，稳定标识
 *     description: 什么时候该用它         # 必填，<=1024 字符，是触发信号
 *     version: 2.1.0                    # 选填，人写的语义化版本（展示用）
 *     user-invocable: true              # 选填，默认 true —— 用户能否手动调用
 *     disable-model-invocation: false   # 选填，默认 false —— 禁止模型自动调用
 *     ---
 *
 *     正文 markdown……
 *
 * **version 的真正身份是内容哈希**，不是 frontmatter 里那个字符串。
 * `SkillEntry.version` = sha256(SKILL.md 全文)[:16]，由系统自动算出；
 * frontmatter 里人写的那个保留在 `declared_version`，只用于展示。
 *
 * 为什么这么定：手写版本号永远会忘记改。技能改了内容但版本号没动，缓存
 * 就认不出来该重载，用户看到的是"我明明改了文件但行为没变"。内容哈希让
 * "改了一个字" 和 "换了个版本" 是同一件事，热更新/缓存失效/技能市场的
 * 完整性校验共用这一个值。
 *
 * Security checks (from real-world audit findings):
 * 1. Prompt injection detection (skip tests / ignore instructions patterns)
 * 2. XSS/dangerous markup detection (onerror/onload, script tags)
 * 3. Credential scanning (hardcoded API keys/tokens)
 * 4. Reference integrity check (scripts/references must exist)
 * 5. Ethical/attack content flagging (jailbreak/anti-distill)
 *
 * RULEBOOK CITATIONS
 *   §1  deps: node builtins only (fs/path/crypto) + ported engine modules
 *   §2  Python Enum → string-valued const maps (SkillStatus/TrustLevel);
 *       `entry.status.value` 形态由字符串本身承担，消费方（workflow_evolution/
 *       scheduler/diagnostics 的既有 seam）按字符串比较——已与其声明的类型一致
 *   §4  naming: unit keeps source export names verbatim (snake_case)
 *
 * PORT STATUS: n/a (trailer at file end)
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as crypto from "node:crypto";

import { Result } from "./result.js";
import { get_storage } from "./storage.js";
import { attribution_from } from "./attribution.js";
import { verify_skill_dir } from "./skill_integrity.js";
import { wrap_untrusted } from "./active_memory.js";
import { get_model_registry } from "./model_registry_impl.js";
import { pyJsonDumps } from "./storage/storage_funcs.js";
import { homeDir } from "./user_dirs.js";

/** Storage 的 skills 域在运行时挂载（storage/domains/skills.ts）；此处只声明
 * 本源用到的方法形状。 */
interface SkillsStorageLike {
    list_skill_candidates(status?: string | null, limit?: number): Record<string, unknown>[];
}

/** 内容哈希取前 16 个 hex 字符（64 bit）。碰撞概率在技能库这个量级
 * （即使十万个技能）也远低于磁盘静默损坏，而 16 字符在日志/UI 里还读得下去。 */
export const CONTENT_HASH_LEN = 16;

/** frontmatter 里的布尔字段，以及它们的默认值。
 * 键同时接受连字符和下划线写法 —— YAML 世界里两种都常见，
 * 让写技能的人不用记我们内部用的是哪种。
 *
 * 可见性三维（B3）—— 三个互相独立的布尔，不是一个枚举：
 *   · include-in-runtime-registry      能不能被调用（进不进运行时注册表）
 *   · include-in-available-skills-prompt  要不要出现在 prompt 的技能清单里
 *   · user-invocable                   用户能不能在 UI 里手动点它
 *
 * 为什么必须独立而不是一个"可见性等级"：真实需求里这三者的组合是交叉的。
 *   · 内部自动技能：能调用 + 进 prompt + 用户看不见
 *   · 用户专属工具：能调用 + 不进 prompt（省 token）+ 用户能点
 *   · 临时停用：不能调用 + 不进 prompt + 用户看不见（但配置还留着）
 * 用等级表达就得为每种组合造一个新等级，最后等级比布尔还难记。
 * Map 形态：Python dict 的 get 不会命中 Object.prototype 键。 */
export const BOOLEAN_FIELDS: ReadonlyMap<string, boolean> = new Map<string, boolean>([
    ["user-invocable", true],              // 用户能不能在 UI 里手动点它
    ["disable-model-invocation", false],   // 是否禁止模型自动挑它（旧字段，兼容保留）
    ["include-in-runtime-registry", true], // 进不进运行时注册表
    ["include-in-available-skills-prompt", true], // 进不进 prompt 技能清单
]);

const _TRUTHY = new Set(["true", "yes", "on", "1"]);
const _FALSY = new Set(["false", "no", "off", "0"]);

/** SKILL.md 全文的 sha256 前缀 —— 技能的真正版本号。
 *
 * 对全文（含 frontmatter）取哈希，不是只对正文：改 description 也该算
 * 新版本，因为 description 是触发信号，改了它技能的行为就变了。
 */
export function compute_content_hash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, CONTENT_HASH_LEN);
}

/** Python str.strip()（默认全部空白字符）的等价实现。 */
function pyStrip(s: string): string {
    return s.replace(/^[\s\u000b\u001c\u001d\u001e\u001f]+|[\s\u000b\u001c\u001d\u001e\u001f]+$/g, "");
}

/** Python str.rstrip(chars) 的定点实现。 */
function pyRstripChars(s: string, chars: string): string {
    let end = s.length;
    while (end > 0 && chars.includes(s[end - 1] as string)) end--;
    return s.slice(0, end);
}

/** Python str(codepoint)[:n] 的等价截断（JS length 是 UTF-16 单元数）。 */
function pySlice(s: string, n: number): string {
    return Array.from(s).slice(0, n).join("");
}

/** Python len() 的码点计数。 */
function pyLen(s: string): number {
    return Array.from(s).length;
}

/** 把 frontmatter 里的字符串解析成布尔。无法判断时回落到 default。
 *
 * 刻意不把"任何非空字符串"当真：`user-invocable: no` 是明确的否，
 * naive 实现会把它读成真，然后一个作者标记为"别露出来"的技能就出现在
 * 用户菜单里了。
 */
export function normalize_bool(value: unknown, default_val: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (value === null || value === undefined) return default_val;
    const text = pyStrip(String(value)).replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "").toLowerCase();
    if (_TRUTHY.has(text)) return true;
    if (_FALSY.has(text)) return false;
    return default_val;
}

/** 读一个布尔字段，连字符/下划线两种写法都认。 */
export function read_bool_field(frontmatter: Record<string, unknown>, key: string): boolean {
    const default_val = (BOOLEAN_FIELDS.get(key) ?? false) as boolean;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
        return normalize_bool(frontmatter[key], default_val);
    }
    const alt = key.replace(/-/g, "_");
    if (Object.prototype.hasOwnProperty.call(frontmatter, alt)) {
        return normalize_bool(frontmatter[alt], default_val);
    }
    return default_val;
}

function _unquote(text: string): string {
    const t = pyStrip(text);
    if (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === '"' || t[0] === "'")) {
        return t.slice(1, -1);
    }
    return t;
}

/** 解析 YAML inline flow 序列：`["a", "b"]` 或 `[a, b]`。
 *
 * 刻意不用 JSON 解析：真实技能文件里 `[python3, chromium]`（无引号）
 * 非常常见，那不是合法 JSON，但在 YAML 里完全正确。
 */
export function parse_flow_list(text: string): string[] {
    let inner = pyStrip(text);
    if (inner.startsWith("[") && inner.endsWith("]")) {
        inner = inner.slice(1, -1);
    }
    return inner.split(",").map((p) => _unquote(p)).filter((p) => p.length > 0);
}

/** 读一个列表字段。已经是 list 就直接返回，字符串则按 flow 序列解析。
 *
 * 连字符/下划线两种写法都认，和 read_bool_field 保持一致。
 */
export function read_list_field(frontmatter: Record<string, unknown>, key: string): string[] {
    for (const candidate of [key, key.replace(/-/g, "_")]) {
        if (!Object.prototype.hasOwnProperty.call(frontmatter, candidate)) continue;
        const value = frontmatter[candidate];
        if (Array.isArray(value)) {
            return value.map((v) => pyStrip(String(v))).filter((s) => s.length > 0);
        }
        if (typeof value === "string" && pyStrip(value).length > 0) {
            return parse_flow_list(value);
        }
    }
    return [];
}

/** SKILL.md `requires:` 目前支持的模型能力名。只做这张表里的过滤——
 * 未声明 = 无要求（向后兼容全部旧技能）。将来加新能力值时同步扩这张表。 */
export const KNOWN_MODEL_REQUIREMENTS: ReadonlySet<string> = new Set(["vision", "tools"]);

/** 当前模型不满足的能力要求列表。
 *
 * `capability` 是 model_registry.resolve() 的载荷（含 supports_vision /
 * supports_tools）。**空 capability = 无法判断 = 不过滤**（fail-open）：
 * 模型信息拿不到时把技能全藏起来，比让它们多露一次的伤害大。
 */
export function unmet_model_requirements(requires: readonly unknown[], capability: Record<string, unknown>): string[] {
    if ((!requires || requires.length === 0) || !capability || Object.keys(capability).length === 0) {
        return [];
    }
    const unmet: string[] = [];
    for (const req of requires) {
        const key = pyStrip(String(req)).toLowerCase();
        if (key === "vision" && !capability["supports_vision"]) {
            unmet.push(key);
        } else if (key === "tools" && !capability["supports_tools"]) {
            unmet.push(key);
        }
    }
    return unmet;
}

/** 当前活跃模型的能力载荷。拿不到（未配置/异常）返回空 dict = 不过滤。 */
export function current_model_capability(): Record<string, unknown> {
    try {
        const r = get_model_registry().resolve();
        if (r && r.ok && r.value && typeof r.value === "object" && !Array.isArray(r.value)) {
            return r.value as Record<string, unknown>;
        }
    } catch {
        /* fail-open: 能力不可知时不做过滤 */
    }
    return {};
}

/** Python Enum(str) 的移植形态：成员值即字符串（见 RULEBOOK §2 头注）。 */
export const TrustLevel = {
    OWN: "own",
    VERIFIED: "verified",
    UNTRUSTED: "untrusted",
} as const;
export type TrustLevel = (typeof TrustLevel)[keyof typeof TrustLevel];

export const SkillStatus = {
    IMPORTED: "imported",
    DISABLED: "disabled",
    DROPPED: "dropped", // Fatal: not importable
    BROKEN: "broken",   // Loads but won't trigger
} as const;
export type SkillStatus = (typeof SkillStatus)[keyof typeof SkillStatus];

// ── 开放技能标准（Open Skills）合规校验 ──────────────────────────────────────
// 目标：外部按开放标准编写的技能包导入时，能拿到一份机器可读的合规清单
// （徽章 + 问题列表），而不是"能跑但不知道差在哪"。校验是提示性打标，不
// 拦截导入——合规性与可用性是两个维度。

const _OPEN_STANDARD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const _OPEN_STANDARD_SEMVER_RE = /^v?\d+\.\d+\.\d+$/;
const _OPEN_STANDARD_PLATFORMS: ReadonlySet<string> = new Set(["macos", "linux", "windows"]);

/** 按开放技能标准校验 frontmatter，返回合规清单。
 *
 * 检查项：name（小写字母/数字/连字符，≤64 字符）、description 单句且
 * ≤1024 字符、version（若填写须语义化 x.y.z）、platforms（若声明，必须
 * 是已知平台子集）。缺失字段不扣分——缺失由 drop 规则负责，合规只管
 * "写了就要对"。
 */
export function check_open_standard_compliance(frontmatter: Record<string, unknown>): { compliant: boolean; issues: string[] } {
    const issues: string[] = [];
    const name = String(frontmatter["name"] ?? "");
    if (name && !_OPEN_STANDARD_NAME_RE.test(name)) {
        issues.push("name 应为小写字母/数字/连字符且不超过 64 字符");
    }
    const description = String(frontmatter["description"] ?? "");
    if (description && (description.includes("\n") || pyLen(description) > 1024)) {
        issues.push("description 应为单句且不超过 1024 字符");
    }
    const version = String(frontmatter["version"] ?? "");
    if (version && !_OPEN_STANDARD_SEMVER_RE.test(version)) {
        issues.push("version 应为语义化版本（x.y.z）");
    }
    const platforms = frontmatter["platforms"];
    if (platforms) {
        const vals = Array.isArray(platforms) ? platforms : [platforms];
        const bad = vals.map((v) => String(v)).filter((v) => !(_OPEN_STANDARD_PLATFORMS.has(pyStrip(v).toLowerCase())));
        if (bad.length > 0) {
            issues.push(`platforms 含未知平台: ${bad.join(",")}`);
        }
    }
    return { compliant: issues.length === 0, issues };
}

/** 归属常量。市场装的技能写来源仓库名（如 "github.com/..."），
 * 内置的写 OWNER_CORE，用户/项目自己写的写 OWNER_USER。 */
export const OWNER_CORE = "ovolve-core";
export const OWNER_USER = "user";
export const OWNER_UNKNOWN = "unknown";

/** frontmatter 里作者可以自报归属。两个键都读：`owner-agents` 是复数形式，
 * `owner` 是单数简写（开放技能标准里没有这一项，是这里的扩展）。 */
const _OWNER_KEYS = ["owner-agents", "owner_agents", "owner"];

/** 读 frontmatter 里的归属声明。读不到返回空列表——空表示"没声明"，
 * 由安装侧按来源补；**不猜**，猜出来的归属比没有归属更误导。 */
export function read_owner_agents(frontmatter: unknown): string[] {
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
        return [];
    }
    const fm = frontmatter as Record<string, unknown>;
    for (const key of _OWNER_KEYS) {
        const raw = fm[key];
        if (raw === null || raw === undefined) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        const out = values.map((v) => pyStrip(String(v))).filter((s) => s.length > 0);
        if (out.length > 0) return out;
    }
    return [];
}

/** 这个候选是不是"本地声明的"（用户/项目自己写的，而非市场装的）。
 *
 * 只用于同分时的 tie-break：本地写的技能能被用户直接改，市场装的改了会被
 * 下次更新覆盖，所以同分时先看本地的更符合用户预期。
 */
function _owner_is_local(candidate: { owner_agents?: unknown }): boolean {
    const raw = (candidate["owner_agents"] ?? []) as unknown[];
    const owners = raw.map((o) => String(o).toLowerCase());
    if (owners.length === 0) return false;
    return owners.some((o) => o === OWNER_CORE || o === OWNER_USER);
}

export class SkillEntry {
    name: string;
    path: string;
    description: string;
    /** 系统认定的版本号 —— 内容哈希（sha256 前 16 字符）。
     * 由 import_skill 在读完文件后自动填充；构造函数默认空串。 */
    version: string;
    /** frontmatter 里作者写的版本号（如 "2.1.0"），仅用于展示。
     * 系统内部一切缓存/热更新/版本比对都用 this.version 那个哈希。 */
    declared_version: string;
    trust: TrustLevel;
    status: string;
    frontmatter: Record<string, unknown>;
    body: string;
    errors: unknown[];
    warnings: unknown[];
    source: string;
    // ── 可见性三维（B3）──
    /** 用户能否手动调用这个技能（UI 里的技能菜单是否显示）。默认真。 */
    user_invocable: boolean;
    /** 是否禁止模型自动挑选它。默认假（允许模型挑）。旧字段，保留兼容。 */
    disable_model_invocation: boolean;
    /** 能不能被调用（进不进运行时注册表）。默认真。 */
    include_in_runtime_registry: boolean;
    /** 要不要出现在 prompt 的技能清单里（B2 渐进披露的 Stage 1）。默认真。 */
    include_in_available_skills_prompt: boolean;
    // ── 触发与依赖（B6）──
    /** 触发词。用户消息含任一即视为强相关，优先加载它的 body（Stage 2）。 */
    triggers: string[];
    /** 必需的可执行文件（PATH 里全都要有）。缺一个技能就 BROKEN。 */
    requires_bins: string[];
    /** 任一即可的可执行文件（至少要有一个）。都缺才 BROKEN。 */
    requires_any_bins: string[];
    /** agentskills.io allowed-tools 声明（工具白名单提示）。 */
    allowed_tools: string[];
    /** 模型能力要求（frontmatter `requires:`，如 ["vision"]）。声明了模型
     * 不具备的能力时，技能在**推荐/可见性**层被过滤——不做硬拦截，用户
     * 手动调用始终可用（能力三态声明可被用户覆盖，见 model_registry）。 */
    requires: string[];
    license: string;
    // ── 归属与许可 ──
    // license / author 优先取 frontmatter 的声明；声明缺失时才去技能目录里
    // 读 LICENSE* / NOTICE* 推断（见 attribution.ts）。copyright 始终来自
    // 文件本身——它是"这个包里写着谁"的证据，不是谁自称的。
    /** 上游主页/仓库地址，frontmatter 的 homepage / upstream / source。 */
    author: string;
    upstream: string;
    copyright: string;
    /** license 是从目录里的许可文件推断出来的（而非 frontmatter 声明）。
     * 区分两者是为了让人知道这个结论有多硬。 */
    license_from_file: boolean;
    compatibility: string;
    /** 归属：谁声明了这个技能。复数——同一个技能可以被多个 agent/仓库声明
     * （市场装了一份，项目里又自己改了一份）。
     * 用于"冲突时谁优先""卸载时能不能删""出错时找谁"。
     * 🔴 归属只做**兜底 tie-break**，不参与任何显式规则的否决：它排在
     * 可见性、信任级、状态、BROKEN/降级这些判定之后（见 recommend 的排序键）。
     * 让归属反过来盖掉一条显式规则，等于把"谁写的"变成"谁说了算"。 */
    owner_agents: string[];
    /** 依赖检查报告。给前端 env.fix 建议用。 */
    requires_report: Record<string, unknown>;
    /** 开放技能标准合规清单（由 check_open_standard_compliance 填充）。 */
    standard_compliant: { compliant: boolean; issues: string[] } | null;

    constructor(
        name: string,
        path: string,
        description: string = "",
        version: string = "",
        trust: TrustLevel = TrustLevel.UNTRUSTED,
    ) {
        this.name = name;
        this.path = path;
        this.description = description;
        this.version = version;
        this.declared_version = "";
        this.trust = trust;
        this.status = SkillStatus.IMPORTED;
        this.frontmatter = {};
        this.body = "";
        this.errors = [];
        this.warnings = [];
        this.source = "";
        this.user_invocable = true;
        this.disable_model_invocation = false;
        this.include_in_runtime_registry = true;
        this.include_in_available_skills_prompt = true;
        this.triggers = [];
        this.requires_bins = [];
        this.requires_any_bins = [];
        this.allowed_tools = [];
        this.requires = [];
        this.license = "";
        this.author = "";
        this.upstream = "";
        this.copyright = "";
        this.license_from_file = false;
        this.compatibility = "";
        this.owner_agents = [];
        this.requires_report = {};
        this.standard_compliant = null;
    }
}

// Injection patterns (real-world cases)
const INJECTION_PATTERNS: readonly RegExp[] = [
    /skip\s+all\s+tests/i,
    /do\s+not\s+scan/i,
    /ignore\s+(previous|prior)\s+instructions/i,
    /管理员请求/i,
    /you\s+are\s+(now|actually)\s+(an?|the)\s+(admin|root|developer)/i,
    /forget\s+(your|all)\s+(rules|instructions|guidelines)/i,
    /reveal\s+(your|the)\s+(system\s+)?prompt/i,
];

// XSS/dangerous markup patterns
const XSS_PATTERNS: readonly RegExp[] = [
    /<script[^>]*>/i,
    /onerror\s*=/i,
    /onload\s*=/i,
    /javascript:/i,
    /<iframe[^>]*>/i,
    /document\.cookie/i,
];

// Credential patterns
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
    /sk-[a-zA-Z0-9]{20,}/,       // OpenAI-style keys
    /[a-f0-9]{32}/,              // MD5-like hex strings
    /[a-f0-9]{40}/,              // SHA1-like hex strings
    /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    /AKIA[A-Z0-9]{16}/,          // AWS keys
];

// Attack/ethical content patterns
const ATTACK_PATTERNS: readonly RegExp[] = [
    /anti.?distill/i,
    /jailbreak/i,
    /越狱/i,
    /bypass\s+(safety|filter|guard)/i,
];

/** Python `open(..., errors="ignore")` / `errors="replace"` 的字节级等价解码。
 * 无效字节序列按逐字节粒度丢弃/替换 —— 与 CPython utf-8 错误处理器的
 * "每个 malformed 字节一个标记"粒度一致。 */
function decode_py_utf8(buf: Buffer, mode: "ignore" | "replace"): string {
    let out = "";
    let i = 0;
    while (i < buf.length) {
        const b = buf[i] as number;
        if (b <= 0x7f) {
            out += String.fromCharCode(b);
            i += 1;
            continue;
        }
        let need = 0;
        let cp = 0;
        let lo = 0;
        if ((b & 0xe0) === 0xc0) { need = 1; cp = b & 0x1f; lo = 0x80; }
        else if ((b & 0xf0) === 0xe0) { need = 2; cp = b & 0x0f; lo = 0x800; }
        else if ((b & 0xf8) === 0xf0) { need = 3; cp = b & 0x07; lo = 0x10000; }
        else { if (mode === "replace") out += "\uFFFD"; i += 1; continue; }
        let ok = true;
        let acc = 0;
        for (let k = 1; k <= need; k++) {
            const cb = buf[i + k];
            if (cb === undefined || (cb & 0xc0) !== 0x80) { ok = false; break; }
            acc = (acc << 6) | (cb & 0x3f);
        }
        const full = (cp << (6 * need)) | acc;
        if (!ok || full < lo || full > 0x10ffff || (full >= 0xd800 && full <= 0xdfff)) {
            if (mode === "replace") out += "\uFFFD";
            i += 1;
            continue;
        }
        out += String.fromCodePoint(full);
        i += need + 1;
    }
    return out;
}

/** Python shutil.which 的等价实现（Windows 下按 PATHEXT 探测）。 */
function shutil_which(cmd: string): string | null {
    const is_win = process.platform === "win32";
    let names = [cmd];
    if (is_win && !cmd.includes(".")) {
        const pathext = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
        names = [cmd, ...pathext.map((e) => cmd + e)];
    }
    const dirs = (process.env["PATH"] ?? "").split(nodePath.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = nodePath.join(dir, name);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch {
                /* not here — keep probing */
            }
        }
    }
    return null;
}

/** Python sorted(str) 的码点序比较（JS 默认是 UTF-16 单元序，代理对处会分歧）。 */
function pyStrLess(a: string, b: string): number {
    const aa = Array.from(a);
    const bb = Array.from(b);
    const n = Math.min(aa.length, bb.length);
    for (let i = 0; i < n; i++) {
        const ca = aa[i]!.codePointAt(0)!;
        const cb = bb[i]!.codePointAt(0)!;
        if (ca !== cb) return ca < cb ? -1 : 1;
    }
    if (aa.length === bb.length) return 0;
    return aa.length < bb.length ? -1 : 1;
}

export class SkillLoader {
    /** Skill import framework: import, validate, manage on-demand. */
    _skills: Map<string, SkillEntry>;
    _storage: SkillsStorageLike;
    /** [降级技能名集合, 过期时间戳]。见 _degraded_skill_names。 */
    _degraded_cache: [Set<string>, number] | null;

    constructor() {
        this._skills = new Map<string, SkillEntry>();
        this._storage = get_storage() as unknown as SkillsStorageLike;
        this._degraded_cache = null;
    }

    /** Import a skill from a directory. Returns SkillEntry on success. */
    import_skill(skill_dir: string, trust: TrustLevel = TrustLevel.UNTRUSTED): Result {
        // Step 1: Structure check
        const skill_md = nodePath.join(skill_dir, "SKILL.md");
        if (!fs.existsSync(skill_md)) {
            return Result.failure(`SKILL.md not found in ${skill_dir}`);
        }

        // Step 2: Parse frontmatter
        let content: string;
        try {
            content = decode_py_utf8(fs.readFileSync(skill_md), "ignore");
        } catch (e) {
            return Result.failure(`Cannot read SKILL.md: ${e instanceof Error ? e.message : String(e)}`);
        }

        const [frontmatter, body] = this._parse_frontmatter(content);

        // Two-level failure model: Dropped (missing name/empty description)
        const name = (frontmatter["name"] ?? "") as string;
        const description = (frontmatter["description"] ?? "") as string;
        if (!name) {
            return Result.failure("Skill dropped: missing 'name' in frontmatter");
        }
        if (!pyStrip(description)) {
            return Result.failure("Skill dropped: empty 'description' in frontmatter");
        }
        if (pyLen(description) > 1024) {
            return Result.failure("Skill dropped: description exceeds 1024 characters");
        }

        // Version = content hash (B1). The frontmatter's declared version, if any,
        // is kept only for display; the hash is the identity used everywhere else.
        const content_hash = compute_content_hash(content);
        const entry = new SkillEntry(name, skill_dir, description, content_hash, trust);
        entry.declared_version = (frontmatter["version"] ?? "") as string;
        entry.frontmatter = frontmatter;
        entry.body = body;
        entry.source = skill_dir;
        entry.owner_agents = read_owner_agents(frontmatter);
        // Visibility triple (B3): three orthogonal booleans, all read once here
        // so downstream consumers never re-parse frontmatter. Old
        // `disable-model-invocation` is kept for back-compat; when it's true it
        // forces `include_in_available_skills_prompt` off (a skill the model
        // is banned from calling should not be advertised to the model).
        entry.user_invocable = read_bool_field(frontmatter, "user-invocable");
        entry.disable_model_invocation = read_bool_field(frontmatter, "disable-model-invocation");
        entry.include_in_runtime_registry = read_bool_field(frontmatter, "include-in-runtime-registry");
        entry.include_in_available_skills_prompt = read_bool_field(
            frontmatter, "include-in-available-skills-prompt",
        );
        if (entry.disable_model_invocation) {
            entry.include_in_available_skills_prompt = false;
        }
        // Triggers + requires (B6). Flat frontmatter keys rather than a nested
        // `requires: { bins:..., anyBins:... }` — the frontmatter parser
        // deliberately drops nested mappings (they used to leak into the top
        // level and clobber real keys), and flat keys work with existing skills
        // without a schema migration.
        entry.triggers = read_list_field(frontmatter, "triggers");
        entry.requires_bins = read_list_field(frontmatter, "requires-bins");
        entry.requires_any_bins = read_list_field(frontmatter, "requires-any-bins");
        entry.allowed_tools = read_list_field(frontmatter, "allowed-tools");
        if (!entry.allowed_tools.length) {
            entry.allowed_tools = read_list_field(frontmatter, "allowed_tools");
        }
        entry.requires = read_list_field(frontmatter, "requires").filter(
            (r) => KNOWN_MODEL_REQUIREMENTS.has(pyStrip(String(r)).toLowerCase()),
        );
        // 归属：声明优先，缺失时回落到目录里的 LICENSE*/NOTICE*。
        // 作者字段各家写法不一，逐个兜一遍再放弃。
        // 源里 `(frontmatter.get("metadata") or {}).get("author")`：若 metadata
        // 被解析成列表（块序列写法），Python 在这里抛 AttributeError——
        // 本移植同样不做兜底保护，让异常按源语义原样上抛（见 verified 记录）。
        const meta_raw = frontmatter["metadata"] ?? null;
        let meta_author = "";
        if (Array.isArray(meta_raw)) {
            throw new TypeError("'list' object has no attribute 'get'");
        }
        if (meta_raw && typeof meta_raw === "object") {
            meta_author = String((meta_raw as Record<string, unknown>)["author"] ?? "");
        }
        const attribution = attribution_from(
            skill_dir,
            String(frontmatter["license"] ?? ""),
            String(frontmatter["author"] ?? "") || meta_author,
            String(frontmatter["upstream"] ?? "") || String(frontmatter["homepage"] ?? "") || String(frontmatter["source"] ?? ""),
        );
        entry.license = attribution.license;
        entry.author = attribution.author;
        entry.copyright = attribution.copyright;
        entry.upstream = attribution.upstream;
        entry.license_from_file = attribution.licenseFromFile;
        entry.compatibility = String(frontmatter["compatibility"] ?? "");

        // Step 3: Security checks
        const security_result = this._security_check(entry);
        if (!security_result.ok) {
            // Trust gate: a skill the user placed on disk themselves (OWN) is
            // not a supply-chain threat — a scanner hit there is almost always a
            // false positive (a `<script>` in a code sample, a quoted "ignore
            // previous instructions" in defensive guidance). Downgrade to a
            // warning so the skill still loads. Imported/untrusted skills keep
            // the hard rejection.
            if (trust === TrustLevel.OWN) {
                entry.warnings.push(`Security note (not blocking, own skill): ${security_result.error}`);
            } else {
                entry.status = SkillStatus.DROPPED;
                entry.errors.push(security_result.error);
                this._skills.set(name, entry);
                return Result.failure(`Skill rejected: ${security_result.error}`);
            }
        }

        // Step 4: Reference integrity check
        const ref_result = this._check_references(entry);
        if (!ref_result.ok) {
            entry.status = SkillStatus.BROKEN;
            entry.warnings.push(ref_result.error);
        } else {
            entry.status = SkillStatus.IMPORTED;
        }

        // Step 5: Declared binary dependencies (B6). A skill whose tools aren't
        // installed loads BROKEN rather than DROPPED — the content is fine, the
        // environment isn't, and that's a fixable condition we can advise on.
        const req_result = this._check_requires(entry);
        if (!req_result.ok) {
            entry.status = SkillStatus.BROKEN;
            entry.warnings.push(req_result.error);
        }

        // Untrusted skills are disabled by default
        if (trust === TrustLevel.UNTRUSTED) {
            entry.status = SkillStatus.DISABLED;
        }

        // ── 供应链完整性核验（skills.lock，Handoff 2.2）──
        // 只对有锁记录的技能说话：discover 扫到的本机技能从未上锁，不评价
        // （用户手改自己的技能是预期行为）。核验不符 → 载入但打高优警告
        // （fail-open）：技能正文是会进模型上下文的内容，"悄悄加载被改过的
        // 技能"和"直接拒载"都不对——前者无感知，后者把可恢复的警告升级成
        // 事故。警告由 UI 显式提示，用户确认是本人修改后可重新锁定。
        let _integrity: ReturnType<typeof verify_skill_dir> = null;
        try {
            _integrity = verify_skill_dir(name, skill_dir);
        } catch {
            _integrity = null; // fail-open: 锁子系统故障不拦技能加载
        }
        if (_integrity && !_integrity.ok) {
            const _changed = Object.keys(_integrity.changed).sort(pyStrLess).slice(0, 3).join(", ");
            const _missing = [..._integrity.missing].sort(pyStrLess).slice(0, 3).join(", ");
            const _pieces: string[] = [];
            if (_changed) _pieces.push(`内容被修改: ${_changed}`);
            if (_missing) _pieces.push(`文件缺失: ${_missing}`);
            const _detail = _pieces.join("; ");
            entry.warnings.push(
                `完整性警告：与安装时的锁定基线不符（${_detail}）。` +
                "如果不是你本人修改的，请勿继续使用；确认是本人修改可在技能页重新锁定。",
            );
        }

        this._skills.set(name, entry);
        const compliance = check_open_standard_compliance(frontmatter);
        entry.standard_compliant = compliance; // 审计字段：不进序列化契约
        return Result.success({
            name: name,
            status: entry.status,
            trust: trust,
            standard_compliance: compliance,
        });
    }

    /** Parse the YAML frontmatter block of a SKILL.md.
     *
     * Hand-rolled rather than pulling in a YAML dependency, but it has to cover
     * the shapes real skills actually use. A naive `key: value` split silently
     * corrupted two of them:
     *
     * * **Block scalars** (`description: >` / `description: |` with the text on
     *   following indented lines) parsed to the literal `">"`. Since
     *   `import_skill` drops any skill with an empty description, a skill
     *   written that way was one whitespace change away from vanishing from
     *   the catalogue with no error.
     * * **Nested mappings** (`metadata:` then an indented `version:`) leaked
     *   the inner keys into the top level, so a nested `version` overwrote the
     *   real one.
     *
     * Handled: plain scalars, quoted scalars, `>`/`|` block scalars (both with
     * and without a `-`/`+` chomping indicator), nested mappings (kept out of
     * the top level), and `# comment` lines.
     *
     * Returns `[frontmatter, body]`. Empty frontmatter when there is no
     * frontmatter, in which case body is the original content.
     */
    _parse_frontmatter(content: string): [Record<string, unknown>, string] {
        if (!content.startsWith("---")) {
            return [{}, content];
        }
        // content.split("---", 2) — maxsplit 语义
        const parts: string[] = [];
        {
            let rest = content;
            let splits = 0;
            while (splits < 2) {
                const idx = rest.indexOf("---");
                if (idx === -1) break;
                parts.push(rest.slice(0, idx));
                rest = rest.slice(idx + 3);
                splits += 1;
            }
            parts.push(rest);
        }
        if (parts.length < 3) {
            return [{}, content];
        }
        const fm_text = parts[1]!.replace(/^[\n]+|[\n]+$/g, ""); // strip("\n")
        const body = pyStrip(parts[2]!);

        const fm: Record<string, unknown> = {};
        const lines = fm_text.split("\n");
        let i = 0;
        while (i < lines.length) {
            const raw = lines[i]!;
            const stripped = pyStrip(raw);
            // Blank lines and comments carry no key.
            if (!stripped || stripped.startsWith("#")) {
                i += 1;
                continue;
            }
            // Indented lines belong to a parent key we already consumed
            // (nested mapping). Skip them so they never reach the top level.
            if (raw.slice(0, 1) === " " || raw.slice(0, 1) === "\t") {
                i += 1;
                continue;
            }
            if (!stripped.includes(":")) {
                i += 1;
                continue;
            }

            const ci = stripped.indexOf(":");
            const key = pyStrip(stripped.slice(0, ci));
            const val = pyStrip(stripped.slice(ci + 1));

            // Block scalar: `>`/`|` optionally followed by a chomping
            // indicator. The value is every following more-indented line.
            if (val.length > 0 && (val[0] === ">" || val[0] === "|") &&
                (pyRstripChars(val, "-+0123456789") === ">" || pyRstripChars(val, "-+0123456789") === "|")) {
                const fold = val[0] === ">";
                const collected: string[] = [];
                i += 1;
                while (i < lines.length) {
                    const nxt = lines[i]!;
                    if (pyStrip(nxt) && !(nxt.slice(0, 1) ?? "").match(/\s/)) {
                        break; // dedented back to a sibling key
                    }
                    collected.push(pyStrip(nxt));
                    i += 1;
                }
                // Folded (`>`) joins with spaces; literal (`|`) keeps newlines.
                const joined = fold
                    ? collected.filter((c) => c.length > 0).join(" ")
                    : collected.join("\n");
                fm[key] = pyStrip(joined);
                continue;
            }

            // Block sequence (`key:` followed by more-indented `- item` lines)
            // → list[str]. A list written in standard YAML used to fall into
            // the nested-mapping skip and parse to "" — the skill loaded fine
            // but triggers/requires-bins silently came out empty, with no
            // error anywhere. read_list_field already accepts lists.
            if (!val) {
                const seq: string[] = [];
                let j = i + 1;
                while (j < lines.length) {
                    const nxt = lines[j]!;
                    if (!pyStrip(nxt)) {
                        j += 1;
                        continue;
                    }
                    const stripped_nxt = nxt.replace(/^\s+/, "");
                    if (stripped_nxt.startsWith("- ") || stripped_nxt === "-") {
                        const item = pyStrip(stripped_nxt.slice(1)).replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
                        if (item) seq.push(item);
                        j += 1;
                        continue;
                    }
                    break;
                }
                if (seq.length > 0) {
                    fm[key] = seq;
                    i = j;
                } else {
                    if (!(key in fm)) fm[key] = "";
                    i += 1;
                }
                continue;
            }

            fm[key] = val.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
            i += 1;
        }

        return [fm, body];
    }

    /** Run all security checks on skill content.
     *
     * Code samples inside fenced blocks and inline backticks are stripped
     * first — a doc showing `<script>` or `javascript:` in a code snippet is
     * illustrative, not an attack. Real prose-embedded markup still gets
     * caught.
     *
     * NOTE(源怪癖): `re.compile(r"(?i)skip all tests", re.IGNORECASE)` 这类
     * 双内联标志在 Python 3.11+ 会触发 DeprecationWarning 但语义不变，移植后
     * 天然是单个 /i。
     */
    _security_check(entry: SkillEntry): Result {
        let body = entry.body.replace(/```[\s\S]*?```/g, "");
        body = body.replace(/`[^`]*`/g, "");
        // json.dumps(ensure_ascii=False) 的移植：pyJsonDumps（默认非 ascii 原样输出）。
        // DIVERGENCE(port): 数字序列化形态 JSON.stringify≈repr，与 Python 对
        // frontmatter（纯字符串解析产物：str/str[]）而言字节一致。
        const content = body + " " + pyJsonDumps(entry.frontmatter);

        // 1. Prompt injection detection
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(content)) {
                return Result.failure("Prompt injection detected: pattern matched");
            }
        }

        // 2. XSS/dangerous markup detection
        for (const pattern of XSS_PATTERNS) {
            if (pattern.test(content)) {
                return Result.failure("XSS/dangerous markup detected");
            }
        }

        // 3. Credential scanning
        for (const pattern of CREDENTIAL_PATTERNS) {
            const matches = content.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
            if (matches) {
                entry.warnings.push(`Possible credentials found (${matches.length} matches) - review needed`);
                // Don't reject outright, just warn (might be example keys)
            }
        }

        // 4. Attack/ethical content
        for (const pattern of ATTACK_PATTERNS) {
            if (pattern.test(content)) {
                return Result.failure("Attack/jailbreak content detected");
            }
        }

        return Result.success("Security checks passed");
    }

    /** Check that referenced scripts/references/tools exist.
     *
     * Only explicit `$SKILL_DIR/<dir>` references count as a real dependency
     * — a prose mention of `references/aws.md` inside example markdown is
     * just documentation and shouldn't mark the skill broken.
     */
    _check_references(entry: SkillEntry): Result {
        const skill_dir = entry.path;
        for (const ref_dir of ["scripts", "references", "tools"]) {
            const ref_path = nodePath.join(skill_dir, ref_dir);
            if (entry.body.includes(`$SKILL_DIR/${ref_dir}`)) {
                if (!fs.existsSync(ref_path)) {
                    return Result.failure(`Reference directory missing: ${ref_dir}`);
                }
            }
        }
        return Result.success("References OK");
    }

    /** Verify the skill's declared binary dependencies are on PATH (B6).
     *
     * Two kinds of requirement, matching the real dependency shapes:
     * - `requires-bins`: ALL must be present (a skill needs both git AND node)
     * - `requires-any-bins`: AT LEAST ONE (chromium OR firefox will do)
     *
     * The report is stashed on the entry so the UI can offer an "env.fix"
     * hint (e.g. "install python3") instead of a dead skill with no
     * explanation. Missing tools mark the skill BROKEN, not DROPPED: the
     * content is valid, the machine just isn't set up yet.
     */
    _check_requires(entry: SkillEntry): Result {
        const missing_all = entry.requires_bins.filter((b) => !shutil_which(b));
        const any_ok = entry.requires_any_bins.length === 0 ||
            entry.requires_any_bins.some((b) => shutil_which(b) !== null);
        entry.requires_report = {
            requiresBins: entry.requires_bins,
            requiresAnyBins: entry.requires_any_bins,
            missing: missing_all,
            anySatisfied: any_ok,
        };
        const problems: string[] = [];
        if (missing_all.length > 0) {
            problems.push(`missing required: ${missing_all.join(", ")}`);
        }
        if (!any_ok) {
            problems.push(`need one of: ${entry.requires_any_bins.join(", ")}`);
        }
        if (problems.length > 0) {
            const fix = SkillLoader._env_fix_hint(missing_all.concat(any_ok ? [] : entry.requires_any_bins));
            entry.requires_report["fix"] = fix;
            return Result.failure(`Dependency check failed (${problems.join("; ")}). ${fix}`);
        }
        return Result.success("Dependencies OK");
    }

    /** Best-effort 'how to install this' hint for common tools. */
    static _env_fix_hint(bins: readonly string[]): string {
        if (!bins || bins.length === 0) return "";
        // Map：技能可声明任意 bin 名，"constructor"/"__proto__" 不得命中原型。
        const known = new Map<string, string>([
            ["python3", "安装 Python 3（python.org 或系统包管理器）"],
            ["node", "安装 Node.js（nodejs.org）"],
            ["npm", "随 Node.js 一起安装"],
            ["git", "安装 Git（git-scm.com）"],
            ["chromium", "安装 Chromium 或 Chrome"],
            ["chrome", "安装 Google Chrome"],
            ["ffmpeg", "安装 FFmpeg（ffmpeg.org）"],
            ["docker", "安装 Docker Desktop"],
        ]);
        const hints = bins.map((b) => known.get(b) ?? `请确保 \`${b}\` 在 PATH 中`);
        return "建议：" + [...new Set(hints)].join("；");
    }

    // ── B2: 三阶段渐进式披露 ──────────────────────────────────────────────

    /** Stage 1: 一段塞进 system prompt 的 `<available_skills>` 清单。
     *
     * 只放**元数据**——每个技能约 100 字符描述。50 个技能 ≈ 5K token，
     * 而不是把 50 份完整 SKILL.md（可能几十万 token）全灌进去。模型读了
     * 这段之后，自己判断哪个相关，再通过工具触发 Stage 2 加载正文。
     *
     * 过滤规则（B3 可见性三维在这里生效）：
     * - 必须 include_in_available_skills_prompt（作者说了要露出给模型）
     * - 必须 include_in_runtime_registry（能被调用的才值得让模型知道）
     * - DISABLED / DROPPED / BROKEN 的技能不进清单——推荐一个用不了的技能
     *   只会让模型白费一轮工具调用。
     * - requires: 声明了当前模型不具备的能力（如纯文本模型 × 视觉技能）
     *   的不进清单——写进清单等于教模型去调一个必然失败的技能。能力解析
     *   失败时不过滤（fail-open），且这只是清单可见性：手动调用始终可用。
     *
     * DIVERGENCE(port): context_refs（Rust wave，尚未移植）在源里是函数级
     * import + except fail-open；这里以动态 import + catch 保留同一降级路径，
     * 代价是函数签名 async 化（Promise 形状与 Python 的同步异常吞掉在调用侧
     * 观察等价——清单内容一致）。
     */
    async render_available_skills_prompt(max_desc: number = 100): Promise<string> {
        const capability = current_model_capability();
        const lines: string[] = [];
        for (const entry of this._skills.values()) {
            if (entry.status === SkillStatus.DISABLED || entry.status === SkillStatus.DROPPED || entry.status === SkillStatus.BROKEN) {
                continue;
            }
            if (!entry.include_in_available_skills_prompt) continue;
            if (!entry.include_in_runtime_registry) continue;
            if (unmet_model_requirements(entry.requires, capability).length > 0) continue;
            let desc = pyStrip(entry.description).replace(/\n/g, " ");
            if (pyLen(desc) > max_desc) {
                desc = pyStripEnd(pySlice(desc, max_desc)) + "…";
            }
            // Skill descriptions are authored content — they can carry injection
            // tags or prompt-override text. Sanitize before it enters the system
            // prompt, same neutralizer the @-ref and tool-result paths use.
            try {
                const cr_spec = "./context_refs.js";
                const mod = (await import(/* @vite-ignore */ cr_spec)) as {
                    sanitize_injection_tags: (t: string) => [string, unknown];
                };
                desc = mod.sanitize_injection_tags(desc)[0];
            } catch {
                /* fail-open: 可选增强，失败不影响主流程 */
            }
            const trig = entry.triggers.length > 0 ? ` (触发词: ${entry.triggers.join(", ")})` : "";
            lines.push(`- **${entry.name}**: ${desc}${trig}`);
        }
        if (lines.length === 0) return "";
        const header =
            "## 可用技能清单\n" +
            "以下是当前可调用的技能，仅列出元数据。当某个技能与用户任务相关时，" +
            "用 `skill_load` 加载它的完整说明后再执行——不要凭这一行描述就动手。\n";
        const body = header + lines.join("\n") + "\n";
        // Wrap the whole list in the untrusted frame so the model treats it as
        // data, not instruction. A SKILL.md tail saying "ignore all rules" is
        // now inside <untrusted-context>, not a peer of the system prompt.
        try {
            const wrapped = wrap_untrusted(body, "skill-list");
            return wrapped || body;
        } catch {
            return body;
        }
    }

    /** Stage 2 辅助：返回被用户消息里的触发词命中的技能名。
     *
     * 比 find_by_trigger 的关键词打分更硬——触发词是作者显式声明的
     * "出现这个词八成要用我"，命中就应该优先加载 body，不用等模型判断。
     */
    matched_by_triggers(user_message: string): string[] {
        const msg = user_message.toLowerCase();
        const hit: string[] = [];
        for (const entry of this._skills.values()) {
            if (entry.status === SkillStatus.DISABLED || entry.status === SkillStatus.DROPPED || entry.status === SkillStatus.BROKEN) {
                continue;
            }
            if (!entry.include_in_runtime_registry) continue;
            if (entry.triggers.filter((t) => t).some((t) => msg.includes(t.toLowerCase()))) {
                hit.push(entry.name);
            }
        }
        return hit;
    }

    /** List all imported skills (progressive disclosure: only name+description). */
    list_skills(include_disabled: boolean = false): Record<string, unknown>[] {
        if (this._skills.size === 0) {
            this.discover();
        }
        const result: Record<string, unknown>[] = [];
        for (const [name, entry] of this._skills.entries()) {
            if (!include_disabled && entry.status === SkillStatus.DISABLED) continue;
            if (entry.status === SkillStatus.DROPPED) continue;
            result.push({
                name: entry.name,
                description: pySlice(entry.description, 250), // First 250 chars = trigger signal
                version: entry.version,                        // content hash — the real identity
                declaredVersion: entry.declared_version,       // authored, display-only
                status: entry.status,
                trust: entry.trust,
                userInvocable: entry.user_invocable,
                disableModelInvocation: entry.disable_model_invocation,
                includeInRuntimeRegistry: entry.include_in_runtime_registry,
                includeInAvailableSkillsPrompt: entry.include_in_available_skills_prompt,
                triggers: entry.triggers,
                requiresBins: entry.requires_bins,
                requiresAnyBins: entry.requires_any_bins,
                requiresReport: entry.requires_report,
                license: entry.license,
                author: entry.author,
                upstream: entry.upstream,
                copyright: entry.copyright,
                licenseFromFile: entry.license_from_file,
            });
            void name;
        }
        return result;
    }

    /** Hot-reload one skill if its file content hash changed.
     *
     * This is what makes the content-hash version pay off: re-read the file,
     * recompute the hash, and only re-import when it differs — so an editor
     * save that changed nothing (touch, whitespace-only diff that round-trips)
     * costs one hash and no reload, while a real edit reloads without the user
     * having to bump a version string or restart anything.
     *
     * Returns a Result whose value says whether a reload happened:
     * `{changed: boolean, version: hash}`.
     */
    reimport_if_changed(name: string): Result {
        const entry = this._skills.get(name);
        if (!entry) {
            return Result.failure(`Skill not found: ${name}`);
        }
        const skill_md = nodePath.join(entry.path, "SKILL.md");
        let content: string;
        try {
            content = decode_py_utf8(fs.readFileSync(skill_md), "ignore");
        } catch (e) {
            return Result.failure(`Cannot read SKILL.md: ${e instanceof Error ? e.message : String(e)}`);
        }
        const new_hash = compute_content_hash(content);
        if (new_hash === entry.version) {
            return Result.success({ changed: false, version: new_hash });
        }
        // Preserve the user's enable/disable choice across a content reload —
        // a hot edit shouldn't silently re-enable a skill the user turned off.
        const prev_status = entry.status;
        const result = this.import_skill(entry.path, entry.trust);
        if (!result.ok) {
            return result;
        }
        const reloaded = this._skills.get(name);
        if (reloaded && prev_status === SkillStatus.DISABLED) {
            reloaded.status = SkillStatus.DISABLED;
        }
        return Result.success({ changed: true, version: new_hash });
    }

    get_skill(name: string): SkillEntry | null {
        return this._skills.get(name) ?? null;
    }

    /** Load full SKILL.md body for a skill (progressive disclosure: trigger-time loading). */
    load_skill_body(name: string): Result {
        const entry = this._skills.get(name);
        if (!entry) {
            return Result.failure(`Skill not found: ${name}`);
        }
        if (entry.status === SkillStatus.DISABLED) {
            return Result.failure(`Skill is disabled: ${name}. Enable it first.`);
        }
        if (entry.status === SkillStatus.DROPPED) {
            return Result.failure(`Skill was dropped during import: ${name}`);
        }
        return Result.success({ body: entry.body, frontmatter: entry.frontmatter, path: entry.path });
    }

    enable_skill(name: string): Result {
        const entry = this._skills.get(name);
        if (!entry) {
            return Result.failure(`Skill not found: ${name}`);
        }
        if (entry.status === SkillStatus.DROPPED) {
            return Result.failure(`Cannot enable dropped skill: ${name}`);
        }
        entry.status = SkillStatus.IMPORTED;
        return Result.success(`Skill enabled: ${name}`);
    }

    disable_skill(name: string): Result {
        const entry = this._skills.get(name);
        if (!entry) {
            return Result.failure(`Skill not found: ${name}`);
        }
        entry.status = SkillStatus.DISABLED;
        return Result.success(`Skill disabled: ${name}`);
    }

    /** Safely deactivate/uninstall a skill from AI runtime.
     *
     * Per user specification, uninstalling a skill does NOT delete the physical
     * directory or remove the entry from the loaded list. Instead, it marks the
     * skill as DISABLED and flags disable_model_invocation = True so it is 100%
     * isolated and never used by AI prompts or trigger matching. The card remains
     * visible in the UI list for re-enabling at any time.
     */
    uninstall_skill(name: string): Result {
        const entry = this._skills.get(name);
        if (!entry) {
            return Result.failure(`Skill not found: ${name}`);
        }
        entry.status = SkillStatus.DISABLED;
        entry.disable_model_invocation = true;
        return Result.success(`Skill safely uninstalled from AI runtime: ${name}`);
    }

    get_skill_detail(name: string): Result {
        const entry = this._skills.get(name);
        if (!entry) {
            return Result.failure(`Skill not found: ${name}`);
        }
        let body: string = entry.body ?? "";
        if (!body && entry.path) {
            const sk_file = nodePath.join(entry.path, "SKILL.md");
            if (fs.existsSync(sk_file) && fs.statSync(sk_file).isFile()) {
                try {
                    body = decode_py_utf8(fs.readFileSync(sk_file), "replace");
                } catch {
                    body = "";
                }
            }
        }
        return Result.success({
            name: entry.name,
            description: entry.description,
            path: entry.path,
            status: entry.status,
            trust: entry.trust,
            allowed_tools: entry.allowed_tools ?? [],
            requires: entry.requires ?? [],
            frontmatter: entry.frontmatter ?? {},
            user_invocable: entry.user_invocable ?? true,
            disable_model_invocation: entry.disable_model_invocation ?? false,
            license: entry.license ?? "",
            author: entry.author ?? "",
            upstream: entry.upstream ?? "",
            copyright: entry.copyright ?? "",
            licenseFromFile: entry.license_from_file ?? false,
            body: body,
        });
    }

    /** 作者显式声明的触发词命中一次值多少分。
     *
     * 取 5 是为了让"一个触发词命中"稳压"描述里蒙对两三个词"：前者是作者写下的
     * 「出现这个词八成要用我」，后者是分词碰巧撞上。旧实现只看后者，等于把
     * frontmatter 里的 triggers 当装饰——`matched_by_triggers` 写好了却没有任何
     * 生产调用者，而系统提示里还照着 triggers 向模型展示。
     */
    static readonly TRIGGER_HIT_SCORE: number = 5;

    /** 降级技能名的缓存时长。选择路径每回合要问两次，而降级是分钟级的慢变量。 */
    static readonly _DEGRADED_TTL_S: number = 30.0;

    /** 技能履历里已被自动降级的技能名。
     *
     * `Storage._maybe_degrade_skill` 是全系统唯一的自动负反馈：连续失败会把
     * 候选行置为 degraded。但在这之前**没有任何选择路径读它**——降级写下去
     * 就躺在表里，下一回合照旧把同一个坏技能推给模型。那不叫闭环，叫留痕。
     */
    _degraded_skill_names(): Set<string> {
        const now = Date.now() / 1000.0;
        const cached = this._degraded_cache;
        if (cached && cached[1] > now) {
            return cached[0];
        }
        let names = new Set<string>();
        try {
            const rows = this._storage.list_skill_candidates("degraded", 200);
            names = new Set(rows.filter((r) => r["name"]).map((r) => String(r["name"] ?? "")));
        } catch (exc) {
            // 读不到就当没有降级：宁可多推一个技能，也不能因为记账层出问题
            // 让所有技能都消失。但要留声——静默的空集合会掩盖故障。
            console.log(`[skills] degraded lookup failed: ${exc instanceof Error ? exc.message : String(exc)}`);
        }
        this._degraded_cache = [names, now + SkillLoader._DEGRADED_TTL_S];
        return names;
    }

    /** 按作者触发词 + 描述关键词找候选技能。
     *
     * Respects B3 visibility: a skill that disabled model invocation, or is not
     * in the runtime registry, is invisible to this discovery path — the model
     * should never see suggestions it can't actually invoke.
     *
     * 三条修正（对应审计的"选择路径不读反馈"）：
     * * 触发词参与打分，权重高于描述词重叠；
     * * BROKEN 不再入选——它以前**是**入选的（状态白名单里带着它），
     *   于是一个导入就坏掉的技能照样能被推荐并注入正文；
     * * 已降级的技能整体排除，并在返回值里如实标注排除了几个。
     */
    find_by_trigger(user_message: string): Record<string, unknown>[] {
        const results: Record<string, unknown>[] = [];
        const msg_lower = user_message.toLowerCase();
        const degraded = this._degraded_skill_names();
        for (const [name, entry] of this._skills.entries()) {
            if (entry.status !== SkillStatus.IMPORTED) continue;
            if (entry.disable_model_invocation) continue;
            if (!entry.include_in_runtime_registry) continue;
            if (degraded.has(name)) continue;
            const trigger_hits = (entry.triggers ?? []).filter((t) => t && msg_lower.includes(t.toLowerCase()));
            const desc_lower = entry.description.toLowerCase();
            const keywords = desc_lower.split(/\s+/).filter((w) => w.length > 3 && /\S/.test(w));
            let matches = 0;
            for (const kw of keywords) {
                if (msg_lower.includes(kw)) matches += 1;
            }
            const score = matches + SkillLoader.TRIGGER_HIT_SCORE * trigger_hits.length;
            if (trigger_hits.length === 0 && matches < 2) continue;
            results.push({
                name: name,
                match_score: score,
                // 为什么被选中要能说清：审计和 UI 都靠这个字段区分
                // "作者说了这个词就用我" 和 "描述碰巧撞上两个词"。
                matched_by: trigger_hits.length > 0 ? "triggers" : "description",
                triggers_hit: trigger_hits,
                owner_agents: [...(entry.owner_agents ?? [])],
            });
        }
        // 排序键三段：分数 → 归属 → 名字。归属只在**分数打平**时才起作用，
        // 且方向是"本地声明的优先于市场装的"；名字是最后一道，保证同分同归属
        // 时顺序稳定（dict 顺序不该成为产品行为）。
        results.sort((x, y) => {
            if (x["match_score"] !== y["match_score"]) {
                return (y["match_score"] as number) - (x["match_score"] as number);
            }
            const lx = _owner_is_local(x as { owner_agents?: unknown }) ? 0 : 1;
            const ly = _owner_is_local(y as { owner_agents?: unknown }) ? 0 : 1;
            if (lx !== ly) return lx - ly;
            return pyStrLess(String(x["name"]), String(y["name"]));
        });
        return results.slice(0, 5);
    }

    /** Scan skill roots and import every `<root>/<name>/SKILL.md` found.
     *
     * Without this, `import_skill` only ever runs from an explicit API call,
     * so skills sitting on disk are invisible at startup. Roots are checked in
     * order and the first copy of a given name wins, letting a project-local
     * skill override a user-global one.
     *
     * Args:
     *   roots: Directories to scan. Defaults to the project `.agents/skills`
     *     then the user-global `~/.agents/skills`.
     *   trust: Trust level applied to discovered skills. Local on-disk
     *     skills are the user's own, so they load enabled by default.
     *
     * Returns:
     *   `{loaded: [...], failed: [{name, error}, ...]}`
     */
    discover(roots: string[] | null = null, trust: TrustLevel = TrustLevel.OWN): { loaded: string[]; failed: { name: string; error: unknown }[] } {
        if (roots === null || roots === undefined) {
            const here = nodePath.dirname(new URL(import.meta.url).pathname);
            const project = nodePath.resolve(here, "..", "..");
            roots = [
                nodePath.join(project, ".agents", "skills"),
                nodePath.join(project, "skills"),
                nodePath.join(homeDir(), ".agents", "skills"),
            ];
        }

        const loaded: string[] = [];
        const failed: { name: string; error: unknown }[] = [];
        for (const root of roots) {
            let entries: string[];
            try {
                if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
                entries = fs.readdirSync(root);
            } catch {
                continue;
            }
            entries.sort(pyStrLess);
            for (const entry_name of entries) {
                const skill_dir = nodePath.join(root, entry_name);
                if (!fs.existsSync(nodePath.join(skill_dir, "SKILL.md")) || !fs.statSync(nodePath.join(skill_dir, "SKILL.md")).isFile()) {
                    continue;
                }
                if (this._skills.has(entry_name)) continue; // earlier root already provided this name
                const result = this.import_skill(skill_dir, trust);
                if (result.ok) {
                    // 磁盘上的技能没声明归属就按"用户自己的"记——它确实躺在
                    // 用户的项目或家目录里。市场装的走 skill_registry，那里
                    // 会把来源仓库名填进来。
                    const ent = this._skills.get(entry_name);
                    if (ent !== undefined && ent.owner_agents.length === 0) {
                        ent.owner_agents = [OWNER_USER];
                    }
                    loaded.push(entry_name);
                } else {
                    failed.push({ name: entry_name, error: result.error });
                }
            }
        }
        return { loaded, failed };
    }
}

function pyStripEnd(s: string): string {
    return s.replace(/[\s\u000b\u001c\u001d\u001e\u001f]+$/g, "");
}

let _loader: SkillLoader | null = null;
export function get_skill_loader(): SkillLoader {
    if (_loader === null) {
        _loader = new SkillLoader();
        _loader.discover();
    }
    return _loader;
}

// DIVERGENCE(port): render_available_skills_prompt 因 context_refs（Rust wave，
// 未移植）保持 async；源以 except 同步吞掉缺失模块，此处以 await+catch 等价吞掉，
// 清单内容一致。
// DIVERGENCE(port): 文件读取 errors="ignore"/"replace" 由 decode_py_utf8 逐字节实现，
// 与 CPython utf-8 错误处理器的逐字节粒度一致（TextDecoder 的合并粒度不等价，弃用）。

// PORT STATUS: confidence=high todos=[0]

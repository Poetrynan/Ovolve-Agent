/**
 * memory_guard.ts — 长期记忆写入的安全闸（Phase 4 收口 + Phase 5 §9.3 扩展）。
 *
 * Ported from `app/backend/memory_guard.py` (272 lines).
 *
 * 总指令 §9.2/§9.3/§16：秘密和一次性噪声不进入长期记忆；隐形 Unicode 不能
 * 绕过扫描；外部内容里的指令不得成为长期记忆。所有要持久化的记忆内容在
 * store() 之前过这里：
 *
 * - secret 形状 → 整条拒绝，不截断保留——截断后的半条秘密还是秘密。
 * - 隐形 Unicode（零宽字符、方向控制、变体选择器等）→ 剥除后放行。
 * - prompt injection 形状 → 整条拒绝。长期记忆每一轮都会被注入 prompt，
 *   一条能改写指令的记忆等于一个永久后门。
 * - 一次性噪声（临时路径、PID/端口/耗时、裸 hash）→ 拒绝。
 * - 模型臆测 → 拒绝（除非带"用户说/用户确认"归属标记）。
 * - sensitivity 分级：不拒绝，只贴标签（public / personal / internal）。
 * - 负面断言（"X 不存在"）→ **不拒绝，但要求有保质期**（valid_until）。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only.
 *   §2  正则契约：JS 的 `\w \d \b` 与 CPython **不等价**，实测过才敢这么说——
 *       CPython 3.13.15 的 `\w` = 138558 码位 / 749 段，而 JS 的 `[\p{L}\p{N}_]`
 *       比它多 9039 码位（V8 带的 UCD 比 CPython 新，和 §M 里 PY_LOWER_PRESERVE
 *       那 27 码位的偏移同一类）；反过来 JS 的 `\w` 不含汉字，`\b` 在 `端口5`
 *       这种 CJK 标签旁边根本不发火，端口就漏判这一类瞬时数字（DEFECT-1）。
 *       所以本模块不写任何正则字面量：11 条模式的模式文本逐字取自 memory_guard.py
 *       （由指定解释器 dump `rx.pattern` 并用 AST 逐条对上源文件字面量），运行时交给
 *       §M 的 `py_regex()` 翻译成 `v` flag 镜像类。证据：
 *       `tmp/lead_z_pyre_classes.py`（全码位普查）、
 *       `tmp/lead_z_mirror_census.txt`（`CENSUM EQUAL`，w/d/s 三侧 diff=0 extra=0
 *       missing=0）、`tmp/lead_z_battery_diff.txt`（11 条模式 × 60 条输入 = 660 行
 *       finditer 差分 `DIFFS=0 COMPILE_ERR=0`）、`tmp/lead_z_cf_summary.txt`
 *       （`i` 标志的大小写折叠面 1012 行 `DIFFS=0`，防止第二个缺陷被假设掉）。
 *   §2  带 g 标志的 RegExp 每次调用新建（HANDOFF §6.2）——本模块只有隐形 Unicode
 *       那条带 g（Python `re.sub` 是全部替换，端口必须照办），并且只在 replace 的
 *       调用点重建；其余全是非 g 正则的 .test()/.search 等价形态，无 lastIndex 风险。
 *   §2  Python `^` 在 MULTILINE 下匹配每行行首 → JS `m` 标志同义。
 *   §2  dataclass Screening → interface；字段默认值一致。
 *   §4  naming: memory_guard.py → memory_guard.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { py_regex } from "./server/http_server_keys.js";

// 与 trace_gateway 同族的键值形状 + 常见令牌前缀（独立编译，避免循环依赖）。
const _SECRET_RE = py_regex(
  "\\b(?:api[-_]?key|secret|token|password|passwd|pwd|credential|auth(?:orization)?|access[-_]?key|private[-_]?key|session[-_]?id|cookie)\\b\\s*[:=]\\s*\\S+|\\bbearer\\s+[A-Za-z0-9._\\-]+|\\b(?:sk|pk|rk)-[A-Za-z0-9_\\-]{8,}|\\bgh[pousr]_[A-Za-z0-9]{16,}|\\bxox[baprs]-[A-Za-z0-9\\-]{8,}|\\bAIza[A-Za-z0-9_\\-]{16,}",
  "iu"
);

// 零宽与方向控制字符：U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF
const _HIDDEN_UNICODE_RE = py_regex(
  "[\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2061\u2062\u2063\u2064\u206a\u206b\u206c\u206d\u206e\u206f\ufeff]",
  "gu"
);

export const MAX_MEMORY_CONTENT_CHARS = 8000;

// prompt injection 形状。刻意只认**祈使句式的指令改写**，不认单纯提到这些词。
const _INJECTION_RE = py_regex(
  "忽略(?:之前|上面|以上|前面)(?:所有)?(?:的)?(?:指令|要求|规则|提示)|无视(?:之前|上面|以上)(?:所有)?(?:的)?(?:指令|规则)|你(?:现在|从现在起|从此)(?:是|扮演|变成)|从现在(?:开始|起)(?:你|请你)|ignore\\s+(?:all\\s+)?(?:the\\s+)?(?:previous|prior|above|preceding)\\s+(?:instructions?|prompts?|rules?|directions?)|disregard\\s+(?:all\\s+)?(?:the\\s+)?(?:previous|prior|above)\\s+|you\\s+are\\s+now\\s+(?:a|an|the)\\b|new\\s+(?:system\\s+)?instructions?\\s*:|^\\s*(?:system|assistant|developer)\\s*:",
  "imu"
);

// 一次性噪声。三类，每一类都是"下一次就不成立"的东西。
const _EPHEMERAL_RES: ReadonlyArray<readonly [RegExp, string]> = [
  [py_regex("(?:[A-Za-z]:\\\\|/)(?:[^\\s]*\\\\)?(?:Temp|tmp|Temporary)\\\\|/tmp/|/var/folders/", "iu"), "临时路径"],
  [py_regex("\\b(?:pid|端口|port|耗时|elapsed|took|行号|line)\\s*[:=]?\\s*\\d+\\b", "iu"), "瞬时数字"],
  [py_regex("^\\s*[0-9a-f]{7,40}\\s*$", "iu"), "裸 hash"],
];

// 模型臆测。同样只认**整条陈述被不确定性限定**的情况。
const _SPECULATION_RE = py_regex(
  "可能是|大概是|应该是|似乎|好像|我猜|估计是|不确定|也许|\\b(?:probably|maybe|perhaps|might\\s+be|i\\s+(?:think|guess|assume)|seems?\\s+(?:to\\s+be|like)|not\\s+sure|presumably)\\b",
  "iu"
);

// 负面断言：断言某物**不存在**。不是"拦下来"，而是"给它一个保质期"。
const _NEGATIVE_RE = py_regex(
  "不存在|已删除|已移除|已下线|未找到|找不到|没有找到|查无|暂无|已无|无此|尚未(?:提供|支持|实现)|(?:当前|目前)没有|还(?:没|不)(?:有|存在)|没有(?!\\s*(?:意义|必要|关系|区别|问题|办法|时间|用处|影响|道理))|\\bdoes\\s+not\\s+exist\\b|\\bdo\\s+not\\s+exist\\b|\\bdoesn'?t\\s+exist\\b|\\bno\\s+such\\b|\\bnot\\s+found\\b|\\bhas\\s+been\\s+(?:removed|deleted)\\b|\\bthere\\s+(?:is|are)\\s+no\\b|\\bno\\s+longer\\s+(?:exists|present|available)\\b|\\bnot\\s+(?:implemented|supported|available)\\b",
  "iu"
);

/** 负面断言的保质期（天）。14 天是权衡：短于一次迭代周期会让它还没被用上
 * 就消失，长过一个季度它早就不是事实了。 */
export const NEGATIVE_TTL_DAYS = 14;

/** 在这之前认为它还新鲜，召回时不加提示；之后加一句"观测于 N 天前"。 */
export const NEGATIVE_FRESH_DAYS = 7;

/** 召回时贴的年龄提示。staleness_note 决定是否出现。 */
const _STALENESS_TEMPLATE = "（此结论观测于 {} 天前，可能已过期）";

/** 给一条易腐记忆生成年龄提示；还新鲜就返回空串。
 *
 * 写在句子层面而不是"整条丢弃"：在保质期之内，一句"观测于 9 天前"比直接
 * 删掉有用——模型可以自己决定要不要去核实。 */
export function staleness_note(observed_at: number, now?: number | null): string {
  const ts = Number(observed_at ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  const ref = now !== null && now !== undefined ? Number(now) : Date.now() / 1000;
  const days = Math.trunc(Math.max(0.0, (ref - ts) / 86400.0));
  if (days < NEGATIVE_FRESH_DAYS) {
    return "";
  }
  return _STALENESS_TEMPLATE.replace("{}", String(days));
}

// 归属标记：出现这些说明这条是"用户明确说的"，即使句子里带不确定词也放行。
const _ATTRIBUTION_RE = py_regex(
  "用户(?:说|表示|确认|要求|指出|强调)|user\\s+(?:said|confirmed|stated|asked|wants)",
  "iu"
);

// sensitivity 分级用的形状。不拒绝，只贴标签。
const _PERSONAL_RE = py_regex(
  "\\b\\d{3}-?\\d{4}-?\\d{4}\\b|\\b1[3-9]\\d{9}\\b|[\\w.+-]+@[\\w-]+\\.[\\w.]+|身份证|护照|家庭住址|银行卡",
  "iu"
);
const _INTERNAL_RE = py_regex(
  "\\b(?:10|127)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b|\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b|\\b172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b|\\b\\w+\\.(?:internal|intranet|local|corp|lan)\\b|内网|内部系统|仅限内部",
  "iu"
);

/** sensitivity 取值。`public` 是默认——绝大多数记忆是"项目用 pnpm"这种。 */
export const SENSITIVITY_LEVELS: readonly string[] = ["public", "internal", "personal"];

export interface Screening {
  /** 一条待持久化记忆的审查结论。
   *
   * `allowed=false` 时 `content` 是空串——被拒的内容不往下传，避免调用方
   * "顺手"把它写进日志或错误消息里，那等于把刚拦下来的东西又漏出去。 */
  allowed: boolean;
  content: string;
  reasons: string[];
  sensitivity: string;
  /** 命中负面断言形态。不拒收，但调用方要给它一个保质期（valid_until）——
   * 见 NEGATIVE_TTL_DAYS。 */
  negative_assertion: boolean;
}

/** 给一条记忆贴敏感度标签。`personal` 优先于 `internal`。
 *
 * 不影响是否写入：一条"用户的邮箱是 x@y.com"是合法且有用的长期记忆，只是
 * 界面上该显示成敏感、导出时该被排除。把分级和拒收混在一起会导致两个结果
 * 都不对——要么该记的不记，要么该标的没标。 */
export function classify_sensitivity(text: string): string {
  const t = String(text ?? "");
  if (_PERSONAL_RE.test(t)) {
    return "personal";
  }
  if (_INTERNAL_RE.test(t)) {
    return "internal";
  }
  return "public";
}

/** §9.3 的写入闸门：检查、清洗并分级一条待持久化的记忆。
 *
 * `trusted=true` 用于用户在设置页手写的那条——她本人打进去的字不该被
 * "这句话里有'可能'"这种启发式拦下来。秘密、注入和隐形 Unicode 仍然照拦：
 * 那三样即使是用户自己粘进来的，进了长期记忆也一样危险（粘错了才是常见情况）。 */
export function screen_memory_content(
  content: string,
  opts: { trusted?: boolean } = {}
): Screening {
  const { trusted = false } = opts;
  const text = String(content ?? "");
  const reasons: string[] = [];

  if (_SECRET_RE.test(text)) {
    return {
      allowed: false,
      content: "",
      reasons: ["secret-like pattern rejected (not truncated)"],
      sensitivity: "public",
      negative_assertion: false,
    };
  }

  if (_INJECTION_RE.test(text)) {
    return {
      allowed: false,
      content: "",
      reasons: ["prompt-injection shape rejected"],
      sensitivity: "public",
      negative_assertion: false,
    };
  }

  const cleaned = text.replace(new RegExp(_HIDDEN_UNICODE_RE.source, "gv"), "");
  const stripped = text.length - cleaned.length;
  if (stripped) {
    reasons.push(`stripped ${stripped} hidden-unicode char(s)`);
  }

  if (cleaned.length > MAX_MEMORY_CONTENT_CHARS) {
    const cut = Array.from(cleaned).slice(0, MAX_MEMORY_CONTENT_CHARS).join("");
    reasons.push(`truncated to ${MAX_MEMORY_CONTENT_CHARS} chars`);
    var truncated = cut;
  } else {
    var truncated = cleaned;
  }

  if (!truncated.trim()) {
    return {
      allowed: false,
      content: "",
      reasons: [...reasons, "empty after cleaning"],
      sensitivity: "public",
      negative_assertion: false,
    };
  }

  if (!trusted) {
    for (const [rx, label] of _EPHEMERAL_RES) {
      if (new RegExp(rx.source, rx.flags).test(truncated)) {
        return {
          allowed: false,
          content: "",
          reasons: [...reasons, `ephemeral content rejected: ${label}`],
          sensitivity: "public",
          negative_assertion: false,
        };
      }
    }
    if (
      new RegExp(_SPECULATION_RE.source, _SPECULATION_RE.flags).test(truncated) &&
      !new RegExp(_ATTRIBUTION_RE.source, _ATTRIBUTION_RE.flags).test(truncated)
    ) {
      return {
        allowed: false,
        content: "",
        reasons: [...reasons, "speculation rejected (no attribution)"],
        sensitivity: "public",
        negative_assertion: false,
      };
    }
  }

  // 负面断言：不拒收，只标记。放在 trusted 分支之外——标记不是拦截，用户的
  // "这里没有 CI"和模型抽出来的同样是会过期的观察，两边该一视同仁。
  const negative = new RegExp(_NEGATIVE_RE.source, _NEGATIVE_RE.flags).test(truncated);
  if (negative) {
    reasons.push(`negative assertion: expires in ${NEGATIVE_TTL_DAYS}d unless re-observed`);
  }

  return {
    allowed: true,
    content: truncated,
    reasons,
    sensitivity: classify_sensitivity(truncated),
    negative_assertion: negative,
  };
}

/** 旧签名的薄封装，保留是因为已有调用方按三元组解包。
 *
 * 默认 `trusted=true`：这个入口原本只做秘密和隐形 Unicode 两件事，悄悄给它
 * 加上臆测和一次性内容的拦截会改变现有调用方的行为。想要完整闸门的走
 * screen_memory_content。 */
export function guard_memory_content(content: string): [boolean, string, string[]] {
  const v = screen_memory_content(content, { trusted: true });
  return [v.allowed, v.content, v.reasons];
}

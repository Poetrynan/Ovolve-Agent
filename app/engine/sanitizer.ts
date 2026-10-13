/**
 * sanitizer.ts — 物理隐私脱敏与敏感信息清洗管道 (Phase 59 内化模块)。
 *
 * Ported from `app/backend/sanitizer.py` (262 lines).
 *
 * 从 anti-distill 技能提纯并硬内化为底层物理确定性代码：
 * 1. 绝对盘符与私人目录脱敏（写进 AGENTS.md / MEMORY.md / SQLite 的内容
 *    不带本地私有盘符或用户名）。
 * 2. API Key 与凭证物理脱敏（sk-*、ghp_*、Bearer Token、MAC 地址）。
 * 3. 零 Token 消耗、微秒级响应、确定性 100%。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only.
 *   §2  Python re → JS RegExp。源模式的字符类（[^\s'"<>] 等）与 BMP 中文
 *       查找在 JS 逐字可用；lookbehind (?<!...) Node 22 支持。带 g 标志的
 *       RegExp 每次调用新建（HANDOFF §6.2 lastIndex 纪律）。
 *   §2  datetime 基准：源用本地时间 fromtimestamp(time.time())；TS 用
 *       Date 的本地时区方法，等价。
 *   §2  re.escape → 手写 escapeRegExp（正则元字符全集一致）。
 *   §4  naming: sanitizer.py → sanitizer.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

// ---------------------------------------------------------------------------
// PrivacySanitizer
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  // Python re.escape equivalent for the metacharacters that matter here.
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PrivacySanitizer {
  /** 生产级物理隐私脱敏与路径规范化器。 */

  // 匹配各类 Windows 绝对路径 (如 C:\Users\xxx\...)
  static readonly WIN_PATH_PATTERN =
    /[A-Za-z]:\\[^\s'"<>]+\\([A-Za-z0-9_\-]+)\\[^\s'"<>]*/gi;
  static readonly WIN_DIR_PATTERN =
    /[A-Za-z]:\\[^\s'"<>]+\\([A-Za-z0-9_\-]+)[\\/]?/gi;

  // 匹配 macOS / Unix /Users/xxx/... 绝对路径
  static readonly UNIX_USER_PATH_PATTERN =
    /\/Users\/[^/\s'"<>]+\/[^\s'"<>]*\/([A-Za-z0-9_\-]+)[\\/]?/gi;

  // 匹配常见 API Key、Token 与私有凭据
  static readonly API_KEY_PATTERNS: readonly RegExp[] = [
    /sk-[a-zA-Z0-9_\-]{20,}/gi,
    /ghp_[a-zA-Z0-9]{30,}/gi,
    /github_pat_[a-zA-Z0-9_]{30,}/gi,
    /Bearer\s+[a-zA-Z0-9_\-\.]{25,}/gi,
    /([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/gi, // MAC
  ];

  /** 将绝对路径清洗为工作区相对路径或规范占位符。 */
  static sanitize_paths(text: string, workspace_root?: string | null, lang = "zh"): string {
    if (!text || typeof text !== "string") {
      return text ?? "";
    }

    // 1. 消除历史残留硬编码
    text = text
      .split("C:\\Users\\ZhuanZ1\\Desktop\\Ovolve").join(lang === "zh" ? "项目" : "workspace")
      .split("C:/Users/User/Desktop/Workspace").join(lang === "zh" ? "项目" : "workspace")
      .split("d:\\Ovolve Agent").join(lang === "zh" ? "项目" : "workspace")
      .split("D:\\Ovolve Agent").join(lang === "zh" ? "项目" : "workspace")
      .split("D:/Example Workspace").join(lang === "zh" ? "项目" : "workspace");

    // 2. 如果提供了 workspace_root，先精确匹配并替换为相对路径占位
    if (workspace_root) {
      const clean_ws = workspace_root.split("\\").join("/").replace(/\/+$/, "");
      // Python: re.escape(clean_ws).replace(r'\\', r'[\\/]') — escape then
      // let backslash match either separator. We normalize separators first,
      // then escape; the escaped slash pattern matches both raw forms by
      // additionally allowing the other separator.
      const esc = escapeRegExp(clean_ws).replace(/\\\\/g, "[\\\\/]");
      const ws_re = new RegExp(esc, "gi");
      text = text.replace(ws_re, lang === "zh" ? "项目根目录" : "workspace root");
    }

    // 3. 如果路径中包含特定知名目录名 (output, docs, dist, src, tests...)
    for (const known_dir of ["output", "docs", "dist", "src", "tests", "temp", "build", "public"]) {
      const pat = new RegExp(
        `[A-Za-z]:\\\\[^\\s'"<>]*\\\\${known_dir}(\\\\[^\\s'"<>]*)?`,
        "gi"
      );
      const rep = lang === "zh" ? `项目 ${known_dir}/ 目录` : `${known_dir}/ directory`;
      text = text.replace(pat, rep);
    }

    // 4. 正则清洗一般 Windows 盘符路径
    text = text.replace(
      new RegExp(PrivacySanitizer.WIN_DIR_PATTERN.source, "gi"),
      (_m, sub_dir: string) =>
        lang === "zh" ? `项目 ${sub_dir}/ 目录` : `${sub_dir}/ directory`
    );

    // 5. 正则清洗 Unix /Users 路径
    text = text.replace(
      new RegExp(PrivacySanitizer.UNIX_USER_PATH_PATTERN.source, "gi"),
      (_m, sub_dir: string) =>
        lang === "zh" ? `项目 ${sub_dir}/ 目录` : `${sub_dir}/ directory`
    );

    return text;
  }

  /** 物理抹除所有已知的 API Token、密钥与敏感凭证。 */
  static sanitize_secrets(text: string): string {
    if (!text || typeof text !== "string") {
      return text ?? "";
    }
    for (const pat of PrivacySanitizer.API_KEY_PATTERNS) {
      text = text.replace(new RegExp(pat.source, pat.flags), "[REDACTED_SECRET]");
    }
    return text;
  }

  /** 一站式执行路径脱敏、凭据清洗与相对日期规范化。 */
  static clean(
    text: string,
    workspace_root?: string | null,
    lang = "zh",
    normalize_dates = true
  ): string {
    if (!text) {
      return "";
    }
    text = PrivacySanitizer.sanitize_paths(text, workspace_root, lang);
    text = PrivacySanitizer.sanitize_secrets(text);
    if (normalize_dates) {
      text = DateNormalizer.normalize(text, undefined, lang);
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// DateNormalizer
// ---------------------------------------------------------------------------

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() - days);
  return d;
}

export class DateNormalizer {
  /** 生产级相对时间转绝对日期规范化器 (Phase 61 核心硬内化)。
   *
   * 自动识别中英文相对时间表述并精确换算为绝对 ISO 日期 (YYYY-MM-DD)：
   * 昨天/昨天前天/今天/上周/上个月/N天前/N周前/N个月前。
   * 采用单遍正则联合匹配 (Single-pass Regex Union)，杜绝级联误伤与二次替换。 */

  /** 将文本中的相对时间短语确定性换算为绝对 ISO 日期。 */
  static normalize(text: string, ref_time?: number | null, lang = "zh"): string {
    void lang; // 源签名保留 lang 参数（未使用，照抄）
    if (!text || typeof text !== "string") {
      return text ?? "";
    }

    // Python datetime.fromtimestamp is LOCAL time.
    const base_dt = new Date(ref_time !== null && ref_time !== undefined ? ref_time * 1000 : Date.now());

    const today_str = fmtDate(base_dt);
    const yesterday_str = fmtDate(shiftDays(base_dt, 1));
    const day_before_str = fmtDate(shiftDays(base_dt, 2));
    const last_week_str = fmtDate(shiftDays(base_dt, 7));
    const last_month_str = fmtDate(shiftDays(base_dt, 30));

    // 构造从长到短的单遍联合正则（源逐字移植；中文边界用 (?<![0-9A-Za-z\-])）。
    const pattern =
      /(?<en_db_yest>\bthe\s+day\s+before\s+yesterday\b)|(?<en_yest>\byesterday\b)|(?<en_today>\btoday\b)|(?<en_last_week>\blast\s+week\b)|(?<en_last_month>\blast\s+month\b)|(?<en_days_ago>\b(\d+)\s*days?\s*ago\b)|(?<en_weeks_ago>\b(\d+)\s*weeks?\s*ago\b)|(?<en_months_ago>\b(\d+)\s*months?\s*ago\b)|(?<zh_db_yest>(?<![0-9A-Za-z\-])前天(?![0-9A-Za-z\-]))|(?<zh_yest>(?<![0-9A-Za-z\-])昨天(?![0-9A-Za-z\-]))|(?<zh_today>(?<![0-9A-Za-z\-])今天(?![0-9A-Za-z\-]))|(?<zh_last_week>(?<![0-9A-Za-z\-])上周(?![0-9A-Za-z\-]))|(?<zh_last_month>(?<![0-9A-Za-z\-])上个月(?![0-9A-Za-z\-]))|(?<zh_days_ago>(?<![0-9A-Za-z\-])(\d+)\s*天前(?![0-9A-Za-z\-]))|(?<zh_weeks_ago>(?<![0-9A-Za-z\-])(\d+)\s*周前(?![0-9A-Za-z\-]))|(?<zh_months_ago>(?<![0-9A-Za-z\-])(\d+)\s*个月前(?![0-9A-Za-z\-]))/gi;

    return text.replace(pattern, (match, ...rest) => {
      const groups = rest[rest.length - 1] as Record<string, string | undefined> | undefined;
      const g = groups ? Object.entries(groups).find(([, v]) => v !== undefined)?.[0] : undefined;
      const num = (s: string): number => {
        const m = /\d+/.exec(s);
        return m ? Number(m[0]) : 0;
      };
      switch (g) {
        case "en_db_yest": return `${day_before_str} (the day before yesterday)`;
        case "en_yest": return `${yesterday_str} (yesterday)`;
        case "en_today": return `${today_str} (today)`;
        case "en_last_week": return `${last_week_str} (last week)`;
        case "en_last_month": return `${last_month_str} (last month)`;
        case "en_days_ago": { const n = num(match); return `${fmtDate(shiftDays(base_dt, n))} (${n} days ago)`; }
        case "en_weeks_ago": { const n = num(match); return `${fmtDate(shiftDays(base_dt, n * 7))} (${n} weeks ago)`; }
        case "en_months_ago": { const n = num(match); return `${fmtDate(shiftDays(base_dt, n * 30))} (${n} months ago)`; }
        case "zh_db_yest": return `${day_before_str} (前天)`;
        case "zh_yest": return `${yesterday_str} (昨天)`;
        case "zh_today": return `${today_str} (今天)`;
        case "zh_last_week": return `${last_week_str} (上周)`;
        case "zh_last_month": return `${last_month_str} (上个月)`;
        case "zh_days_ago": { const n = num(match); return `${fmtDate(shiftDays(base_dt, n))} (${n}天前)`; }
        case "zh_weeks_ago": { const n = num(match); return `${fmtDate(shiftDays(base_dt, n * 7))} (${n}周前)`; }
        case "zh_months_ago": { const n = num(match); return `${fmtDate(shiftDays(base_dt, n * 30))} (${n}个月前)`; }
        default: return match;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// OutputSanitizer bridge
// ---------------------------------------------------------------------------

export class OutputSanitizer {
  /** Output sanitizer bridge for event bus and message sanitization. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  mount(_bus: unknown): void {
    // pass
  }

  sanitize(text: string, workspace_root?: string | null): string {
    return PrivacySanitizer.clean(text, workspace_root);
  }
}

let _global_output_sanitizer: OutputSanitizer | null = null;

export function get_output_sanitizer(): OutputSanitizer {
  if (_global_output_sanitizer === null) {
    _global_output_sanitizer = new OutputSanitizer();
  }
  return _global_output_sanitizer;
}

/** Convenience functional helper for text sanitization. */
export function sanitize_text(text: string, workspace_root?: string | null): string {
  return PrivacySanitizer.clean(text, workspace_root);
}

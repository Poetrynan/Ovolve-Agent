/**
 * skill_vetter.ts — static security scanner for SKILL.md files.
 *
 * Ported from `app/backend/skill_vetter.py` (336 lines).
 *
 * Scans skill content (both the YAML frontmatter and the prose body) for
 * dangerous patterns before installation. Returns a severity level and a
 * list of findings so the UI can present a human-readable risk report.
 *
 * Severity scale:
 *   LOW      — benign; no user-facing warning needed.
 *   MEDIUM   — could be risky in certain contexts; amber warning, allow proceed.
 *   HIGH     — actively dangerous pattern; red block with per-finding confirm.
 *   EXTREME  — almost certainly malicious; hard block unless user overrides twice.
 *
 * Design principles (source docstring, kept as the contract):
 *   1. False positives are better than false negatives.
 *   2. Rules are static regex. No LLM call in the hot path — vetting must be
 *      instant and deterministic.
 *   3. The vetter does NOT execute any code. It is purely textual.
 *   4. Each rule has a human-readable `reason` in both zh and en.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only.
 *   §2  Rule patterns are PCRE-compatible and ported VERBATIM (they are the
 *       security contract; any deviation changes what gets blocked). Python
 *       re.IGNORECASE → the `i` flag. Global RegExps are constructed per call
 *       via fresh RegExp instances from stored sources (HANDOFF §6.2).
 *   §2  IntEnum Severity → numeric const enum with identical ordering;
 *       .name in to_dict → the SEVERITY_NAMES lookup.
 *   §2  bisect_right(line_starts, pos) → binary search implemented inline
 *       with the same semantics (line numbers are 1-indexed the same way).
 *   §2  str.islower/isupper/isdigit per char → JS toLocaleLower/Upper
 *       compare; note Python's isdigit accepts Unicode digits while JS
 *       \d doesn't — the entropy gate only needs ASCII digits here and the
 *       source's token charset is ASCII-only, so behavior is identical on
 *       the inputs that can reach it.
 *   §4  naming: skill_vetter.py → skill_vetter.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

// ---------------------------------------------------------------------------
// Severity / records
// ---------------------------------------------------------------------------

/** Risk severity. Higher numeric = worse. */
export const Severity = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  EXTREME: 4,
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

const SEVERITY_NAMES: Record<number, string> = {
  1: "LOW",
  2: "MEDIUM",
  3: "HIGH",
  4: "EXTREME",
};

export interface Finding {
  /** One specific dangerous pattern detected. */
  severity: Severity;
  rule_id: string;
  /** 1-indexed line where the match starts; 0 = whole-file match */
  line: number;
  /** the actual text that triggered the rule (truncated) */
  matched: string;
  reason_en: string;
  reason_zh: string;
}

export interface VetResult {
  /** Aggregated scan result for one skill. */
  level: Severity; // max severity across all findings
  findings: Finding[];
}

export function vetResultToDict(r: VetResult): Record<string, unknown> {
  return {
    level: SEVERITY_NAMES[r.level],
    findings: r.findings.map((f) => ({
      severity: SEVERITY_NAMES[f.severity],
      ruleId: f.rule_id,
      line: f.line,
      matched: f.matched.slice(0, 120),
      reasonEn: f.reason_en,
      reasonZh: f.reason_zh,
    })),
  };
}

interface Rule {
  rule_id: string;
  severity: Severity;
  source: string;
  reason_en: string;
  reason_zh: string;
}

function rx(p: string): string {
  /** Compile case-insensitive, so `CURL` and `curl` both match.
   * (Source stored the compiled pattern; we store the source and build fresh
   * RegExps per scan — HANDOFF §6.2 lastIndex discipline.) */
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTREME — near-certainly malicious. Executing remote code, decoding then
// running a payload, or obfuscating the payload so review is impossible.
// ─────────────────────────────────────────────────────────────────────────────
const _EXTREME_RULES: Rule[] = [
  {
    rule_id: "remote-code-exec-pipe", severity: Severity.EXTREME,
    source: rx(String.raw`\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b`),
    reason_en: "Downloads a remote script and pipes it straight into a shell. The code that runs is whatever the server decides to serve — it can change after you review the skill.",
    reason_zh: "从网络下载脚本并直接管道进 shell 执行。实际运行的代码由远端服务器决定，你审查过的内容随时可能被替换。",
  },
  {
    rule_id: "remote-code-exec-iex", severity: Severity.EXTREME,
    source: rx(String.raw`(?:iex|Invoke-Expression)\s*\(?\s*(?:\(|New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)`),
    reason_en: "PowerShell downloads and executes remote code in one expression (the Windows equivalent of `curl | sh`).",
    reason_zh: "PowerShell 一行内下载并执行远端代码（Windows 上等价于 `curl | sh`）。",
  },
  {
    rule_id: "base64-decode-exec", severity: Severity.EXTREME,
    source: rx(String.raw`base64\s+(?:-d|-D|--decode|-di)\b[^\n]{0,120}\|\s*(?:ba|z|k|da)?sh\b|(?:ba|z|k|da)?sh\b[^\n]{0,40}<\s*\(\s*base64\s+(?:-d|--decode)`),
    reason_en: "Decodes a base64 blob and executes the result. This is the standard way to hide a payload from review.",
    reason_zh: "解码 base64 内容后直接执行。这是隐藏恶意载荷、规避人工审查的标准手法。",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HIGH — actively dangerous. Credential exfiltration, destructive filesystem
// operations, or reading sensitive files.
// ─────────────────────────────────────────────────────────────────────────────
const _HIGH_RULES: Rule[] = [
  {
    rule_id: "read-ssh-keys", severity: Severity.HIGH,
    source: rx(String.raw`(?:cat|less|more|type|Get-Content|head|tail|cp|scp|rsync)\b[^\n]{0,120}(?:~|\$HOME|%USERPROFILE%)?[\\/]?\.ssh[\\/]`),
    reason_en: "Reads SSH private keys. There is no legitimate reason for a skill to touch `~/.ssh` — this is credential theft.",
    reason_zh: "读取 SSH 私钥。技能没有任何正当理由访问 `~/.ssh`——这是凭据窃取。",
  },
  {
    rule_id: "read-cloud-creds", severity: Severity.HIGH,
    source: rx(String.raw`(?:cat|less|more|type|Get-Content|head|tail|cp|scp|rsync)\b[^\n]{0,120}[\\/]?\.?(?:aws|gcp|azure|kube)[\\/]`),
    reason_en: "Reads cloud provider credentials (AWS/GCP/Azure/Kubernetes). This exfiltrates the keys to your cloud accounts.",
    reason_zh: "读取云服务商凭据（AWS/GCP/Azure/K8s），会导致你的云账号密钥泄露。",
  },
  {
    rule_id: "exfiltrate-env", severity: Severity.HIGH,
    source: rx(String.raw`(?:curl|wget|Invoke-WebRequest|iwr|nc|ncat)\b[^\n]{0,200}(?:\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CRED)|env|printenv|\.env)`),
    reason_en: "Sends environment variables or secrets over the network. Legit skills don't POST your env to a remote host.",
    reason_zh: "把环境变量或密钥通过网络外发。正常技能不会把你的环境变量 POST 到远端。",
  },
  {
    rule_id: "destructive-rm", severity: Severity.HIGH,
    source: rx(String.raw`\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b[^\n]{0,40}(?:\s+/(?:\s|$)|\s+~|\s+\$HOME|\s+/\*|\s+--no-preserve-root)`),
    reason_en: "Recursive force-delete targeting the filesystem root or home directory. One run can wipe your machine.",
    reason_zh: "针对文件系统根目录或主目录的递归强制删除，一次执行就能清空你的机器。",
  },
  {
    rule_id: "destructive-format", severity: Severity.HIGH,
    source: rx(String.raw`\b(?:mkfs\.\w+|dd\s+if=[^\n]{0,60}of=/dev/|format\s+[a-z]:)\b`),
    reason_en: "Formats a disk or overwrites a raw device. Irreversible data loss.",
    reason_zh: "格式化磁盘或直写裸设备，会造成不可逆的数据丢失。",
  },
  {
    rule_id: "disable-security", severity: Severity.HIGH,
    source: rx(String.raw`(?:iptables\s+-F|ufw\s+disable|Set-MpPreference\s+-DisableRealtimeMonitoring|defender|systemctl\s+stop\s+(?:firewalld|apparmor))`),
    reason_en: "Disables a firewall or antivirus. Skills should never weaken your security posture.",
    reason_zh: "关闭防火墙或杀毒软件。技能绝不应削弱你的安全防护。",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM — context-dependent. Privilege escalation, PATH tampering, network
// listeners, or installing arbitrary packages.
// ─────────────────────────────────────────────────────────────────────────────
const _MEDIUM_RULES: Rule[] = [
  {
    rule_id: "sudo", severity: Severity.MEDIUM,
    source: rx(String.raw`\bsudo\b|\brunas\b|Start-Process\b[^\n]{0,60}-Verb\s+RunAs`),
    reason_en: "Requests elevated privileges. Review exactly what runs as admin.",
    reason_zh: "请求提权（管理员权限）。请仔细确认哪些操作会以管理员身份运行。",
  },
  {
    rule_id: "path-tamper", severity: Severity.MEDIUM,
    source: rx(String.raw`(?:export\s+PATH=|setx\s+PATH|\$env:PATH\s*=)`),
    reason_en: "Modifies the PATH environment variable, which can shadow trusted system binaries with malicious ones.",
    reason_zh: "修改 PATH 环境变量，可能用恶意程序覆盖你信任的系统命令。",
  },
  {
    rule_id: "net-listener", severity: Severity.MEDIUM,
    source: rx(String.raw`\b(?:nc|ncat|netcat)\s+-[a-z]*l|socket\.socket\([^\n]{0,40}\)[^\n]{0,60}\.bind|http\.server|python\s+-m\s+http\.server`),
    reason_en: "Opens a network listener/server. Could expose your machine or receive a remote payload.",
    reason_zh: "打开网络监听/服务端口，可能暴露你的机器或接收远端载荷。",
  },
  {
    rule_id: "arbitrary-install", severity: Severity.MEDIUM,
    source: rx(String.raw`\b(?:pip|pip3|npm|pnpm|yarn|gem|cargo|go)\s+(?:install|add|i)\b|apt(?:-get)?\s+install|brew\s+install|choco\s+install`),
    reason_en: "Installs external packages. Verify the package names — typosquatted packages are a common attack vector.",
    reason_zh: "安装外部依赖包。请核对包名——仿冒/抢注包名是常见攻击手段。",
  },
  {
    rule_id: "crontab-persist", severity: Severity.MEDIUM,
    source: rx(String.raw`\bcrontab\b|schtasks\s+/create|New-ScheduledTask|systemctl\s+enable`),
    reason_en: "Installs a persistent scheduled task. This lets code keep running after the skill finishes.",
    reason_zh: "安装持久化的定时任务，会让代码在技能结束后仍持续运行。",
  },
  {
    rule_id: "obfuscation", severity: Severity.MEDIUM,
    source: rx(String.raw`(?:\\x[0-9a-f]{2}){8,}|(?:%[0-9a-f]{2}){10,}|[A-Za-z0-9+/]{120,}={0,2}`),
    reason_en: "Contains a long encoded/obfuscated blob. Cannot be reviewed by a human — treat with suspicion.",
    reason_zh: "包含大段编码/混淆内容，人工无法审查其真实意图，需保持警惕。",
  },
];

const _ALL_RULES: Rule[] = [..._EXTREME_RULES, ..._HIGH_RULES, ..._MEDIUM_RULES];

// ── 高熵串检测（正则之外的那一半）──────────────────────────────────────────
//
// 所有 _HIGH_RULES 都是"认得出的形状"。真实泄露里最常见的那一类恰好没有形状
// ——一串自建服务的随机 token，正则一个都不认识。判据故意保守，宁漏不误报：
// 长度 ≥ 24、含大小写+数字三类、每字符熵 ≥ 3.8 bits。十六进制哈希因为缺大写
// 字母而被排除。
const _ENTROPY_TOKEN_SOURCE = String.raw`[A-Za-z0-9+/_\-=]{24,}`;
const _ENTROPY_MIN_BITS = 3.8;

/** Shannon entropy of one token, in bits per character. */
function _shannon_bits_per_char(s: string): number {
  if (!s) {
    return 0.0;
  }
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const n = s.length;
  let sum = 0;
  for (const c of counts.values()) {
    const p = c / n;
    sum += p * Math.log2(p);
  }
  return -sum;
}

function _entropy_findings(content: string, line_of: (pos: number) => number): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(new RegExp(_ENTROPY_TOKEN_SOURCE, "g"))) {
    const tok = m[0];
    if (seen.has(tok)) {
      continue;
    }
    const has_lower = /[a-z]/.test(tok);
    const has_upper = /[A-Z]/.test(tok);
    const has_digit = /[0-9]/.test(tok);
    if (!(has_lower && has_upper && has_digit)) {
      continue;
    }
    if (_shannon_bits_per_char(tok) < _ENTROPY_MIN_BITS) {
      continue;
    }
    seen.add(tok);
    out.push({
      severity: Severity.HIGH,
      rule_id: "SECRET_HIGH_ENTROPY",
      line: line_of(m.index ?? 0),
      // 不回显全串：报告本身会被读、被存
      matched: tok.slice(0, 12) + "…" + tok.slice(-4),
      reason_en:
        "High-entropy mixed-case token: looks like a live credential with no recognizable vendor prefix.",
      reason_zh:
        "高熵混合大小写长串：像是一把没有厂商前缀的可用凭证，正则规则认不出这一类，但泄露后果相同。",
    });
  }
  return out;
}

/** Scan raw skill text (frontmatter + body) and return the aggregated result.
 *
 * Empty / whitespace-only content is treated as LOW (nothing to run). */
export function vet_skill(content: string): VetResult {
  if (!content || !content.trim()) {
    return { level: Severity.LOW, findings: [] };
  }

  // Precompute line offsets so we can map a match position → line number
  // without re-scanning for every finding.
  const line_starts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      line_starts.push(i + 1);
    }
  }

  // bisect_right over the precomputed offsets — O(log n) per finding.
  function line_of(pos: number): number {
    let lo = 0;
    let hi = line_starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (line_starts[mid]! <= pos) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  const findings: Finding[] = [];
  for (const rule of _ALL_RULES) {
    for (const m of content.matchAll(new RegExp(rule.source, "gi"))) {
      findings.push({
        severity: rule.severity,
        rule_id: rule.rule_id,
        line: line_of(m.index ?? 0),
        matched: m[0].trim(),
        reason_en: rule.reason_en,
        reason_zh: rule.reason_zh,
      });
    }
  }
  findings.push(..._entropy_findings(content, line_of));

  if (findings.length === 0) {
    return { level: Severity.LOW, findings: [] };
  }

  // Sort worst-first so the UI leads with the scariest thing.
  findings.sort((a, b) => b.severity - a.severity || a.line - b.line);
  const level = Math.max(...findings.map((f) => f.severity)) as Severity;
  return { level, findings };
}

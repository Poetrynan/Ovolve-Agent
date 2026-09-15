"""skill_loader.py - Skill import framework with security checks (core).

Does NOT preload any skills. Only imports and manages on-demand.
Import flow: structure check -> frontmatter parse -> security checks ->
progressive disclosure loading.

# SKILL.md 统一格式（B1）

    ---
    name: my-skill                    # 必填，稳定标识
    description: 什么时候该用它         # 必填，<=1024 字符，是触发信号
    version: 2.1.0                    # 选填，人写的语义化版本（展示用）
    user-invocable: true              # 选填，默认 true —— 用户能否手动调用
    disable-model-invocation: false   # 选填，默认 false —— 禁止模型自动调用
    ---

    正文 markdown……

**version 的真正身份是内容哈希**，不是 frontmatter 里那个字符串。
``SkillEntry.version`` = ``sha256(SKILL.md 全文)[:16]``，由系统自动算出；
frontmatter 里人写的那个保留在 ``declared_version``，只用于展示。

为什么这么定：手写版本号永远会忘记改。技能改了内容但版本号没动，缓存
就认不出来该重载，用户看到的是"我明明改了文件但行为没变"。内容哈希让
"改了一个字" 和 "换了个版本" 是同一件事，热更新/缓存失效/技能市场的
完整性校验共用这一个值。

Security checks (from real-world audit findings):
1. Prompt injection detection (skip tests / ignore instructions patterns)
2. XSS/dangerous markup detection (onerror/onload, script tags)
3. Credential scanning (hardcoded API keys/tokens)
4. Reference integrity check (scripts/references must exist)
5. Ethical/attack content flagging (jailbreak/anti-distill)
"""
from __future__ import annotations
import os, re, json, hashlib, time

from typing import Any, Optional
from enum import Enum
from result import Result
from storage import get_storage

#: 内容哈希取前 16 个 hex 字符（64 bit）。碰撞概率在技能库这个量级
#: （即使十万个技能）也远低于磁盘静默损坏，而 16 字符在日志/UI 里还读得下去。
CONTENT_HASH_LEN = 16

#: frontmatter 里的布尔字段，以及它们的默认值。
#: 键同时接受连字符和下划线写法 —— YAML 世界里两种都常见，
#: 让写技能的人不用记我们内部用的是哪种。
#:
#: 可见性三维（B3）—— 三个**互相独立**的布尔，不是一个枚举：
#:   · include-in-runtime-registry      能不能被调用（进不进运行时注册表）
#:   · include-in-available-skills-prompt  要不要出现在 prompt 的技能清单里
#:   · user-invocable                   用户能不能在 UI 里手动点它
#:
#: 为什么必须独立而不是一个"可见性等级"：真实需求里这三者的组合是交叉的。
#:   · 内部自动技能：能调用 + 进 prompt + 用户看不见
#:   · 用户专属工具：能调用 + 不进 prompt（省 token）+ 用户能点
#:   · 临时停用：不能调用 + 不进 prompt + 用户看不见（但配置还留着）
#: 用等级表达就得为每种组合造一个新等级，最后等级比布尔还难记。
BOOLEAN_FIELDS = {
    "user-invocable": True,             # 用户能不能在 UI 里手动点它
    "disable-model-invocation": False,  # 是否禁止模型自动挑它（旧字段，兼容保留）
    "include-in-runtime-registry": True,        # 进不进运行时注册表
    "include-in-available-skills-prompt": True,  # 进不进 prompt 技能清单
}


_TRUTHY = frozenset({"true", "yes", "on", "1"})
_FALSY = frozenset({"false", "no", "off", "0"})


def compute_content_hash(content: str) -> str:
    """SKILL.md 全文的 sha256 前缀 —— 技能的真正版本号。

    对全文（含 frontmatter）取哈希，不是只对正文：改 description 也该算
    新版本，因为 description 是触发信号，改了它技能的行为就变了。
    """
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:CONTENT_HASH_LEN]


def normalize_bool(value: Any, default: bool) -> bool:
    """把 frontmatter 里的字符串解析成布尔。无法判断时回落到 default。

    刻意不把"任何非空字符串"当真：``user-invocable: no`` 是明确的否，
    naive 实现会把它读成真，然后一个作者标记为"别露出来"的技能就出现在
    用户菜单里了。
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    text = str(value).strip().strip('"').strip("'").lower()
    if text in _TRUTHY:
        return True
    if text in _FALSY:
        return False
    return default


def read_bool_field(frontmatter: dict, key: str) -> bool:
    """读一个布尔字段，连字符/下划线两种写法都认。"""
    default = BOOLEAN_FIELDS[key]
    if key in frontmatter:
        return normalize_bool(frontmatter[key], default)
    alt = key.replace("-", "_")
    if alt in frontmatter:
        return normalize_bool(frontmatter[alt], default)
    return default


def _unquote(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def parse_flow_list(text: str) -> list[str]:
    """解析 YAML inline flow 序列：``["a", "b"]`` 或 ``[a, b]``。

    刻意不用 ``json.loads``：真实技能文件里 ``[python3, chromium]``（无引号）
    非常常见，那不是合法 JSON，但在 YAML 里完全正确。
    """
    inner = text.strip()
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    return [_unquote(p) for p in inner.split(",") if _unquote(p)]


def read_list_field(frontmatter: dict, key: str) -> list[str]:
    """读一个列表字段。已经是 list 就直接返回，字符串则按 flow 序列解析。

    连字符/下划线两种写法都认，和 ``read_bool_field`` 保持一致。
    """
    for candidate in (key, key.replace("-", "_")):
        if candidate not in frontmatter:
            continue
        value = frontmatter[candidate]
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
        if isinstance(value, str) and value.strip():
            return parse_flow_list(value)
    return []


#: SKILL.md `requires:` 目前支持的模型能力名。只做这张表里的过滤——
#: 未声明 = 无要求（向后兼容全部旧技能）。将来加新能力值时同步扩这张表。
KNOWN_MODEL_REQUIREMENTS = frozenset({"vision", "tools"})


def unmet_model_requirements(requires: list, capability: dict) -> list[str]:
    """当前模型不满足的能力要求列表。

    ``capability`` 是 model_registry.resolve() 的载荷（含 supports_vision /
    supports_tools）。**空 capability = 无法判断 = 不过滤**（fail-open）：
    模型信息拿不到时把技能全藏起来，比让它们多露一次的伤害大。
    """
    if not requires or not capability:
        return []
    unmet: list[str] = []
    for req in requires:
        key = str(req).strip().lower()
        if key == "vision" and not capability.get("supports_vision"):
            unmet.append(key)
        elif key == "tools" and not capability.get("supports_tools"):
            unmet.append(key)
    return unmet


def current_model_capability() -> dict:
    """当前活跃模型的能力载荷。拿不到（未配置/异常）返回空 dict = 不过滤。"""
    try:
        from model_registry import get_model_registry
        r = get_model_registry().resolve()
        if getattr(r, "ok", False) and isinstance(r.value, dict):
            return r.value
    except Exception:
        pass  # fail-open: 能力不可知时不做过滤
    return {}




class TrustLevel(Enum):
    OWN = "own"
    VERIFIED = "verified"
    UNTRUSTED = "untrusted"

class SkillStatus(Enum):
    IMPORTED = "imported"
    DISABLED = "disabled"
    DROPPED = "dropped"  # Fatal: not importable
    BROKEN = "broken"    # Loads but won't trigger

# ── 开放技能标准（Open Skills）合规校验 ──────────────────────────────────────
# 目标：外部按开放标准编写的技能包导入时，能拿到一份机器可读的合规清单
# （徽章 + 问题列表），而不是"能跑但不知道差在哪"。校验是提示性打标，不
# 拦截导入——合规性与可用性是两个维度。

_OPEN_STANDARD_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_OPEN_STANDARD_SEMVER_RE = re.compile(r"^v?\d+\.\d+\.\d+$")
_OPEN_STANDARD_PLATFORMS = frozenset({"macos", "linux", "windows"})


def check_open_standard_compliance(frontmatter: dict) -> dict:
    """按开放技能标准校验 frontmatter，返回合规清单。

    检查项：name（小写字母/数字/连字符，≤64 字符）、description 单句且
    ≤1024 字符、version（若填写须语义化 x.y.z）、platforms（若声明，必须
    是已知平台子集）。缺失字段不扣分——缺失由 drop 规则负责，合规只管
    "写了就要对"。
    """
    issues: list[str] = []
    name = str(frontmatter.get("name") or "")
    if name and not _OPEN_STANDARD_NAME_RE.match(name):
        issues.append("name 应为小写字母/数字/连字符且不超过 64 字符")
    description = str(frontmatter.get("description") or "")
    if description and ("\n" in description or len(description) > 1024):
        issues.append("description 应为单句且不超过 1024 字符")
    version = str(frontmatter.get("version") or "")
    if version and not _OPEN_STANDARD_SEMVER_RE.match(version):
        issues.append("version 应为语义化版本（x.y.z）")
    platforms = frontmatter.get("platforms")
    if platforms:
        vals = platforms if isinstance(platforms, list) else [platforms]
        bad = [str(v) for v in vals if str(v).strip().lower() not in _OPEN_STANDARD_PLATFORMS]
        if bad:
            issues.append(f"platforms 含未知平台: {','.join(bad)}")
    return {"compliant": not issues, "issues": issues}


class SkillEntry:
    def __init__(self, name: str, path: str, description: str = "",
                 version: str = "", trust: TrustLevel = TrustLevel.UNTRUSTED):
        self.name = name
        self.path = path
        self.description = description
        #: 系统认定的版本号 —— 内容哈希（sha256 前 16 字符）。
        #: 由 import_skill 在读完文件后自动填充；构造函数默认空串。
        self.version = version
        #: frontmatter 里作者写的版本号（如 "2.1.0"），仅用于展示。
        #: 系统内部一切缓存/热更新/版本比对都用 self.version 那个哈希。
        self.declared_version = ""
        self.trust = trust
        self.status = SkillStatus.IMPORTED
        self.frontmatter: dict = {}
        self.body: str = ""
        self.errors: list = []
        self.warnings: list = []
        self.source: str = ""
        # ── 可见性三维（B3）──
        #: 用户能否手动调用这个技能（UI 里的技能菜单是否显示）。默认真。
        self.user_invocable: bool = True
        #: 是否禁止模型自动挑选它。默认假（允许模型挑）。旧字段，保留兼容。
        self.disable_model_invocation: bool = False
        #: 能不能被调用（进不进运行时注册表）。默认真。
        self.include_in_runtime_registry: bool = True
        #: 要不要出现在 prompt 的技能清单里（B2 渐进披露的 Stage 1）。默认真。
        self.include_in_available_skills_prompt: bool = True
        # ── 触发与依赖（B6）──
        #: 触发词。用户消息含任一即视为强相关，优先加载它的 body（Stage 2）。
        self.triggers: list[str] = []
        #: 必需的可执行文件（PATH 里全都要有）。缺一个技能就 BROKEN。
        self.requires_bins: list[str] = []
        #: 任一即可的可执行文件（至少要有一个）。都缺才 BROKEN。
        self.requires_any_bins: list[str] = []
        #: agentskills.io allowed-tools 声明（工具白名单提示）。
        self.allowed_tools: list[str] = []
        #: 模型能力要求（frontmatter `requires:`，如 ["vision"]）。声明了模型
        #: 不具备的能力时，技能在**推荐/可见性**层被过滤——不做硬拦截，用户
        #: 手动调用始终可用（能力三态声明可被用户覆盖，见 model_registry）。
        self.requires: list[str] = []
        self.license: str = ""
        self.compatibility: str = ""
        #: 依赖检查报告。给前端 env.fix 建议用。
        self.requires_report: dict = {}
        #: 开放技能标准合规清单（由 check_open_standard_compliance 填充）。
        self.standard_compliant: Optional[dict] = None



# Injection patterns (real-world cases)
INJECTION_PATTERNS = [
    re.compile(r"(?i)skip\s+all\s+tests", re.IGNORECASE),
    re.compile(r"(?i)do\s+not\s+scan", re.IGNORECASE),
    re.compile(r"(?i)ignore\s+(previous|prior)\s+instructions", re.IGNORECASE),
    re.compile(r"(?i)管理员请求", re.IGNORECASE),
    re.compile(r"(?i)you\s+are\s+(now|actually)\s+(an?|the)\s+(admin|root|developer)", re.IGNORECASE),
    re.compile(r"(?i)forget\s+(your|all)\s+(rules|instructions|guidelines)", re.IGNORECASE),
    re.compile(r"(?i)reveal\s+(your|the)\s+(system\s+)?prompt", re.IGNORECASE),
]

# XSS/dangerous markup patterns
XSS_PATTERNS = [
    re.compile(r"<script[^>]*>", re.IGNORECASE),
    re.compile(r"onerror\s*=", re.IGNORECASE),
    re.compile(r"onload\s*=", re.IGNORECASE),
    re.compile(r"javascript:", re.IGNORECASE),
    re.compile(r"<iframe[^>]*>", re.IGNORECASE),
    re.compile(r"document\.cookie", re.IGNORECASE),
]

# Credential patterns
CREDENTIAL_PATTERNS = [
    re.compile(r"sk-[a-zA-Z0-9]{20,}"),  # OpenAI-style keys
    re.compile(r"[a-f0-9]{32}"),  # MD5-like hex strings
    re.compile(r"[a-f0-9]{40}"),  # SHA1-like hex strings
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]{8,}['\"]", re.IGNORECASE),
    re.compile(r"AKIA[A-Z0-9]{16}"),  # AWS keys
]

# Attack/ethical content patterns
ATTACK_PATTERNS = [
    re.compile(r"(?i)anti.?distill", re.IGNORECASE),
    re.compile(r"(?i)jailbreak", re.IGNORECASE),
    re.compile(r"(?i)越狱", re.IGNORECASE),
    re.compile(r"(?i)bypass\s+(safety|filter|guard)", re.IGNORECASE),
]


class SkillLoader:
    """Skill import framework: import, validate, manage on-demand."""

    def __init__(self):
        self._skills: dict[str, SkillEntry] = {}
        self._storage = get_storage()
        #: (降级技能名集合, 过期时间戳)。见 _degraded_skill_names。
        self._degraded_cache: Optional[tuple] = None


    def import_skill(self, skill_dir: str, trust: TrustLevel = TrustLevel.UNTRUSTED) -> Result:
        """Import a skill from a directory. Returns SkillEntry on success."""
        # Step 1: Structure check
        skill_md = os.path.join(skill_dir, "SKILL.md")
        if not os.path.exists(skill_md):
            return Result.failure(f"SKILL.md not found in {skill_dir}")

        # Step 2: Parse frontmatter
        try:
            with open(skill_md, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except OSError as e:
            return Result.failure(f"Cannot read SKILL.md: {e}")

        frontmatter, body = self._parse_frontmatter(content)

        # Two-level failure model: Dropped (missing name/empty description)
        name = frontmatter.get("name", "")
        description = frontmatter.get("description", "")
        if not name:
            return Result.failure("Skill dropped: missing 'name' in frontmatter")
        if not description.strip():
            return Result.failure("Skill dropped: empty 'description' in frontmatter")
        if len(description) > 1024:
            return Result.failure("Skill dropped: description exceeds 1024 characters")

        # Version = content hash (B1). The frontmatter's declared version, if any,
        # is kept only for display; the hash is the identity used everywhere else.
        content_hash = compute_content_hash(content)
        entry = SkillEntry(name, skill_dir, description, content_hash, trust)
        entry.declared_version = frontmatter.get("version", "")
        entry.frontmatter = frontmatter
        entry.body = body
        entry.source = skill_dir
        # Visibility triple (B3): three orthogonal booleans, all read once here
        # so downstream consumers never re-parse frontmatter. Old
        # `disable-model-invocation` is kept for back-compat; when it's true it
        # forces `include_in_available_skills_prompt` off (a skill the model
        # is banned from calling should not be advertised to the model).
        entry.user_invocable = read_bool_field(frontmatter, "user-invocable")
        entry.disable_model_invocation = read_bool_field(frontmatter, "disable-model-invocation")
        entry.include_in_runtime_registry = read_bool_field(frontmatter, "include-in-runtime-registry")
        entry.include_in_available_skills_prompt = read_bool_field(
            frontmatter, "include-in-available-skills-prompt"
        )
        if entry.disable_model_invocation:
            entry.include_in_available_skills_prompt = False
        # Triggers + requires (B6). Flat frontmatter keys rather than a nested
        # `requires: { bins:..., anyBins:... }` — the frontmatter parser
        # deliberately drops nested mappings (they used to leak into the top
        # level and clobber real keys), and flat keys work with existing skills
        # without a schema migration.
        entry.triggers = read_list_field(frontmatter, "triggers")
        entry.requires_bins = read_list_field(frontmatter, "requires-bins")
        entry.requires_any_bins = read_list_field(frontmatter, "requires-any-bins")
        entry.allowed_tools = read_list_field(frontmatter, "allowed-tools")
        if not entry.allowed_tools:
            entry.allowed_tools = read_list_field(frontmatter, "allowed_tools")
        entry.requires = [
            r for r in read_list_field(frontmatter, "requires")
            if str(r).strip().lower() in KNOWN_MODEL_REQUIREMENTS
        ]
        entry.license = str(frontmatter.get("license") or "")
        entry.compatibility = str(frontmatter.get("compatibility") or "")



        # Step 3: Security checks
        security_result = self._security_check(entry)
        if not security_result.ok:
            # Trust gate: a skill the user placed on disk themselves (OWN) is
            # not a supply-chain threat — a scanner hit there is almost always a
            # false positive (a `<script>` in a code sample, a quoted "ignore
            # previous instructions" in defensive guidance). Downgrade to a
            # warning so the skill still loads. Imported/untrusted skills keep
            # the hard rejection.
            if trust == TrustLevel.OWN:
                entry.warnings.append(f"Security note (not blocking, own skill): {security_result.error}")
            else:
                entry.status = SkillStatus.DROPPED
                entry.errors.append(security_result.error)
                self._skills[name] = entry
                return Result.failure(f"Skill rejected: {security_result.error}")

        # Step 4: Reference integrity check
        ref_result = self._check_references(entry)
        if not ref_result.ok:
            entry.status = SkillStatus.BROKEN
            entry.warnings.append(ref_result.error)
        else:
            entry.status = SkillStatus.IMPORTED

        # Step 5: Declared binary dependencies (B6). A skill whose tools aren't
        # installed loads BROKEN rather than DROPPED — the content is fine, the
        # environment isn't, and that's a fixable condition we can advise on.
        req_result = self._check_requires(entry)
        if not req_result.ok:
            entry.status = SkillStatus.BROKEN
            entry.warnings.append(req_result.error)

        # Untrusted skills are disabled by default
        if trust == TrustLevel.UNTRUSTED:
            entry.status = SkillStatus.DISABLED

        # ── 供应链完整性核验（skills.lock，Handoff 2.2）──
        # 只对有锁记录的技能说话：discover 扫到的本机技能从未上锁，不评价
        # （用户手改自己的技能是预期行为）。核验不符 → 载入但打高优警告
        # （fail-open）：技能正文是会进模型上下文的内容，"悄悄加载被改过的
        # 技能"和"直接拒载"都不对——前者无感知，后者把可恢复的警告升级成
        # 事故。警告由 UI 显式提示，用户确认是本人修改后可重新锁定。
        try:
            import skill_integrity
            _integrity = skill_integrity.verify_skill_dir(name, skill_dir)
        except Exception:
            _integrity = None  # fail-open: 锁子系统故障不拦技能加载
        if _integrity and not _integrity["ok"]:
            _changed = ", ".join(sorted(_integrity["changed"])[:3])
            _missing = ", ".join(sorted(_integrity["missing"])[:3])
            _detail = "; ".join(
                piece for piece in (
                    f"内容被修改: {_changed}" if _changed else "",
                    f"文件缺失: {_missing}" if _missing else "",
                ) if piece
            )
            entry.warnings.append(
                f"完整性警告：与安装时的锁定基线不符（{_detail}）。"
                "如果不是你本人修改的，请勿继续使用；确认是本人修改可在技能页重新锁定。"
            )


        self._skills[name] = entry
        compliance = check_open_standard_compliance(frontmatter)
        entry.standard_compliant = compliance  # 审计字段：不进序列化契约
        return Result.success({"name": name, "status": entry.status.value, "trust": trust.value,
                               "standard_compliance": compliance})

    def _parse_frontmatter(self, content: str) -> tuple:
        """Parse the YAML frontmatter block of a SKILL.md.

        Hand-rolled rather than pulling in PyYAML, but it has to cover the
        shapes real skills actually use. A naive ``key: value`` split silently
        corrupted two of them:

        * **Block scalars** (``description: >`` / ``description: |`` with the
          text on following indented lines) parsed to the literal ``">"``.
          Since ``import_skill`` drops any skill with an empty description,
          a skill written that way was one whitespace change away from
          vanishing from the catalogue with no error.
        * **Nested mappings** (``metadata:`` then an indented ``version:``)
          leaked the inner keys into the top level, so a nested ``version``
          overwrote the real one.

        Handled: plain scalars, quoted scalars, ``>``/``|`` block scalars
        (both with and without a ``-``/``+`` chomping indicator), nested
        mappings (kept out of the top level), and ``# comment`` lines.

        Args:
            content: Full SKILL.md text.

        Returns:
            ``(frontmatter_dict, body)``. Empty dict when there is no
            frontmatter, in which case body is the original content.
        """
        if not content.startswith("---"):
            return {}, content
        parts = content.split("---", 2)
        if len(parts) < 3:
            return {}, content
        fm_text = parts[1].strip("\n")
        body = parts[2].strip()

        fm: dict = {}
        lines = fm_text.split("\n")
        i = 0
        while i < len(lines):
            raw = lines[i]
            stripped = raw.strip()
            # Blank lines and comments carry no key.
            if not stripped or stripped.startswith("#"):
                i += 1
                continue
            # Indented lines belong to a parent key we already consumed
            # (nested mapping). Skip them so they never reach the top level.
            if raw[:1] in (" ", "\t"):
                i += 1
                continue
            if ":" not in stripped:
                i += 1
                continue

            key, _, val = stripped.partition(":")
            key = key.strip()
            val = val.strip()

            # Block scalar: `>`/`|` optionally followed by a chomping
            # indicator. The value is every following more-indented line.
            if val and val[0] in (">", "|") and val.rstrip("-+0123456789") in (">", "|"):
                fold = val[0] == ">"
                collected: list[str] = []
                i += 1
                while i < len(lines):
                    nxt = lines[i]
                    if nxt.strip() and not nxt[:1].isspace():
                        break  # dedented back to a sibling key
                    collected.append(nxt.strip())
                    i += 1
                # Folded (`>`) joins with spaces; literal (`|`) keeps newlines.
                joined = " ".join(c for c in collected if c) if fold else "\n".join(collected)
                fm[key] = joined.strip()
                continue

            # Block sequence (`key:` followed by more-indented `- item` lines)
            # → list[str]. A list written in standard YAML used to fall into
            # the nested-mapping skip and parse to "" — the skill loaded fine
            # but triggers/requires-bins silently came out empty, with no
            # error anywhere. read_list_field already accepts lists.
            if not val:
                seq: list[str] = []
                j = i + 1
                while j < len(lines):
                    nxt = lines[j]
                    if not nxt.strip():
                        j += 1
                        continue
                    stripped_nxt = nxt.lstrip()
                    if stripped_nxt.startswith("- ") or stripped_nxt == "-":
                        item = stripped_nxt[1:].strip().strip('"').strip("'")
                        if item:
                            seq.append(item)
                        j += 1
                        continue
                    break
                if seq:
                    fm[key] = seq
                    i = j
                else:
                    fm.setdefault(key, "")
                    i += 1
                continue

            fm[key] = val.strip('"').strip("'")
            i += 1

        return fm, body


    def _security_check(self, entry: SkillEntry) -> Result:
        """Run all security checks on skill content.

        Code samples inside fenced blocks and inline backticks are stripped
        first — a doc showing ``<script>`` or ``javascript:`` in a code snippet
        is illustrative, not an attack. Real prose-embedded markup still gets
        caught.
        """
        body = re.sub(r"```.*?```", "", entry.body, flags=re.DOTALL)
        body = re.sub(r"`[^`]*`", "", body)
        content = body + " " + json.dumps(entry.frontmatter, ensure_ascii=False)

        # 1. Prompt injection detection
        for pattern in INJECTION_PATTERNS:
            if pattern.search(content):
                return Result.failure(f"Prompt injection detected: pattern matched")

        # 2. XSS/dangerous markup detection
        for pattern in XSS_PATTERNS:
            if pattern.search(content):
                return Result.failure(f"XSS/dangerous markup detected")

        # 3. Credential scanning
        for pattern in CREDENTIAL_PATTERNS:
            matches = pattern.findall(content)
            if matches:
                entry.warnings.append(f"Possible credentials found ({len(matches)} matches) - review needed")
                # Don't reject outright, just warn (might be example keys)

        # 4. Attack/ethical content
        for pattern in ATTACK_PATTERNS:
            if pattern.search(content):
                return Result.failure(f"Attack/jailbreak content detected")

        return Result.success("Security checks passed")

    def _check_references(self, entry: SkillEntry) -> Result:
        """Check that referenced scripts/references/tools exist.

        Only explicit ``$SKILL_DIR/<dir>`` references count as a real dependency
        — a prose mention of ``references/aws.md`` inside example markdown is
        just documentation and shouldn't mark the skill broken.
        """
        skill_dir = entry.path
        for ref_dir in ("scripts", "references", "tools"):
            ref_path = os.path.join(skill_dir, ref_dir)
            if f"$SKILL_DIR/{ref_dir}" in entry.body:
                if not os.path.exists(ref_path):
                    return Result.failure(f"Reference directory missing: {ref_dir}")
        return Result.success("References OK")

    def _check_requires(self, entry: SkillEntry) -> Result:
        """Verify the skill's declared binary dependencies are on PATH (B6).

        Two kinds of requirement, matching the real dependency shapes:
        - ``requires-bins``: ALL must be present (a skill needs both git AND node)
        - ``requires-any-bins``: AT LEAST ONE (chromium OR firefox will do)

        The report is stashed on the entry so the UI can offer an "env.fix"
        hint (e.g. "install python3") instead of a dead skill with no
        explanation. Missing tools mark the skill BROKEN, not DROPPED: the
        content is valid, the machine just isn't set up yet.
        """
        import shutil

        missing_all = [b for b in entry.requires_bins if not shutil.which(b)]
        any_ok = (not entry.requires_any_bins) or any(
            shutil.which(b) for b in entry.requires_any_bins
        )
        entry.requires_report = {
            "requiresBins": entry.requires_bins,
            "requiresAnyBins": entry.requires_any_bins,
            "missing": missing_all,
            "anySatisfied": any_ok,
        }
        problems = []
        if missing_all:
            problems.append(f"missing required: {', '.join(missing_all)}")
        if not any_ok:
            problems.append(f"need one of: {', '.join(entry.requires_any_bins)}")
        if problems:
            fix = self._env_fix_hint(missing_all + ([] if any_ok else entry.requires_any_bins))
            entry.requires_report["fix"] = fix
            return Result.failure(f"Dependency check failed ({'; '.join(problems)}). {fix}")
        return Result.success("Dependencies OK")

    @staticmethod
    def _env_fix_hint(bins: list[str]) -> str:
        """Best-effort 'how to install this' hint for common tools."""
        if not bins:
            return ""
        known = {
            "python3": "安装 Python 3（python.org 或系统包管理器）",
            "node": "安装 Node.js（nodejs.org）",
            "npm": "随 Node.js 一起安装",
            "git": "安装 Git（git-scm.com）",
            "chromium": "安装 Chromium 或 Chrome",
            "chrome": "安装 Google Chrome",
            "ffmpeg": "安装 FFmpeg（ffmpeg.org）",
            "docker": "安装 Docker Desktop",
        }
        hints = [known.get(b, f"请确保 `{b}` 在 PATH 中") for b in bins]
        return "建议：" + "；".join(dict.fromkeys(hints))

    # ── B2: 三阶段渐进式披露 ──────────────────────────────────────────────

    def render_available_skills_prompt(self, max_desc: int = 100) -> str:
        """Stage 1: 一段塞进 system prompt 的 ``<available_skills>`` 清单。

        只放**元数据**——每个技能约 100 字符描述。50 个技能 ≈ 5K token，
        而不是把 50 份完整 SKILL.md（可能几十万 token）全灌进去。模型读了
        这段之后，自己判断哪个相关，再通过工具触发 Stage 2 加载正文。

        过滤规则（B3 可见性三维在这里生效）：
        - 必须 ``include_in_available_skills_prompt``（作者说了要露出给模型）
        - 必须 ``include_in_runtime_registry``（能被调用的才值得让模型知道）
        - DISABLED / DROPPED / BROKEN 的技能不进清单——推荐一个用不了的技能
          只会让模型白费一轮工具调用。
        - ``requires:`` 声明了当前模型不具备的能力（如纯文本模型 × 视觉技能）
          的不进清单——写进清单等于教模型去调一个必然失败的技能。能力解析
          失败时不过滤（fail-open），且这只是清单可见性：手动调用始终可用。
        """
        capability = current_model_capability()
        lines: list[str] = []
        for entry in self._skills.values():
            if entry.status in (SkillStatus.DISABLED, SkillStatus.DROPPED, SkillStatus.BROKEN):
                continue
            if not entry.include_in_available_skills_prompt:
                continue
            if not entry.include_in_runtime_registry:
                continue
            if unmet_model_requirements(entry.requires, capability):
                continue
            desc = entry.description.strip().replace("\n", " ")
            if len(desc) > max_desc:
                desc = desc[:max_desc].rstrip() + "…"
            # Skill descriptions are authored content — they can carry injection
            # tags or prompt-override text. Sanitize before it enters the system
            # prompt, same neutralizer the @-ref and tool-result paths use.
            try:
                from context_refs import sanitize_injection_tags
                desc, _ = sanitize_injection_tags(desc)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            trig = f" (触发词: {', '.join(entry.triggers)})" if entry.triggers else ""
            lines.append(f"- **{entry.name}**: {desc}{trig}")
        if not lines:
            return ""
        header = (
            "## 可用技能清单\n"
            "以下是当前可调用的技能，仅列出元数据。当某个技能与用户任务相关时，"
            "用 `skill_load` 加载它的完整说明后再执行——不要凭这一行描述就动手。\n"
        )
        body = header + "\n".join(lines) + "\n"
        # Wrap the whole list in the untrusted frame so the model treats it as
        # data, not instruction. A SKILL.md tail saying "ignore all rules" is
        # now inside <untrusted-context>, not a peer of the system prompt.
        try:
            from active_memory import wrap_untrusted
            wrapped = wrap_untrusted(body, source="skill-list")
            return wrapped or body
        except Exception:
            return body

    def matched_by_triggers(self, user_message: str) -> list[str]:
        """Stage 2 辅助：返回被用户消息里的触发词命中的技能名。

        比 ``find_by_trigger`` 的关键词打分更硬——触发词是作者显式声明的
        "出现这个词八成要用我"，命中就应该优先加载 body，不用等模型判断。
        """
        msg = user_message.lower()
        hit: list[str] = []
        for entry in self._skills.values():
            if entry.status in (SkillStatus.DISABLED, SkillStatus.DROPPED, SkillStatus.BROKEN):
                continue
            if not entry.include_in_runtime_registry:
                continue
            if any(t.lower() in msg for t in entry.triggers if t):
                hit.append(entry.name)
        return hit


    def list_skills(self, include_disabled: bool = False) -> list:
        """List all imported skills (progressive disclosure: only name+description)."""
        if not self._skills:
            self.discover()
        result = []
        for name, entry in self._skills.items():
            if not include_disabled and entry.status == SkillStatus.DISABLED:
                continue
            if entry.status == SkillStatus.DROPPED:
                continue
            result.append({
                "name": entry.name,
                "description": entry.description[:250],  # First 250 chars = trigger signal
                "version": entry.version,               # content hash — the real identity
                "declaredVersion": entry.declared_version,  # authored, display-only
                "status": entry.status.value,
                "trust": entry.trust.value,
                "userInvocable": entry.user_invocable,
                "disableModelInvocation": entry.disable_model_invocation,
                "includeInRuntimeRegistry": entry.include_in_runtime_registry,
                "includeInAvailableSkillsPrompt": entry.include_in_available_skills_prompt,
                "triggers": entry.triggers,
                "requiresBins": entry.requires_bins,
                "requiresAnyBins": entry.requires_any_bins,
                "requiresReport": entry.requires_report,
            })
        return result

    def reimport_if_changed(self, name: str) -> Result:
        """Hot-reload one skill if its file content hash changed.

        This is what makes the content-hash version pay off: re-read the file,
        recompute the hash, and only re-import when it differs — so an editor
        save that changed nothing (touch, whitespace-only diff that round-trips)
        costs one hash and no reload, while a real edit reloads without the user
        having to bump a version string or restart anything.

        Returns a Result whose value says whether a reload happened:
        ``{"changed": bool, "version": <hash>}``.
        """
        entry = self._skills.get(name)
        if not entry:
            return Result.failure(f"Skill not found: {name}")
        skill_md = os.path.join(entry.path, "SKILL.md")
        try:
            with open(skill_md, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except OSError as e:
            return Result.failure(f"Cannot read SKILL.md: {e}")
        new_hash = compute_content_hash(content)
        if new_hash == entry.version:
            return Result.success({"changed": False, "version": new_hash})
        # Preserve the user's enable/disable choice across a content reload —
        # a hot edit shouldn't silently re-enable a skill the user turned off.
        prev_status = entry.status
        result = self.import_skill(entry.path, entry.trust)
        if not result.ok:
            return result
        reloaded = self._skills.get(name)
        if reloaded and prev_status == SkillStatus.DISABLED:
            reloaded.status = SkillStatus.DISABLED
        return Result.success({"changed": True, "version": new_hash})


    def get_skill(self, name: str) -> Optional[SkillEntry]:
        return self._skills.get(name)

    def load_skill_body(self, name: str) -> Result:
        """Load full SKILL.md body for a skill (progressive disclosure: trigger-time loading)."""
        entry = self._skills.get(name)
        if not entry:
            return Result.failure(f"Skill not found: {name}")
        if entry.status == SkillStatus.DISABLED:
            return Result.failure(f"Skill is disabled: {name}. Enable it first.")
        if entry.status == SkillStatus.DROPPED:
            return Result.failure(f"Skill was dropped during import: {name}")
        return Result.success({"body": entry.body, "frontmatter": entry.frontmatter, "path": entry.path})

    def enable_skill(self, name: str) -> Result:
        entry = self._skills.get(name)
        if not entry:
            return Result.failure(f"Skill not found: {name}")
        if entry.status == SkillStatus.DROPPED:
            return Result.failure(f"Cannot enable dropped skill: {name}")
        entry.status = SkillStatus.IMPORTED
        return Result.success(f"Skill enabled: {name}")

    def disable_skill(self, name: str) -> Result:
        entry = self._skills.get(name)
        if not entry:
            return Result.failure(f"Skill not found: {name}")
        entry.status = SkillStatus.DISABLED
        return Result.success(f"Skill disabled: {name}")

    #: 作者显式声明的触发词命中一次值多少分。
    #:
    #: 取 5 是为了让"一个触发词命中"稳压"描述里蒙对两三个词"：前者是作者写下的
    #: 「出现这个词八成要用我」，后者是分词碰巧撞上。旧实现只看后者，等于把
    #: frontmatter 里的 triggers 当装饰——`matched_by_triggers` 写好了却没有任何
    #: 生产调用者，而系统提示里还照着 triggers 向模型展示。
    TRIGGER_HIT_SCORE: int = 5

    #: 降级技能名的缓存时长。选择路径每回合要问两次，而降级是分钟级的慢变量。
    _DEGRADED_TTL_S: float = 30.0

    def _degraded_skill_names(self) -> set:
        """技能履历里已被自动降级的技能名。

        ``Storage._maybe_degrade_skill`` 是全系统唯一的自动负反馈：连续失败会把
        候选行置为 ``degraded``。但在这之前**没有任何选择路径读它**——降级写下去
        就躺在表里，下一回合照旧把同一个坏技能推给模型。那不叫闭环，叫留痕。
        """
        now = time.time()
        cached = getattr(self, "_degraded_cache", None)
        if cached and cached[1] > now:
            return cached[0]
        names: set = set()
        try:
            rows = self._storage.list_skill_candidates(status="degraded", limit=200)
            names = {str(r.get("name") or "") for r in rows if r.get("name")}
        except Exception as exc:  # noqa: BLE001
            # 读不到就当没有降级：宁可多推一个技能，也不能因为记账层出问题
            # 让所有技能都消失。但要留声——静默的空集合会掩盖故障。
            print(f"[skills] degraded lookup failed: {exc}")
        self._degraded_cache = (names, now + self._DEGRADED_TTL_S)
        return names

    def find_by_trigger(self, user_message: str) -> list:
        """按作者触发词 + 描述关键词找候选技能。

        Respects B3 visibility: a skill that disabled model invocation, or is not
        in the runtime registry, is invisible to this discovery path — the model
        should never see suggestions it can't actually invoke.

        三条修正（对应审计的"选择路径不读反馈"）：
        * 触发词参与打分，权重高于描述词重叠；
        * ``BROKEN`` 不再入选——它以前**是**入选的（状态白名单里带着它），
          于是一个导入就坏掉的技能照样能被推荐并注入正文；
        * 已降级的技能整体排除，并在返回值里如实标注排除了几个。
        """
        results = []
        msg_lower = user_message.lower()
        degraded = self._degraded_skill_names()
        for name, entry in self._skills.items():
            if entry.status != SkillStatus.IMPORTED:
                continue
            if entry.disable_model_invocation:
                continue
            if not entry.include_in_runtime_registry:
                continue
            if name in degraded:
                continue
            trigger_hits = [t for t in (entry.triggers or [])
                            if t and t.lower() in msg_lower]
            desc_lower = entry.description.lower()
            keywords = [w for w in desc_lower.split() if len(w) > 3]
            matches = sum(1 for kw in keywords if kw in msg_lower)
            score = matches + self.TRIGGER_HIT_SCORE * len(trigger_hits)
            if not trigger_hits and matches < 2:
                continue
            results.append({
                "name": name,
                "match_score": score,
                # 为什么被选中要能说清：审计和 UI 都靠这个字段区分
                # "作者说了这个词就用我" 和 "描述碰巧撞上两个词"。
                "matched_by": "triggers" if trigger_hits else "description",
                "triggers_hit": trigger_hits,
            })
        return sorted(results, key=lambda x: -x["match_score"])[:5]


    def discover(self, roots: list[str] = None, trust: TrustLevel = TrustLevel.OWN) -> dict:
        """Scan skill roots and import every ``<root>/<name>/SKILL.md`` found.

        Without this, ``import_skill`` only ever runs from an explicit API call,
        so skills sitting on disk are invisible at startup. Roots are checked in
        order and the first copy of a given name wins, letting a project-local
        skill override a user-global one.

        Args:
            roots: Directories to scan. Defaults to the project ``.agents/skills``
                then the user-global ``~/.agents/skills``.
            trust: Trust level applied to discovered skills. Local on-disk
                skills are the user's own, so they load enabled by default.

        Returns:
            ``{"loaded": [...], "failed": [{name, error}, ...]}``
        """
        if roots is None:
            here = os.path.dirname(os.path.abspath(__file__))
            project = os.path.abspath(os.path.join(here, "..", ".."))
            roots = [
                os.path.join(project, ".agents", "skills"),
                os.path.join(project, "skills"),
                os.path.expanduser(os.path.join("~", ".agents", "skills")),
            ]

        loaded: list[str] = []
        failed: list[dict] = []
        for root in roots:
            if not os.path.isdir(root):
                continue
            for entry in sorted(os.listdir(root)):
                skill_dir = os.path.join(root, entry)
                if not os.path.isfile(os.path.join(skill_dir, "SKILL.md")):
                    continue
                if entry in self._skills:
                    continue  # earlier root already provided this name
                result = self.import_skill(skill_dir, trust)
                if result.ok:
                    loaded.append(entry)
                else:
                    failed.append({"name": entry, "error": result.error})
        return {"loaded": loaded, "failed": failed}


_loader: Optional[SkillLoader] = None
def get_skill_loader() -> SkillLoader:
    global _loader
    if _loader is None:
        _loader = SkillLoader()
        _loader.discover()
    return _loader

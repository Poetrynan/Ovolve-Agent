"""command_classifier.py - 命令内容分级器：shell 文本 → 级别 + 风险旗标。

## 解决什么

工具级的风险表（TOOL_RISK_LEVELS）回答的是"这个**工具**多危险"，但
shell_executor 的危险程度完全取决于**命令文本**——同一个工具，`ls` 和
`mkfs` 天差地别。本模块补上内容这一维：对命令文本做机械解析（Rust 的
command_guard 原语）+ 规则表定级，作为工具策略管道的 COMMAND 层。

## 级别模型（四级，与权限档位解耦）

    ALLOW      机械安全——不带旗标，不参与定级
    REVIEW     需确认——网络出口、提权、装包、杀进程等"合理但要看一眼"
    RESTRICTED 高危——破坏性、系统状态、远程代码执行、持久化。
               这类操作的失误不可撤回，因此**不参与自动放行**：无论权限档位
               如何都至少落到 ASK（CRITICAL 语义，只有显式人工批准可过）；
               收紧到 DENY 由 `restrictedAction` 控制，默认 ask。

规则表只收**形态**（shape），不收业务：`rm` 本身不是红线（日常清构建产物），
`rm -rf /` 才是。每条规则带注释说明"为什么这条在此级别"——分级表里一条
没有理由的规则，三个月后就是一条没人敢删也没人敢改的黑巫术。

## 网络出口策略

命令文本里出现的 host 会过一道白/黑名单（声明式，config 可调）：
deny 命中 → RESTRICTED；closed 模式下 allow 不命中 → REVIEW（未知出口
"问一下"而不是"直接死"，企业内网白名单没配全时降级体验可控）。
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

from tool_policy import PolicyAction, PolicyDecision, PolicyLayer, PolicyRequest

from rust_adapters import command_guard as cg


class Tier(str, Enum):
    """命令文本的机械定级。ALLOW 不产生裁决；REVIEW→ASK；RESTRICTED→ASK（可收紧为 DENY）。"""

    ALLOW = "allow"
    REVIEW = "review"
    RESTRICTED = "restricted"


#: 风险旗标（audit/UI 用，与级别正交：一条命令可以同时带 network + privilege）。
FLAG_NETWORK = "network-egress"
FLAG_DESTRUCTIVE = "fs-destructive"
FLAG_SYSTEM_STATE = "system-state"
FLAG_REMOTE_EXEC = "remote-code-exec"
FLAG_ELEVATION = "privilege-escalation"
FLAG_PERSISTENCE = "persistence"
FLAG_PROCESS_KILL = "process-kill"
FLAG_CREDENTIAL = "credential-access"


@dataclass
class Rule:
    """一条分级规则 = 命中的机械形态 + 它在此级别的原因。"""

    rule_id: str
    flag: str
    tier: Tier
    # 命中判定：命令 token 首词或任意位置匹配（大小写不敏感）
    words: tuple[str, ...] = ()
    regex: Optional[re.Pattern] = None
    why: str = ""
    #: 结构化判定：词表与正则都压不平的二维关系（见 _INSTALL_TABLE）
    matcher: Optional[Callable[[list[str]], bool]] = None

    def hit(self, tokens: list[str], text: str) -> bool:
        # 词表匹配带"首标签等价"：Windows 下可执行文件常带扩展名
        # （mkfs.ext4、shutdown.exe），首个 '.' 前的部分与词表相等即命中。
        # 只切第一段标签——"sudoers" 不会被 "sudo" 误吞。
        if self.words:
            for t in tokens:
                if t in self.words or t.split(".", 1)[0] in self.words:
                    return True
        if self.regex is not None and self.regex.search(text):
            return True
        if self.matcher is not None:
            return bool(self.matcher(tokens))
        return False


# ── RESTRICTED：失误不可撤回的形态 ────────────────────────────────────────────
# 级别理由统一写进每条规则的 why，不在这里重复。

_R = Tier.RESTRICTED
_DESTRUCTIVE_RULES: tuple[Rule, ...] = (
    Rule("CG-FS-01", FLAG_DESTRUCTIVE, _R,
         regex=re.compile(r"\brm\s+(-[a-z]*[rf][a-z]*\s+)*(/|~|\*)", re.I),
         why="rm 连打 -r/-f 且目标落在根/家目录/通配——整棵树的不可撤回删除"),
    Rule("CG-FS-02", FLAG_DESTRUCTIVE, _R,
         words=("mkfs", "mkfs.ext4", "mkfs.xfs", "mkfs.ntfs"),
         why="直接在块设备上造文件系统，盘上原有数据全部蒸发"),
    Rule("CG-FS-03", FLAG_DESTRUCTIVE, _R,
         regex=re.compile(r"\bdd\b[^\n|;]*\bof=/dev/", re.I),
         why="dd 直写块设备——等于绕过文件系统裸写磁盘"),
    Rule("CG-FS-04", FLAG_DESTRUCTIVE, _R,
         words=("format", "diskpart", "parted"),
         why="Windows/Linux 卷级格式化与磁盘分区操作，同属不可逆盘面操作"),
    Rule("CG-FS-05", FLAG_DESTRUCTIVE, _R,
         regex=re.compile(r"\b(rd|rmdir)\s+/s\b|\bdel\s+/(f|s|q)\b", re.I),
         why="Windows 递归/强制删除整棵目录"),
    Rule("CG-FS-06", FLAG_DESTRUCTIVE, _R,
         words=("shred", "wipe"),
         why="覆写式抹除，比删除更彻底，同样不可撤回"),
    Rule("CG-FS-07", FLAG_DESTRUCTIVE, _R,
         words=("ddrescue", "sdelete"),
         why="裸盘级读写/安全擦除专用工具——作用对象是盘面而非文件，误用不可撤回"),
)

_SYSTEM_RULES: tuple[Rule, ...] = (
    Rule("CG-SY-01", FLAG_SYSTEM_STATE, _R,
         words=("shutdown", "reboot", "halt", "poweroff"),
         why="改变系统电源状态——用户手里没开着的保存工作会直接丢"),
    Rule("CG-SY-02", FLAG_SYSTEM_STATE, Tier.REVIEW,
         words=("systemctl",),
         why="管理系统服务（启停/开关自启）改变系统运行态，要看一眼"),
)

_REMOTE_EXEC_RULES: tuple[Rule, ...] = (
    # fetch_pipe_exec 的机械检测本身是 RESTRICTED（远程代码直进本机 shell，
    # 来源内容未审计——这是远程执行类命令的经典投毒面）
    Rule("CG-RX-01", FLAG_REMOTE_EXEC, _R,
         regex=None,  # 由 fetch_pipe_exec 特判，见 classify()
         why="网络取回的内容被管道/命令替换直接送进本机解释器——执行的是"
             "运行时才确定的代码，任何静态白名单都约束不了它"),
)

_PERSISTENCE_RULES: tuple[Rule, ...] = (
    Rule("CG-PS-01", FLAG_PERSISTENCE, _R,
         regex=re.compile(r"\b(schtasks\s+/create|crontab\s+-|at\s+)\b", re.I),
         why="写定时任务 = 写持久化入口，影响面超出本次会话"),
    Rule("CG-PS-02", FLAG_PERSISTENCE, _R,
         regex=re.compile(r"\breg\s+(add|delete)\b", re.I),
         why="注册表写/删是系统级持久状态，回滚成本高"),
)

_CREDENTIAL_RULES: tuple[Rule, ...] = (
    Rule("CG-CR-01", FLAG_CREDENTIAL, _R,
         regex=re.compile(r"/etc/(shadow|sudoers)|\b(passwd|chpasswd)\b", re.I),
         why="触碰口令库或 sudoers——认证体系的根基文件"),
)

# 防火墙 = 安全边界本身，代理改边界必须拦下（词表经行业默认拒绝清单交叉核对）

_FIREWALL_RULES: tuple[Rule, ...] = (
    Rule("CG-NG-02", FLAG_SYSTEM_STATE, _R,
         words=("iptables", "nft", "nftables", "firewall-cmd", "ufw"),
         why="改防火墙规则 = 改机器的安全边界——放错一条口子外面看不见，收回来也不知道"),
)

_BOMB_RULES: tuple[Rule, ...] = (
    Rule("CG-PK-02", FLAG_PROCESS_KILL, _R,
         regex=re.compile(r":\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;?\s*:"),
         why="fork 炸弹形态——自我复制的进程爆炸，一条命令拖死整台机器"),
)

# ── 装包判定表（CG-IR-01） ────────────────────────────────────────────────────
#
# "装包"在两个维度上都分化，一条正则压不平：
#   * 同一管理器、不同子命令语义相反：`npm install` 引入外部代码，
#     `npm uninstall` 是移除，`npm test` 跟装包无关。
#     平正则要么漏掉 `npm ci`（按锁文件装，同样是引入外部代码），
#     要么把 `npm uninstall` 一起收进来。
#   * 不同管理器、同一动作叫法不同：npm `add` / gem `install` / apk `add` /
#     go `get` / cargo `install`。
# 所以收成二维表：管理器 → "会把外部代码带进本机"的子命令。逐格可注释、可增删，
# 比一条越写越长的大正则好维护。

#: 管理器前面可能出现的启动器：真正的管理器在它后面
#: （`sudo apt install`、`python -m pip install`、`bash -c "npm install"`）。
#: 判定顺序是先查表再查启动器，所以一个词可以同时是管理器（如 `uv`）。
_INSTALL_LAUNCHERS = {
    "sudo", "doas", "env", "nohup", "command", "time", "nice", "stdbuf",
    "winpty", "uv", "python", "python3", "py", "bash", "sh", "zsh",
    "powershell", "pwsh", "cmd",
}

#: 子命令之前允许出现的修饰词（`yarn global add`）
_INSTALL_MODIFIERS = {"global", "workspace", "workspaces"}

#: 值为空的元组 = 该管理器"取包即执行"，任何调用都算装包：
#: `npx some-pkg` 会先把包拉下来再跑，装与执行在同一条命令里完成，
#: 没有子命令可区分。
_INSTALL_TABLE: dict[str, tuple[str, ...]] = {
    # JS / Node
    "npm": ("install", "i", "ci", "add", "it"),
    "yarn": ("add", "install", "dlx", "global"),
    "pnpm": ("add", "install", "i", "dlx"),
    "bun": ("add", "install", "x"),
    "npx": (),
    "bunx": (),
    # Python
    "pip": ("install", "download"),
    "pip3": ("install", "download"),
    "uv": ("pip", "add", "tool"),
    "uvx": (),
    "poetry": ("add", "install"),
    "conda": ("install", "create"),
    "mamba": ("install",),
    # 系统包管理
    "apt": ("install",),
    "apt-get": ("install",),
    "brew": ("install", "reinstall", "upgrade"),
    "choco": ("install", "upgrade"),
    "winget": ("install", "upgrade"),
    "dnf": ("install",),
    "yum": ("install",),
    "apk": ("add",),
    "zypper": ("install", "in"),
    # 其他语言
    "gem": ("install",),
    "cargo": ("install", "add"),
    "go": ("get", "install"),
    "composer": ("require", "install"),
    "bundle": ("install",),
    "dotnet": ("add", "restore"),
}


def _first_subcommand(rest: list[str]) -> str:
    """跳过开关与修饰词，取出真正的子命令。"""
    for tok in rest:
        low = tok.lower()
        if low.startswith("-") or low in _INSTALL_MODIFIERS:
            continue
        return low.split(".", 1)[0]
    return ""


def _is_install_command(tokens: list[str]) -> bool:
    """管理器 × 子命令二维命中。见 ``_INSTALL_TABLE``。

    只在前三个 token 里找管理器：再往后就是包参数了（`npm i lodash`
    里的 `lodash` 不该被当成管理器）。遇到既不是启动器也不是开关的未知词就停
    ——否则 `grep "npm install" README` 也会被当成装包。
    """
    for i, raw in enumerate(tokens[:3]):
        tok = raw.lower().split(".", 1)[0]
        verbs = _INSTALL_TABLE.get(tok)
        if verbs is not None:
            if not verbs:
                return True  # 取包即执行型（npx/bunx/uvx）
            return _first_subcommand(tokens[i + 1:]) in verbs
        if tok.startswith("-") or tok in _INSTALL_LAUNCHERS:
            continue
        break
    return False


# ── REVIEW：合理但要人看一眼的形态 ────────────────────────────────────────────

_V = Tier.REVIEW
_REVIEW_RULES: tuple[Rule, ...] = (
    Rule("CG-EL-01", FLAG_ELEVATION, _V,
         words=("sudo", "su", "runas", "doas"),
         why="提权运行——后果以 root/管理员权限落地"),
    Rule("CG-EL-02", FLAG_ELEVATION, _V,
         regex=re.compile(r"\bchmod\b[^|;&]*\b777\b", re.I),
         why="放开为全局可写（777）——权限松绑，配合递归时等于把文件系统向所有进程敞开"),
    Rule("CG-PK-01", FLAG_PROCESS_KILL, _V,
         words=("killall", "pkill", "taskkill"),
         why="按名杀进程——误伤面大于按 pid 杀"),
    Rule("CG-IR-01", FLAG_NETWORK, _V,
         matcher=_is_install_command,
         why="装包 = 把外部代码引入本机执行环境（依赖链风险）"),
    Rule("CG-NG-01", FLAG_NETWORK, _V,
         words=("ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet"),
         why="主动建立对外连接/远端会话"),
    Rule("CG-NG-03", FLAG_NETWORK, _V,
         words=("ifconfig", "ipconfig", "iwconfig", "route"),
         why="查看/改动网络接口与路由表——诊断常用，但 flush/改路由影响连通性"),
    Rule("CG-FS-08", FLAG_SYSTEM_STATE, _V,
         words=("umount", "fsck"),
         why="卸载活动挂载/检查文件系统——时机不对会把用户正用着的卷摘下来"),
)

#: 取回工具词表（fetch_pipe_exec 的"取回"侧）
_FETCHERS = ("curl", "curlie", "wget", "http", "httpie", "iwr",
             "invoke-webrequest", "invoke-restmethod", "fetch",
             "axel", "aria2c", "lynx", "w3m", "links",
             "xh", "http-prompt")

#: 执行工具词表（"执行"侧——能直接解释执行输入流的解释器/shell）
_EXECUTORS = ("sh", "bash", "zsh", "dash", "ksh", "powershell", "pwsh",
              "python", "python3", "node", "perl", "ruby", "php",
              "iex", "invoke-expression")

#: 网络出口规则：命中取回/联网词的命令才做 host 级策略检查
_EGRESS_HINT_WORDS = _FETCHERS + ("ssh", "scp", "sftp", "ftp", "nc", "ncat", "git",
                                  "ping", "rsync", "curl", "wget")

# ── 网络出口策略 ──────────────────────────────────────────────────────────────

@dataclass
class NetworkEgressPolicy:
    """声明式出口策略：deny 恒胜；closed 模式下 allow 未命中 → REVIEW。"""

    allow: tuple[str, ...] = ()
    deny: tuple[str, ...] = ()
    #: open = 白名单空时放行未知出口；closed = 白名单非空时未知出口要问。
    mode: str = "open"

    @classmethod
    def from_config(cls, cfg: Optional[dict]) -> "NetworkEgressPolicy":
        c = cfg if isinstance(cfg, dict) else {}
        return cls(
            allow=tuple(str(x).strip().lower() for x in (c.get("allow") or []) if str(x).strip()),
            deny=tuple(str(x).strip().lower() for x in (c.get("deny") or []) if str(x).strip()),
            mode=str(c.get("mode") or "open").strip().lower(),
        )

    def check(self, hosts: list[str]) -> Optional[tuple[str, tuple[str, ...]]]:
        """返回 (verdict, 命中host) 或 None（无异议）。

        deny 命中 → restricted；closed 且 allow 非空但无命中 → review；
        其余放行。
        """
        for h in hosts:
            hit = cg.domain_suffix_match(h, self.deny)
            if hit:
                return ("restricted", (h, hit))
        if self.mode == "closed" and self.allow:
            for h in hosts:
                if not cg.domain_suffix_match(h, self.allow):
                    return ("review", (h, ""))
        return None


# ── 分级器 ────────────────────────────────────────────────────────────────────

_ALL_RULES: tuple[Rule, ...] = (
    _DESTRUCTIVE_RULES + _SYSTEM_RULES + _REMOTE_EXEC_RULES
    + _PERSISTENCE_RULES + _CREDENTIAL_RULES + _FIREWALL_RULES
    + _BOMB_RULES + _REVIEW_RULES
)

#: 分级器作用的工具白名单——这些工具的 args 里装的是**命令文本**。
#: 不在此列的工具（read_file 等）内容不是命令，跳过机械解析。
SHELL_TOOLS = frozenset({
    "shell_executor", "bash", "run_command", "python_executor",
    "cmd", "powershell", "shell",
    # Carries a command line the same way the entries above do — risk_control
    # already treats it as one when extracting the command for its own checks.
    "native_action_chain",
})

#: 命令文本可能落在的 args 键（不同工具命名不一致）
_COMMAND_ARG_KEYS = ("command", "cmd", "script", "code", "expression", "commandline", "command_text")


@dataclass
class CommandVerdict:
    """一次命令分级的完整产物——audit/UI 消费这个，而不是裸 Tier。"""

    tier: Tier
    flags: list[str] = field(default_factory=list)
    matched: list[str] = field(default_factory=list)   # rule ids
    hosts: list[str] = field(default_factory=list)     # 文本中出现的 host
    segments: int = 0
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "tier": self.tier.value,
            "flags": self.flags,
            "matched": self.matched,
            "hosts": self.hosts,
            "segments": self.segments,
            "reasons": self.reasons,
        }

    @property
    def is_restricted(self) -> bool:
        return self.tier is Tier.RESTRICTED

    @property
    def needs_review(self) -> bool:
        return self.tier is Tier.REVIEW


def _command_text(args: dict) -> str:
    """从工具参数里取命令文本。找不到返回空串（= 无内容可分级）。"""
    for key in _COMMAND_ARG_KEYS:
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return ""


def classify(command: str, *, egress: Optional[NetworkEgressPolicy] = None) -> CommandVerdict:
    """对一段命令文本做完整分级。纯函数；不抛异常（畸形输入→ALLOW 空旗标）。

    级别合成规则：RESTRICTED > REVIEW > ALLOW——任一规则命中即抬升，
    旗标与命中规则累加，全部进 verdict 供审计。
    """
    verdict = CommandVerdict(tier=Tier.ALLOW)
    text = str(command or "")
    if not text.strip():
        return verdict

    try:
        segments = cg.split_segments(text)
    except Exception:
        segments = [text]
    verdict.segments = len(segments)
    tokens: list[str] = []
    for seg in segments:
        try:
            tokens.extend(t.lower() for t in cg.tokenize(seg))
        except Exception:
            tokens.extend(seg.lower().split())

    # 1) 规则表（词表与正则两条命中路径都在 Rule.hit 里，缺一不可——
    #    这里曾有"regex is None 就跳过"的守卫，把全部词表规则静默丢掉了）
    for rule in _ALL_RULES:
        try:
            if rule.hit(tokens, text):
                _absorb(verdict, rule)
        except Exception:
            continue  # 单条规则坏了不拖垮整体——宁缺勿崩

    # 2) 远程取回直执行的机械形态（RESTRICTED，见 CG-RX-01 的 why）。
    #    两个形态面都要看：段内的命令替换（$(curl …|sh) 由适配层判定），
    #    以及**跨段**的管道顺序（`curl x | sh` 被管道拆成两段后，
    #    "取回在前、执行在后"的顺序关系只有整段序列能看见）。
    try:
        saw_fetch_seg = False
        hit_remote_exec = False
        for seg in segments:
            if cg.fetch_pipe_exec(seg, list(_FETCHERS), list(_EXECUTORS)):
                hit_remote_exec = True
                break
            seg_tokens = [t.lower() for t in cg.tokenize(seg)]
            if any(t in _FETCHERS for t in seg_tokens):
                saw_fetch_seg = True
            elif saw_fetch_seg and any(t in _EXECUTORS for t in seg_tokens):
                hit_remote_exec = True
                break
        if hit_remote_exec:
            if FLAG_REMOTE_EXEC not in verdict.flags:
                verdict.flags.append(FLAG_REMOTE_EXEC)
                verdict.matched.append("CG-RX-01")
                verdict.reasons.append(_REMOTE_EXEC_RULES[0].why)
            verdict.tier = Tier.RESTRICTED
    except Exception:
        pass

    # 3) 网络出口策略（deny 恒胜 > closed 白名单外要问）
    # 抽取器不可用绝不能让整条命令"看不见出口"——那是把一次故障变成一次静默
    # 放行。退到 IPv4 正则：域名这一维会漏，但取回词（curl/wget…）与装包表
    # 仍在，最坏是少问一次而不是全瞎。
    try:
        hosts = list(dict.fromkeys(cg.extract_hosts(text) or ()))
    except Exception:
        try:
            hosts = list(dict.fromkeys(
                m.group(0) for m in re.finditer(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", text)))
        except Exception:
            hosts = []
    verdict.hosts = hosts
    if hosts:
        # 有出口意图 → 至少 REVIEW 级的网络旗标（级别抬升由 egress 裁决决定，
        # 裸出现 host 不抬级——`pip install` 已有 CG-IR-01 兜着）
        if FLAG_NETWORK not in verdict.flags:
            verdict.flags.append(FLAG_NETWORK)
        policy = egress if egress is not None else get_egress_policy()
        try:
            outcome = policy.check(hosts)
        except Exception:
            outcome = None
        if outcome:
            kind, detail = outcome
            if kind == "restricted":
                verdict.tier = Tier.RESTRICTED
                verdict.matched.append("CG-EG-DENY")
                verdict.reasons.append(f"网络出口命中拒绝名单: {detail[0]} (规则 {detail[1]})")
            elif verdict.tier is not Tier.RESTRICTED:
                verdict.tier = Tier.REVIEW
                verdict.matched.append("CG-EG-CLOSED")
                verdict.reasons.append(f"closed 模式下出口不在白名单: {detail[0]}")

    # 4) 级别合成（旗标已在上面逐条累加）
    return verdict


def _absorb(verdict: CommandVerdict, rule: Rule) -> None:
    if rule.flag not in verdict.flags:
        verdict.flags.append(rule.flag)
    verdict.matched.append(rule.rule_id)
    if rule.why:
        verdict.reasons.append(rule.why)
    if rule.tier is Tier.RESTRICTED:
        verdict.tier = Tier.RESTRICTED
    elif rule.tier is Tier.REVIEW and verdict.tier is not Tier.RESTRICTED:
        verdict.tier = Tier.REVIEW


# ── 配置加载（进程内单份，与 risk_controller 的 config 读取同款纪律） ─────────

_egress: Optional[NetworkEgressPolicy] = None


def get_egress_policy() -> NetworkEgressPolicy:
    """config.json `permissions.network` → 出口策略。坏配置=默认 open。"""
    global _egress
    if _egress is None:
        try:
            cfg_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f).get("permissions") or {}
            _egress = NetworkEgressPolicy.from_config(cfg.get("network"))
        except Exception:
            _egress = NetworkEgressPolicy()
    return _egress


def reload_egress_policy() -> NetworkEgressPolicy:
    """设置页改完配置后调用——主动失效缓存。"""
    global _egress
    _egress = None
    return get_egress_policy()


# ── 策略管道层 ────────────────────────────────────────────────────────────────

#: 分级结果在 request.context 里的缓存键（同一次调用的后续层/审计复用）
_CONTEXT_VERDICT_KEY = "_command_verdict"


# ── RESTRICTED 的处置动作（渐进收紧） ──────────────────────────────────────────
#
# 规则表收的是形态，形态必然有交集：`rm -rf /tmp/build` 和 `rm -rf /` 命中
# 同一条 fs-destructive 规则，前者是日常操作、后者是事故。分级器是新增能力，
# 没有线上语料校准误报率，所以第一版 RESTRICTED 统一走 ASK：宁可多问一次，
# 不可误杀一条正常命令打断工作流。等误报收敛后把 `restrictedAction` 切成
# "deny" 即可收紧，无需改结构。
_DEFAULT_RESTRICTED_ACTION = "ask"

_restricted_action_cache: Optional[str] = None


def _restricted_action() -> str:
    """config.json `permissions.commandGuard.restrictedAction` → "ask" | "deny"。"""
    global _restricted_action_cache
    if _restricted_action_cache is None:
        action = _DEFAULT_RESTRICTED_ACTION
        try:
            cfg_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
            with open(cfg_path, "r", encoding="utf-8") as f:
                guard = (json.load(f).get("permissions") or {}).get("commandGuard") or {}
            raw = str(guard.get("restrictedAction", "")).strip().lower()
            if raw in ("ask", "deny"):
                action = raw
        except Exception:
            action = _DEFAULT_RESTRICTED_ACTION  # 坏配置退回宽松档，不静默变严
        _restricted_action_cache = action
    return _restricted_action_cache


def reload_command_guard_config() -> str:
    """设置页改完配置后调用——主动失效缓存，返回当前生效动作。"""
    global _restricted_action_cache
    _restricted_action_cache = None
    return _restricted_action()


def make_command_guard_layer() -> Any:
    """COMMAND 层：对命令类工具做内容分级，REVIEW→ASK；RESTRICTED→ASK/DENY 可配。

    层工厂而不是闭包直连：risk_control 在 _install_layers 里注册，测试里
    可以独立构造。层内异常由管道兜底（fail-safe = deny）。
    """
    def _layer(req: PolicyRequest) -> Optional[PolicyDecision]:
        if req.tool_name not in SHELL_TOOLS:
            return None
        text = _command_text(req.args)
        if not text:
            return None
        verdict = classify(text)
        try:
            req.context[_CONTEXT_VERDICT_KEY] = verdict.to_dict()
        except Exception:
            pass  # context 可能不可写——审计丢了但不影响裁决

        if verdict.is_restricted:
            deny = _restricted_action() == "deny"
            return PolicyDecision(
                action=PolicyAction.DENY if deny else PolicyAction.ASK,
                layer=PolicyLayer.COMMAND,
                label="command-guard:restricted",
                reason=("命令命中高危形态（" if deny else "命令命中高危形态，需确认后执行（")
                       + "；".join(verdict.reasons[:3]) + "）",
            )
        if verdict.needs_review:
            return PolicyDecision(
                action=PolicyAction.ASK,
                layer=PolicyLayer.COMMAND,
                label="command-guard:review",
                reason="命令需要确认（" +
                       "；".join(verdict.reasons[:3]) + "）",
            )
        return None
    return _layer


def last_verdict(context: Optional[dict]) -> Optional[dict]:
    """从工具上下文里取回本次分级的 verdict（审计/展示用）。"""
    if not isinstance(context, dict):
        return None
    v = context.get(_CONTEXT_VERDICT_KEY)
    return v if isinstance(v, dict) else None

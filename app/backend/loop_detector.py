"""工具调用循环检测与熔断。

主循环给模型 8 步预算，但从不检查这 8 步有没有在原地打转。一个用同样参数反复
调同一个失败工具的模型会把预算烧光，然后靠 ``step_cap`` 兜底——用户看到的是
"想了很久，什么也没做成"。``goal_scheduler`` 有一套按**整轮**粒度的检测
（``is_stuck``），聊天主循环一直没有对应物，而聊天恰恰是 tool-call 粒度的。

六个检测器，按严重度从高到低短路：

  ``unknown_tool_repeat``    反复调一个不存在的工具。模型幻想出的名字不会因为
                             再试一次就存在，这类循环最没有意义，所以最先拦。
  ``global_circuit_breaker`` 无进展连击到硬上限。最后的保险丝，不解释原因、
                             直接停——到这个程度已经没有"再引导一下"的价值。
  ``known_poll_no_progress`` 只读/轮询类工具的无进展连击。轮询工具**本来就该**
                             被反复调用，所以它们不吃"重复"警告，只吃"重复且
                             结果一模一样"这条。
  ``no_progress``            参数相同**且结果相同**连续 N 次。双哈希是关键：
                             参数相同但结果在变，说明世界在动，不算卡住。
  ``ping_pong``              A→B→A→B 交替。跟 A→A→A 一样卡，但任何"同一动作
                             重复"计数器都看不见它。
  ``generic_repeat``         窗口内参数相同的次数。最弱的信号，只发警告。

两档处置：

  ``warning``   工具照常执行，把提示**拼到工具结果后面**喂回模型。这是给模型
                自纠的机会——它往往只需要被告知"你已经这样试过 3 次了"。
  ``critical``  不执行，直接把说明当作工具结果返回。拦住的是动作，不是回合：
                模型还能在剩下的步数里换个路子或如实报告失败。

阈值可配（``config.json`` 的 ``agent.loop_detection``），并强制
``warning < critical < global_circuit_breaker``——顺序反了会让更严厉的档位
永远抢不到判定，等于静默关掉熔断。
"""
from __future__ import annotations

import enum
import hashlib
import json
import re
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Any, Optional

class LoopPattern(str, enum.Enum):
    IDENTICAL_CALL = "identical_call"
    PING_PONG = "ping_pong"
    CONSECUTIVE_FAILURES = "consecutive_failures"
    UNKNOWN_TOOL = "unknown_tool"
    GLOBAL_BREAKER = "global_breaker"
    NO_PROGRESS = "no_progress"

@dataclass
class LoopTripResult:
    tripped: bool
    pattern: LoopPattern
    message: str
    tool_name: str
    details: dict = field(default_factory=dict)


# ── 签名 ────────────────────────────────────────────────────────────────────

#: 参与哈希的最大字符数。和 ``goal_scheduler._call_signature`` 保持同一个数：
#: 两处对"同一个动作"的判断口径不一致，读日志的人会以为其中一个坏了。
#: 截断的代价是超长参数只在前 400 字符不同时会误判成同一个调用，比让每个调用
#: 都独一无二（等于静默关掉检测）划算。
MAX_SIGNATURE_CHARS: int = 400

#: 易变片段：行号、耗时、地址、时间戳、随机 id。不抹掉的话同一个错误每次的
#: 结果哈希都不同，``no_progress`` 永远数不到 2。
_VOLATILE_RE = re.compile(r"\b(?:0x)?[0-9a-f]{6,}\b|\d+", re.IGNORECASE)


def args_signature(tool: str, args: Any) -> str:
    """``工具名:参数哈希``。键序无关，不可序列化的值退化成 ``str``。"""
    try:
        key = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        key = str(args)
    digest = hashlib.md5(key[:MAX_SIGNATURE_CHARS].encode("utf-8")).hexdigest()
    return f"{tool or '?'}:{digest[:8]}"


def result_signature(text: str) -> str:
    """结果文本的归一化哈希。空文本返回 ""（= 还不知道结果）。

    归一化掉易变片段后再哈希：同一个失败每次的报错通常只差行号和耗时，原样
    哈希会让"结果没变"这件事永远无法被观察到。
    """
    if not text:
        return ""
    norm = _VOLATILE_RE.sub("#", text.lower())
    norm = " ".join(norm.split())[:MAX_SIGNATURE_CHARS]
    return hashlib.md5(norm.encode("utf-8")).hexdigest()[:12]


#: 轮询/只读类工具。这些工具被反复调用是**正常工作方式**（盯一个状态、翻一个
#: 目录），所以它们豁免 ``generic_repeat`` 警告，只在"连结果都一字不差"时才判
#: 卡住。名单取自仓库里真实存在的只读工具名，与 ``router.PARALLEL_SAFE_TOOLS``
#: 同源但独立维护——并行安全和"可以合理重复"是两个不同的性质。
KNOWN_POLL_TOOLS: frozenset = frozenset({
    "read_text", "read_file", "list_dir", "find_files", "search_code", "grep",
    "glob", "git_status", "git_log", "git_diff", "git_show", "system_info",
    "tool_search", "snapshot", "get_text", "web_fetch",
})


# ── 配置 ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class LoopConfig:
    """检测阈值。三档必须严格递增，否则更严厉的档位永远抢不到判定。"""

    #: 窗口内相同 args 签名达到此数 → warning（不看结果，只看动作重复）。
    warning_threshold: int = 3
    #: 相同 args **且** 相同结果连续达到此数 → critical（拦住不执行）。
    critical_threshold: int = 5
    #: 无进展连击到此数 → 全局熔断，不解释直接停。
    global_circuit_breaker: int = 10
    #: ``generic_repeat`` 的滑动窗口大小——"最近多少次里数重复"。
    window: int = 8
    #: ping-pong：最近这么多次里只在 <=2 个签名间交替 → critical。
    ping_pong_window: int = 6
    #: 历史保留上限。有界，否则一个长会话的历史会无限涨。
    history_size: int = 64
    #: 折叠刚发生后，收紧到这个更小的窗口再警戒几步——压缩会重置模型的短期
    #: 记忆，它很容易把折叠前刚试过的死路再走一遍。
    post_compaction_guard: int = 3
    #: 总开关。
    enabled: bool = True

    def validated(self) -> "LoopConfig":
        """夹取到自洽区间。宁可把坏配置修圆，也不要让检测器带病运行或直接崩。

        递增关系是硬约束：``warning < critical < global``。用户可能只调了中间
        一个数就破坏了顺序，这里按"后一档至少比前一档大 1"逐级抬高，而不是报错
        拒绝启动——一个配置手误不该让整个 agent 起不来。
        """
        warn = max(1, int(self.warning_threshold))
        crit = max(warn + 1, int(self.critical_threshold))
        glob = max(crit + 1, int(self.global_circuit_breaker))
        # 0 = 关闭 guard；开启时窗口至少要有 warning_threshold 步，否则收紧后的
        # 阈值在窗口内根本数不到，等于配了一个不会生效的开关。
        guard = int(self.post_compaction_guard)
        guard = 0 if guard <= 0 else max(warn, guard)
        return replace(
            self,
            warning_threshold=warn,
            critical_threshold=crit,
            global_circuit_breaker=glob,
            window=max(crit, int(self.window)),
            ping_pong_window=max(2, int(self.ping_pong_window)),
            history_size=max(glob, int(self.history_size)),
            post_compaction_guard=guard,
        )

    @classmethod
    def from_config(cls, cfg: dict) -> "LoopConfig":
        """从 ``config.json`` 的 ``agent.loop_detection`` 读取，缺失走默认。"""
        block = ((cfg or {}).get("agent") or {}).get("loop_detection") or {}
        base = cls()
        return cls(
            warning_threshold=int(block.get("warning_threshold", base.warning_threshold)),
            critical_threshold=int(block.get("critical_threshold", base.critical_threshold)),
            global_circuit_breaker=int(block.get("global_circuit_breaker", base.global_circuit_breaker)),
            window=int(block.get("window", base.window)),
            ping_pong_window=int(block.get("ping_pong_window", base.ping_pong_window)),
            history_size=int(block.get("history_size", base.history_size)),
            post_compaction_guard=int(block.get("post_compaction_guard", base.post_compaction_guard)),
            enabled=bool(block.get("enabled", base.enabled)),
        ).validated()


@dataclass
class Verdict:
    """一次检测结论。``level`` ∈ {"", "warning", "critical"}；空串= 放行。"""

    level: str = ""
    detector: str = ""
    count: int = 0
    message: str = ""

    @property
    def stuck(self) -> bool:
        return self.level in ("warning", "critical")

    @property
    def blocks(self) -> bool:
        return self.level == "critical"


_OK = Verdict()


@dataclass
class _Call:
    """历史里的一条记录。``result_sig`` 在结果回来后才补写。"""

    tool: str
    args_sig: str
    result_sig: str = ""
    poll: bool = False


class LoopDetector:
    """Per-turn 工具调用历史 + 六检测器。

    生命周期与一个用户回合绑定：``router.handle`` 每轮新建一个，回合内跨 step
    累积。**不跨回合**——上一轮的重复画像对这一轮没有意义，带过来只会误伤。

    用法（两阶段，卡在 dispatch 前后）：

        v = det.check(name, args)          # dispatch 之前
        if v.blocks: ...                   # critical → 不执行，把 message 当结果
        idx = det.record(name, args)       # 记下这次调用，拿回它的槽位
        ...真正 dispatch...
        det.observe(idx, result_text)      # 结果回来后补 result_sig
        # warning 档：把 v.message 追加到工具结果后面喂回模型
    """

    def __init__(
        self,
        config: Optional[LoopConfig] = None,
        *,
        threshold_repeat: Optional[int] = None,
        threshold_oscillation: Optional[int] = None,
        threshold_failure_streak: int = 3,
        window_size: Optional[int] = None,
    ):
        base_cfg = config or LoopConfig()
        if threshold_repeat is not None:
            base_cfg = replace(base_cfg, warning_threshold=threshold_repeat, critical_threshold=threshold_repeat)
        if window_size is not None:
            base_cfg = replace(base_cfg, window=window_size)
        self.config = base_cfg.validated()
        self._history: deque = deque(maxlen=self.config.history_size)
        #: 折叠后收紧窗口的剩余步数。>0 时用更小的窗口更早报警。
        self._guard_steps: int = 0
        self._threshold_repeat = threshold_repeat
        self._threshold_oscillation = threshold_oscillation
        self._threshold_failure_streak = threshold_failure_streak
        self._failure_streak: int = 0
        self._last_error_class: str = ""

    def record_call(self, tool_name: str, args: Any) -> Optional[LoopTripResult]:
        """Convenience single-step check & record method."""
        sig = args_signature(tool_name, args)
        repeat_streak = self._same_args_streak(sig) + 1
        repeat_threshold = self._threshold_repeat or self.config.warning_threshold
        if repeat_streak >= repeat_threshold:
            self.record_blocked(tool_name, args)
            return LoopTripResult(
                tripped=True,
                pattern=LoopPattern.IDENTICAL_CALL,
                message=f"Loop was detected in model tool calls: tool '{tool_name}' invoked {repeat_streak} times with identical parameters. Circuit breaker tripped to halt runaway execution.",
                tool_name=tool_name,
                details={"repeat_count": repeat_streak, "sig": sig},
            )

        pp_streak = self._ping_pong_streak(sig)
        pp_threshold = (self._threshold_oscillation * 2) if self._threshold_oscillation is not None else self.config.ping_pong_window
        if pp_streak >= pp_threshold:
            self.record_blocked(tool_name, args)
            return LoopTripResult(
                tripped=True,
                pattern=LoopPattern.PING_PONG,
                message=f"Loop was detected: oscillating ping-pong pattern across {pp_streak} consecutive steps. Execution halted.",
                tool_name=tool_name,
                details={"streak": pp_streak},
            )

        self.record(tool_name, args)
        return None

    def record_outcome(self, ok: bool, error_class: str = "") -> Optional[LoopTripResult]:
        """Track consecutive execution failures."""
        if ok:
            self._failure_streak = 0
            self._last_error_class = ""
            return None

        clean_err = (error_class or "error").strip()[:100]
        if self._failure_streak > 0 and clean_err == self._last_error_class:
            self._failure_streak += 1
        else:
            self._failure_streak = 1
            self._last_error_class = clean_err

        if self._failure_streak >= self._threshold_failure_streak:
            last_tool = self._history[-1].tool if self._history else "unknown"
            return LoopTripResult(
                tripped=True,
                pattern=LoopPattern.CONSECUTIVE_FAILURES,
                message=f"Failure streak breaker tripped: {self._failure_streak} consecutive failures with error '{clean_err}'. Halted to prevent further token waste.",
                tool_name=last_tool,
                details={"failure_streak": self._failure_streak, "error_class": clean_err},
            )
        return None

    def _same_args_streak(self, sig: str) -> int:
        streak = 0
        for call in reversed(self._history):
            if call.args_sig == sig:
                streak += 1
            else:
                break
        return streak


    # ── 事件 ─────────────────────────────────────────────────────────────
    def note_compaction(self) -> None:
        """折叠发生了——武装 post-compaction guard。"""
        self._guard_steps = self.config.post_compaction_guard

    def record(self, tool: str, args: Any, *, poll: Optional[bool] = None) -> int:
        """把一次即将执行的调用登记进历史，返回它的索引给 ``observe`` 用。"""
        is_poll = (tool in KNOWN_POLL_TOOLS) if poll is None else poll
        self._history.append(_Call(
            tool=tool or "?",
            args_sig=args_signature(tool, args),
            poll=bool(is_poll),
        ))
        if self._guard_steps > 0:
            self._guard_steps -= 1
        return len(self._history) - 1

    def record_blocked(self, tool: str, args: Any) -> None:
        """登记一次**被拦下、没有执行**的调用。

        没有这一条，全局熔断就是死代码：被拦的调用不执行也就没有结果，
        ``no_progress`` 连击永远停在 critical 那一格，再高的档位谁也够不着。
        所以这里把同签名上一次的结果签名**继承**下来——模型在被告知"别再试了"
        之后继续硬撞，连击就应该继续涨，最终撞到那道不再讲道理的保险丝。
        """
        sig = args_signature(tool, args)
        inherited = ""
        for call in reversed(self._history):
            if call.args_sig == sig and call.result_sig:
                inherited = call.result_sig
                break
        self._history.append(_Call(
            tool=tool or "?",
            args_sig=sig,
            result_sig=inherited,
            poll=(tool in KNOWN_POLL_TOOLS),
        ))

    def observe(self, index: int, result_text: str) -> None:
        """结果回来后补写 result_sig。索引越界（被 maxlen 挤掉）就忽略。"""
        # deque 支持索引，但 maxlen 满了之后旧元素会被挤掉、索引失效。record 到
        # observe 之间同一回合内一般只隔一次 dispatch，不会溢出；防御性地兜住。
        if 0 <= index < len(self._history):
            self._history[index].result_sig = result_signature(result_text or "")

    # ── 判定 ─────────────────────────────────────────────────────────────
    def check(self, tool: str, args: Any, *, tool_known: bool = True) -> Verdict:
        """在执行 ``tool(args)`` **之前**判断该不该拦。

        把当前这次调用连同历史一起看——注意此刻它还没进 ``_history``（``record``
        在 ``check`` 之后调用），所以要显式带进来算。

        ``tool_known`` 由调用方给（``self.tools.get(name) is not None``），不在这里
        偷偷去查全局注册表：那种隐式耦合在测试里会因为注册表是空的而把每个工具都
        判成"不存在"，在生产里又完全看不出来。
        """
        if not self.config.enabled:
            return _OK

        sig = args_signature(tool, args)
        poll = tool in KNOWN_POLL_TOOLS
        c = self.config

        # 结果哈希用的是"同签名的历史调用里，最近一次已知的结果"。当前这次还没
        # 结果，无进展连击数 = 历史里紧邻的、同签名同结果的段长 + 1（把当前算上）。
        no_progress = self._no_progress_streak(sig) + 1
        repeat_recent = self._recent_same_args(sig) + 1
        unknown_repeat = self._unknown_tool_streak(tool) + 1

        # 折叠刚过：把"警告线"临时当成"拦截线"。压缩清掉了模型的短期记忆，它极易
        # 把折叠前刚撞过的墙再撞一次，这时候本来只该提醒的重复就值得直接拦。
        #
        # 用 warning_threshold 而不是另造一个数，是因为收紧窗口和收紧后的阈值必须
        # 互相够得着：早先的写法让阈值 = guard+1，而 guard 每步递减，于是窗口总在
        # 阈值变得可达的前一步就用完了——一个永远不会生效的机制。
        crit_threshold = c.critical_threshold
        if self._guard_steps > 0:
            crit_threshold = max(2, min(crit_threshold, c.warning_threshold))

        # 1. unknown_tool_repeat —— 幻想工具，最先拦。
        if not tool_known and unknown_repeat >= max(2, c.warning_threshold):
            return Verdict("critical", "unknown_tool_repeat", unknown_repeat, (
                f"⚠️ 你已经第 {unknown_repeat} 次尝试调用 `{tool}`，但它不是一个可用工具。"
                "不要再重试这个不存在的名字——改用现有工具，或直接基于已有信息作答。"
            ))

        # 2. global_circuit_breaker —— 最后的保险丝。
        if no_progress >= c.global_circuit_breaker:
            return Verdict("critical", "global_circuit_breaker", no_progress, (
                f"⛔ `{tool}` 已经用相同参数、得到相同结果连续 {no_progress} 次，毫无进展。"
                "全局熔断已触发以防止空转：请停止这条路径，换一种完全不同的方法，"
                "或如实向用户说明你卡在了哪里。"
            ))

        # 3. known_poll_no_progress —— 轮询工具专属：只在"连结果都没变"时判。
        if poll and no_progress >= crit_threshold:
            return Verdict("critical", "known_poll_no_progress", no_progress, (
                f"⚠️ `{tool}` 连续 {no_progress} 次返回完全相同的结果。轮询没有等到任何变化，"
                "继续调用只会浪费步数——基于当前结果继续，或换个思路。"
            ))

        # 4. no_progress —— 参数相同且结果相同（非轮询工具）。
        if not poll and no_progress >= crit_threshold:
            return Verdict("critical", "no_progress", no_progress, (
                f"⚠️ `{tool}` 用相同参数、得到相同结果连续 {no_progress} 次。这一步没有推进任务，"
                "重复它不会有不同结果——换参数、换工具，或说明为什么卡住。"
            ))

        # 5. ping_pong —— A→B→A→B 交替。
        pp = self._ping_pong_streak(sig)
        if pp >= c.ping_pong_window:
            return Verdict("critical", "ping_pong", pp, (
                f"⚠️ 最近 {pp} 步只在两个动作之间来回横跳，没有前进。跳出这个循环："
                "退一步重新规划，而不是继续在两个选项间切换。"
            ))

        # 6. generic_repeat —— 最弱信号，只警告。轮询工具豁免（重复是它的常态）。
        if not poll and repeat_recent >= c.warning_threshold:
            return Verdict("warning", "generic_repeat", repeat_recent, (
                f"提示：你已经用相同参数调用 `{tool}` {repeat_recent} 次了。"
                "如果没有取得进展，请停止重试，换个方法或如实报告失败。"
            ))

        return _OK

    # ── 内部：各连击/计数 ────────────────────────────────────────────────
    def _no_progress_streak(self, sig: str) -> int:
        """历史尾部，args 签名 == sig 且结果签名彼此相同的连续段长。

        从最近往回数：锁定同签名的第一条已知结果，继续往回只要结果一致就 +1，
        结果一变立刻断。结果为空（还没 observe）的历史条目跳过——它不构成
        "结果相同"的证据，也不打断连击。
        """
        streak = 0
        latest_result: Optional[str] = None
        for call in reversed(self._history):
            if call.args_sig != sig:
                continue
            if not call.result_sig:
                continue
            if latest_result is None:
                latest_result = call.result_sig
                streak = 1
                continue
            if call.result_sig != latest_result:
                break
            streak += 1
        return streak

    def _recent_same_args(self, sig: str) -> int:
        """最近 ``window`` 条里 args 签名 == sig 的次数。"""
        window = list(self._history)[-self.config.window:]
        return sum(1 for c in window if c.args_sig == sig)

    def _unknown_tool_streak(self, tool: str) -> int:
        """尾部连续调用同一个工具名的长度，遇到别的工具即断。"""
        streak = 0
        for call in reversed(self._history):
            if call.tool == tool:
                streak += 1
            else:
                break
        return streak

    def _ping_pong_streak(self, current_sig: str) -> int:
        """从尾部数起、在 current_sig 与另一个签名之间严格交替的长度。

        找到最近一个与 current_sig 不同的签名作为"另一极"，然后从尾往回要求
        严格 A,B,A,B… 交替，一旦出现第三个签名或顺序不对就断。当前这次调用
        （尚未入历史）算作序列的第 0 个 A。
        """
        hist = list(self._history)
        if not hist:
            return 0
        other: Optional[str] = None
        for call in reversed(hist):
            if call.args_sig != current_sig:
                other = call.args_sig
                break
        if other is None:
            return 0  # 历史里全是 current_sig —— 那是 no_progress 的范畴，不是乒乓

        # 期望序列（从最近的历史条目往回）：other, current, other, current, ...
        # 因为当前这次(未入历史)是 current，紧邻它的历史条目应当是 other。
        count = 1  # 把当前这次算作起点
        expect = other
        for call in reversed(hist):
            if call.args_sig != expect:
                break
            count += 1
            expect = current_sig if expect == other else other
        return count

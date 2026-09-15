"""ask_user.py — 让 Agent 反问用户，并等一个结构化的答案。

为什么单独一个模块，而不是塞进 risk_control
------------------------------------------
提问和权限是两件不同的事。权限回答的是「这一步允许不允许做」，答案空间恒为
approve/deny，由风险等级决定要不要问；提问回答的是「按哪条路走」，答案空间
由模型当场给出，跟风险无关。把两者混进同一张 pending 表，就是重演我们刚拆
掉的「同一件事有两个地方要推理」。

为什么复用 halt，而不是在工具里 await 用户
------------------------------------------
这套架构里一个回合是一次性的：``router._agent_loop`` 收到 ``halt`` 就 return，
本回合不再调模型。若在工具实现里 await 用户，等于把一条 WS 连接的生命周期
绑在线程池任务上——刷新页面、切会话、断线重连都会留下永远挂起的调用，而且
工具有 domain 级超时（general 60s），用户去泡杯咖啡就超时了。所以提问走的是
和权限审批完全同一条链：回合结束 → 记账 → 下一回合带着答案进来。

答案怎么回到模型
----------------
渲染成一条正常的 user 消息（「我选了：…」）。这是和权限确认唯一的实质差别：
权限确认必须让模型原样重发那个被拦住的工具调用，而问题的答案本身就是内容，
模型直接读就行，不需要 replay，也就没有「参数被改掉」的风险。

上限是设计，不是防御
--------------------
一次最多 3 个问题、每题最多 5 个选项。理由是这东西一旦不限量，模型就会用它
代替思考——把本该自己查代码得出的结论摆成十个选项让人选。选项少会迫使模型
先收敛到真正需要人拍板的那几个岔路口。
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from result import Result

#: 一次提问最多几个问题。
MAX_QUESTIONS = 3
#: 每个问题最多几个预设选项（不含前端永远追加的「其他」自由输入）。
MAX_OPTIONS = 5
#: 每个会话最多挂几组未回答的问题，超了淘汰最旧的。
MAX_PENDING = 4
#: 未回答问题的存活期。这也是唯一的「超时」——过期只是读取时丢弃，不自动替
#: 用户作答。故意选长（1 天），因为一组问题在用户下次打开会话时仍然有效。
PENDING_TTL_S = 86400
#: kv 命名空间与键。一个会话所有待答问题存成一条 JSON 数组。
_KV_NS = "ask_user"


def _kv_key(session_id: str) -> str:
    return f"pending:{session_id}"



def _one_option(raw: Any) -> Optional[dict]:
    """把一个选项归一成 ``{label, description}``。

    模型给选项的写法五花八门：纯字符串、``{label}``、``{value,label}``、
    ``{name,detail}``。全部接住，比让工具因为字段名不对而失败要好——模型看到
    的失败信息只会让它换个字段名再试一次，白烧一个回合。
    """
    if isinstance(raw, str):
        label, desc = raw.strip(), ""
    elif isinstance(raw, dict):
        label = str(raw.get("label") or raw.get("value") or raw.get("name") or "").strip()
        desc = str(raw.get("description") or raw.get("detail") or raw.get("hint") or "").strip()
    else:
        return None
    if not label:
        return None
    return {"label": label[:120], "description": desc[:200]}


def normalize_questions(raw: Any) -> tuple[list[dict], str]:
    """校验并归一化模型给的 questions，返回 ``(questions, error)``。

    error 非空时 questions 为空。归一化后的问题带稳定的位置序号，前端点选时
    回传的就是这个序号 —— 不用双方各自生成 id 再对齐，也就没有对不齐的可能。
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return [], "questions 必须是数组，不是字符串"
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        return [], "questions 不能为空"

    out: list[dict] = []
    for i, item in enumerate(raw[:MAX_QUESTIONS]):
        if not isinstance(item, dict):
            return [], f"第 {i + 1} 个问题不是对象"
        text = str(
            item.get("question") or item.get("prompt") or item.get("title") or ""
        ).strip()
        if not text:
            return [], f"第 {i + 1} 个问题缺少 question 文本"
        options = [o for o in (_one_option(o) for o in (item.get("options") or [])) if o]
        if len(options) < 2:
            return [], f"「{text[:20]}」至少要给 2 个选项，只有一个选项就不必问"
        out.append({
            "index": len(out),
            "question": text[:400],
            "options": options[:MAX_OPTIONS],
            "multiSelect": bool(
                item.get("multiSelect")
                or item.get("allowMultiple")
                or item.get("multi_select")
            ),
        })
    return out, ""


@dataclass
class PendingQuestion:
    """一组已经问出去、还没收到答案的问题。"""

    call_id: str
    session_id: str
    header: str
    questions: list[dict]
    created_at: float = field(default_factory=time.time)


def _picked_labels(question: dict, answer: dict) -> tuple[list[str], str]:
    """从一条答案里取出选中的选项文案和自由输入。

    越界的下标直接丢掉而不是报错：前端和后端各持一份问题副本，用户点击和一次
    热重载之间理论上存在错位窗口，丢一个下标比整组答案作废要好。
    """
    labels: list[str] = []
    picked = answer.get("picked")
    if isinstance(picked, int):
        picked = [picked]
    for idx in picked or []:
        try:
            opt = question["options"][int(idx)]
        except (ValueError, TypeError, IndexError):
            continue
        labels.append(opt["label"])
    free = str(answer.get("text") or "").strip()
    return labels, free[:500]


def render_answer(pending: PendingQuestion, answers: Any) -> str:
    """把点选结果渲染成一条正常的用户消息。

    刻意写成人话而不是 JSON：这条文本会作为 user 消息进 transcript，用户回看
    历史时读到的应该是「我选了 pnpm」，不是一坨他没打过的结构体。
    """
    by_index: dict[int, dict] = {}
    if isinstance(answers, dict):
        answers = [answers]
    for a in answers or []:
        if not isinstance(a, dict):
            continue
        raw_idx = a.get("q", a.get("index", a.get("questionIndex")))
        try:
            by_index[int(raw_idx)] = a
        except (ValueError, TypeError):
            continue

    lines: list[str] = []
    for q in pending.questions:
        labels, free = _picked_labels(q, by_index.get(q["index"], {}))
        parts = list(labels)
        if free:
            parts.append(f"其他：{free}")
        lines.append(f"- {q['question']} → " + ("；".join(parts) if parts else "（没选，你定）"))
    return "我选了：\n" + "\n".join(lines)


#: 用户明确跳过时替代答案的那句话。说清「别再问一遍」，否则模型会把跳过读成
#: 「用户没看见」，下一步原样再问一次。
SKIP_REPLY = "这几个问题我先不选。你按最合理的默认继续做，不要再问一遍。"


class AskUserStore:
    """未回答问题的账本，按会话持久化。

    为什么要落库：卡片不是只活在一次连接里。切会话会把前端的 toolCalls 整个清空
    （``session_switched`` 就是这么写的），刷新页面同理，后端重启更彻底。只存在
    内存里的话，用户回来时看到的是一段「我问了你个问题」然后什么都没有 —— 回合
    已经停住，问题却没法答，整轮工作卡死在这。

    落的是 kv 而不是新建表：一组问题是短命的会话态，不是需要索引和迁移的领域
    数据。``PENDING_TTL_S`` 之外的条目在读取时丢掉，这也是我们唯一的「超时」——
    刻意不做定时器式超时，因为超时自动替用户选一个答案，比一直等着更糟。
    """

    def __init__(self, storage=None) -> None:
        self._storage = storage
        self._pending: dict[str, PendingQuestion] = {}
        self._loaded: set[str] = set()

    # ── 持久化 ────────────────────────────────────────────────────────────
    def _store(self):
        """惰性取 storage。构造时就取会让导入顺序决定能否建库。"""
        if self._storage is None:
            from storage import get_storage
            self._storage = get_storage()
        return self._storage

    def _ensure_loaded(self, session_id: str) -> None:
        if not session_id or session_id in self._loaded:
            # No session id means nothing to key the ledger by. Loading under a
            # blank key would let two unrelated callers share one bucket.
            return
        self._loaded.add(session_id)
        try:
            rows = self._store().kv_get(_kv_key(session_id), ns=_KV_NS, default=[]) or []
        except Exception:
            return  # 库锁了就退化成纯内存，比让工具调用炸掉好
        now = time.time()
        for row in rows if isinstance(rows, list) else []:
            try:
                if now - float(row.get("created_at") or 0) > PENDING_TTL_S:
                    continue
                entry = PendingQuestion(
                    call_id=str(row["call_id"]),
                    session_id=session_id,
                    header=str(row.get("header") or ""),
                    questions=list(row.get("questions") or []),
                    created_at=float(row.get("created_at") or now),
                )
            except Exception:
                continue
            if entry.questions:
                self._pending.setdefault(entry.call_id, entry)

    def _persist(self, session_id: str) -> None:
        if not session_id:
            return
        try:
            self._store().kv_set(
                _kv_key(session_id),
                [{"call_id": e.call_id, "header": e.header,
                  "questions": e.questions, "created_at": e.created_at}
                 for e in self.pending_for(session_id)],
                ns=_KV_NS,
            )
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    # ── 账本 ──────────────────────────────────────────────────────────────
    def record(self, call_id: str, session_id: str, header: str,
               questions: list[dict]) -> PendingQuestion:
        self._ensure_loaded(session_id)
        entry = PendingQuestion(call_id=call_id, session_id=session_id,
                                header=header, questions=questions)
        self._pending[call_id] = entry
        for stale in self.pending_for(session_id)[MAX_PENDING:]:
            self._pending.pop(stale.call_id, None)
        self._persist(session_id)
        return entry

    def pending_for(self, session_id: str) -> list[PendingQuestion]:
        """该会话未回答的问题，最新的在前。"""
        self._ensure_loaded(session_id)
        rows = [e for e in self._pending.values() if e.session_id == session_id]
        rows.sort(key=lambda e: e.created_at, reverse=True)
        return rows

    def resolve(self, session_id: str, call_id: str = "",
                answers: Any = None, skipped: bool = False) -> Optional[str]:
        """消费一组问题，返回要写进 transcript 的用户消息；对不上号返回 None。

        ``call_id`` 是正常路径 —— 卡片上的按钮总带着它，所以两张并存的问题卡
        不会互相抢答案。省略时退回该会话最新的一组。
        """
        self._ensure_loaded(session_id)
        entry = self._pending.get(call_id) if call_id else None
        if entry is not None and entry.session_id != session_id:
            return None  # 跨会话的 call_id，不认
        if entry is None:
            rows = self.pending_for(session_id)
            if not rows:
                return None
            entry = rows[0]
        self._pending.pop(entry.call_id, None)
        self._persist(session_id)
        return SKIP_REPLY if skipped else render_answer(entry, answers)

    def discard_session(self, session_id: str) -> int:
        """丢掉该会话所有未答问题，返回丢了几组。

        用户不点卡片、直接打字往下说的时候调这个：那句话就是他的答复方式，
        留着一组永远答不掉的问题只会让卡片上的按钮变成陷阱。
        """
        rows = self.pending_for(session_id)
        for e in rows:
            self._pending.pop(e.call_id, None)
        if rows:
            self._persist(session_id)
        return len(rows)

    def snapshot(self, session_id: str) -> list[dict]:
        """给前端重建卡片用的数据。空列表本身也是有效信息 —— 表示没有待答。"""
        return [
            {"callId": e.call_id, "toolName": "ask_user", "header": e.header,
             "questions": e.questions, "createdAt": e.created_at}
            for e in self.pending_for(session_id)
        ]



_store: Optional[AskUserStore] = None


def get_ask_user_store() -> AskUserStore:
    global _store
    if _store is None:
        _store = AskUserStore()
    return _store


def set_ask_user_store(store: Optional[AskUserStore]) -> None:
    """测试接缝：装一个干净的账本，或传 None 复位。"""
    global _store
    _store = store


# ─────────────────────────────────────────────────────────────────────────────
# 挂起等待（suspend）——把答案送回它原本那个工具调用
#
# 一开始这里走的是「回合结束 → 答案作为新的 user 消息进来」。那条路能用，但它
# 不是业界主流做法：同类产品在任务状态机里有 `waiting`，并让那个工具调用
# 一直开着，答案回去的是**同一个调用的 tool result**，不是一条新用户发言。
#
# 为什么原来做不到、现在能做到：
#   `_build_history` 只回放 user / assistant 两种文本行（router.py），tool_call 和
#   tool_result 从来不跨回合持久化。所以「回合结束之后再把结果补回那个调用」在
#   这套架构里没有落脚点 —— 但「回合根本不结束」有。把等待放在回合内，那个
#   tool_use 还在本轮的 messages 里，答案填进去就是天然的 tool result。
#
# 等待必须放在 router（async）而不是工具实现里：工具是跑在线程池的同步函数，
# 而且有 domain 级超时（general 60s），用户去泡杯咖啡就超时了。
#
# 进程内 Future 不是持久化的替代品，是它的快车道：连接断了、进程重启了，等待者
# 就没了，这时回落到原来那条「回合结束 + 持久账本 + 下一回合带答案」的路。
# 两条路都留着，才既有大厂的语义又不会把对话卡死。
# ─────────────────────────────────────────────────────────────────────────────

#: 挂起等待的兜底上限。取 30 分钟：它不是「用户该多快回答」的期望值，而是防止
#: 一个再也不会有人点的卡片把回合永久挂住。真正的答案没有时限——超时之后卡片和
#: 持久账本都还在，只是退回「下一回合带答案」那条路。
ASK_WAIT_TIMEOUT_S = 1800

_waiters: dict[str, "asyncio.Future"] = {}


def register_waiter(call_id: str) -> "asyncio.Future":
    """为一次提问登记等待者，返回等答案的 Future。"""
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    _waiters[call_id] = fut
    return fut


def drop_waiter(call_id: str) -> None:
    _waiters.pop(call_id, None)


def has_waiter(call_id: str) -> bool:
    fut = _waiters.get(call_id)
    return fut is not None and not fut.done()


def deliver_answer(call_id: str, answers: Any = None, skipped: bool = False) -> bool:
    """把点选结果交给正在等它的那个回合。没人等就返回 False（调用方回落）。"""
    fut = _waiters.pop(call_id, None)
    if fut is None or fut.done():
        return False
    fut.set_result({"answers": answers, "skipped": bool(skipped)})
    return True



ASK_USER_SCHEMA = {
    "type": "object",
    "properties": {
        "header": {
            "type": "string",
            "description": "Very short title for the whole ask, e.g. 'Pick a package manager'.",
        },
        "questions": {
            "type": "array",
            "description": f"1-{MAX_QUESTIONS} questions. Each needs at least 2 options.",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "The question itself."},
                    "options": {
                        "type": "array",
                        "description": f"2-{MAX_OPTIONS} concrete choices.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "Short choice text."},
                                "description": {
                                    "type": "string",
                                    "description": "One line on the trade-off. Optional.",
                                },
                            },
                            "required": ["label"],
                        },
                    },
                    "multiSelect": {
                        "type": "boolean",
                        "default": False,
                        "description": "True when several options can be picked together.",
                    },
                },
                "required": ["question", "options"],
            },
        },
    },
    "required": ["questions"],
}

ASK_USER_DESCRIPTION = (
    "Ask the user to choose between concrete options when you are at a fork you "
    "cannot resolve yourself, and picking wrong would waste real work. The turn "
    "stops here and the user answers by clicking; a free-text 'other' box is always "
    "offered, so never spend an option on it. Do NOT use this to ask permission for "
    "a risky action (that gate is automatic), to ask something the codebase can "
    "answer, or to re-ask what the user already told you."
)


def _render_for_transcript(header: str, questions: list[dict]) -> str:
    """问题的纯文本形态。

    两个用途，都必须有：一是 halt 的返回值会成为本回合可见的助手回复，二是
    没有卡片 UI 的入口（CLI、机器人会话）只能看到这段文本。
    """
    lines = [header or "需要你定一下："]
    for i, q in enumerate(questions, 1):
        lines.append(f"{i}. {q['question']}")
        lines.append("   " + " / ".join(o["label"] for o in q["options"]))
    return "\n".join(lines)


def _ask_user_impl(args: dict, ctx: dict) -> Result:
    questions, err = normalize_questions(args.get("questions"))
    if err:
        # 失败也是一次可用的反馈：说清哪里不对，模型下一步就能改对，而不是
        # 换个字段名再试一遍。
        return Result.failure(f"ask_user 参数不合法：{err}")

    call_id = str(ctx.get("call_id") or "")
    session_id = str(ctx.get("session_id") or "")
    if not call_id:
        return Result.failure("ask_user 缺少 call_id，无法把答案对回这次提问")

    header = str(args.get("header") or "").strip()[:80]
    get_ask_user_store().record(call_id, session_id, header, questions)
    return Result.success(
        _render_for_transcript(header, questions),
        ask_header=header,
        ask_questions=questions,
    )


def create_ask_user_tool():
    """建 ``ask_user`` 的 ToolDef。

    在这里 import ToolDef 而不是模块顶层：tools.py 要 import 本模块来注册这个
    工具，顶层互相 import 就成环了。
    """
    from tools import ToolDef

    return ToolDef(
        "ask_user",
        ASK_USER_DESCRIPTION,
        ASK_USER_SCHEMA,
        _ask_user_impl,
        domain="general",
        risk_level="low",
        halts_turn=True,
    )


#: 注进 OUTPUT_RULES 层的行为约束。
#:
#: 仅从公开协议很难还原「什么时候
#: 该问」挖不到 —— 那是系统提示词，不在打包产物里。但它恰恰是决定这个工具是
#: 提升还是拖累的那一半：不加约束，模型会把 ask_user 当成拖延手段，把本该自己
#: 读代码得出的结论摆成选项让人选，每次提问都白烧一个回合还打断人。所以这段
#: 写成「先自己找答案，找不到再问」，并且明确划走权限确认那条线。
ASK_USER_PROMPT_BLOCK = """## 反问用户（ask_user）

只在这三种情况用 `ask_user`：
- 存在多条都合理的路，选错要推翻已经做完的工作（技术选型、改动范围、要不要动别人的模块）。
- 用户的要求有歧义，而歧义会导致完全不同的结果。
- 需要只有用户才知道的信息（业务规则、外部约定、他的偏好）。

不要用它：
- 危险操作的许可 —— 那条门禁是自动的，不需要你问。
- 代码里能查到的答案 —— 先自己查。翻两个文件就能确定的事，问了是浪费。
- 用户已经说过的事 —— 重复问是在告诉他你没在听。
- 「要不要我继续」这类假问题 —— 直接做。

用的时候：每个选项要是一条具体的路，附一句代价或后果；不要造「其他」选项，
输入框永远都在。问完这一轮就停住等答案，别自己替用户选一个然后接着做。"""


def prompt_block(is_available: bool = True) -> str:
    """要注入的提问行为约束；工具不可用时返回空串。"""
    return ASK_USER_PROMPT_BLOCK if is_available else ""


# ─────────────────────────────────────────────────────────────────────────────
# 自动消解（auto-resolution）
#
# 提示词只能劝，机制才能拦。「先自己查再问」写进提示词后，模型照样会在答案其实
# 已经摆在上下文里的时候把问题抛出来 —— 每一次都白烧一个回合，还打断人。
#
# 所以在真正落卡片之前插一道独立判定：拿着到目前为止的对话，逐题回答「这题的
# 答案是不是已经被用户说过 / 已经被项目现状确定了」。全部有据可依才自动作答，
# 否则照常问人。
#
# 三条纪律，缺一条这机制就从提升变成风险：
#   · 全有或全无。半自动会产出一张「有些题已经替你定了」的卡片，比全问更费解。
#   · 必须给证据。每题都要引用对话里的原话或具体的项目事实；说不出来就算没答。
#   · 必须留痕。自动作答要显示在卡片上，用户能看见它替自己定了什么 ——
#     悄悄替人决定，是这机制唯一真正的危险。
# ─────────────────────────────────────────────────────────────────────────────

AUTO_RESOLVE_SYSTEM = """你在判定一件事：AI 助手打算向用户提的问题，是否其实已经有答案了。

对每个问题，只有满足以下之一才算「已确定」：
- 用户在对话里已经明说过（哪怕用词不同）；
- 项目现状或对话中已陈述的事实唯一地决定了它（例如已经在用某个工具链）。

以下情况一律算「未确定」，不要替用户猜：
- 纯偏好、审美、优先级取舍；
- 你只是觉得某个选项更常见 / 更合理；
- 需要用户才知道的业务约定、外部约定；
- 证据要靠推测才能连上。

严格只输出 JSON，不要代码块、不要解释：
{"resolved": true/false,
 "answers": [{"q": <问题序号>, "picked": [<选项下标>], "evidence": "<对话里的依据，一句话>"}]}

resolved 为 true 时，answers 必须覆盖每一个问题，且每题都要有非空 evidence。
只要有一题拿不准，直接输出 {"resolved": false, "answers": []}。"""


def build_auto_resolve_user_prompt(header: str, questions: list[dict]) -> str:
    """把待判定的问题渲染成判定请求。"""
    lines = ["助手打算问的问题：" + (f"（{header}）" if header else "")]
    for q in questions:
        lines.append(f"[{q['index']}] {q['question']}")
        for i, opt in enumerate(q["options"]):
            desc = f" —— {opt['description']}" if opt.get("description") else ""
            lines.append(f"    {i}. {opt['label']}{desc}")
    lines.append("")
    lines.append("逐题判断是否已确定，按要求输出 JSON。")
    return "\n".join(lines)


def _strip_json_fence(text: str) -> str:
    """判定模型偶尔会套一层 ```json，剥掉再解析。"""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    start, end = t.find("{"), t.rfind("}")
    return t[start:end + 1] if start >= 0 and end > start else t


def parse_auto_resolution(text: str, questions: list[dict]) -> Optional[dict]:
    """解析判定结果；不满足全部纪律就返回 None（= 照常问人）。

    刻意写得难通过：这段代码的默认结局应该是「问用户」，自动作答是例外。
    """
    try:
        data = json.loads(_strip_json_fence(text))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("resolved") is not True:
        return None
    rows = data.get("answers")
    if not isinstance(rows, list) or len(rows) != len(questions):
        return None

    by_index: dict[int, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            return None
        try:
            qi = int(row.get("q"))
        except (TypeError, ValueError):
            return None
        picked = row.get("picked")
        if isinstance(picked, int):
            picked = [picked]
        if not isinstance(picked, list) or not picked:
            return None
        if not str(row.get("evidence") or "").strip():
            return None  # 没有依据就不算已确定
        by_index[qi] = {"q": qi, "picked": picked,
                        "evidence": str(row["evidence"]).strip()[:200]}

    answers, reasons = [], []
    for q in questions:
        row = by_index.get(q["index"])
        if row is None:
            return None
        valid = [int(i) for i in row["picked"]
                 if isinstance(i, int) and 0 <= int(i) < len(q["options"])]
        if not valid:
            return None
        if len(valid) > 1 and not q.get("multiSelect"):
            valid = valid[:1]
        answers.append({"q": q["index"], "picked": valid})
        label = "、".join(q["options"][i]["label"] for i in valid)
        reasons.append(f"{q['question']} → {label}（依据：{row['evidence']}）")
    return {"answers": answers, "reason": "\n".join(reasons)}

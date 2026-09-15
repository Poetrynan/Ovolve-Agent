"""tool_catalog.py - 可见性视图：注册全量，暴露子集（六·UC1）。

`ToolRegistry` 是**注册**的权威，这个模块是**暴露**的策略。两者分开是因为
它们回答的是不同的问题：

  - 注册表回答「这个名字能不能派发」——`dispatch` / `_run_tool_call` 的权限
    校验只认它，永远不看视图。
  - 视图回答「这一轮要把哪些 schema 塞进上下文」——纯粹是 token 与选项数量
    的取舍，猜错了最多是模型少看见一个工具，绝不会让它多做一件事。

这个方向性必须守住。`router.py:_tool_specs_for` 上方那段注释已经把原则写清楚
了：**隐藏是提示，拦截才是保证**。本模块只生产 `exclude` 名单，不碰任何一处
校验；`trim_exclude` 的返回值再离谱，也只能让模型看得更少。

## 为什么要裁剪

工具数量随 MCP 服务器线性膨胀，而每一轮都要把全部 schema 原样塞进请求。
60 个工具已经是每轮几万 token 的固定开销，接三个 MCP 服务器就能翻倍；而且
选项越多模型选错的概率越高——「工具太多」既贵又笨。

## 三段视图

1. **常驻核心**（`CORE_TOOL_NAMES`）——读文件、搜索、写文件、shell、委派
   这类几乎每轮都要用的，写死白名单。写死而不是靠打分，是因为核心集一旦
   被打分误伤，模型连「读文件」都得先搜一次工具，那是灾难性的退化。
2. **本轮相关**——用已有 `recommender` 的关键词重合度打分选前 N。
3. **`tool_search` 元工具**——模型发现没有合适工具时用自然语言查全量注册表，
   命中的名字由 router 收进本轮视图，后续步骤就能直接调用。

MCP 工具默认整组折叠（不进核心集），只能靠第 2、3 段浮出来。

## 软上限

工具总数不到 `TRIM_MIN_TOTAL` 时**完全不裁剪**，也不注册 `tool_search`——
没有 MCP 的默认安装下，全量目录本来就装得下，裁剪只会白白让模型少几个选项。
裁剪是为膨胀准备的，不是无条件的。
"""
from __future__ import annotations

from typing import Any, Iterable, Optional

from result import Result

#: 常驻核心：几乎每轮都可能用到，永不裁剪。
#: 刻意保持小而全 —— 一个「读 / 搜 / 写 / 跑 / 问 / 派」的最小闭环。缺了其中
#: 任何一类，模型都得先 tool_search 一次才能干最普通的活。
#:
#: 名字必须和注册表里**逐字**一致。写错了不会报错，只会让那个工具悄悄掉出核心
#: 集、退化成「要搜才看得见」—— 和 `subagent_registry._READ_TOOLS` 当年那次
#: （写了 read_file/glob/grep，全都不存在，只读人格被削成两个工具）是同一个坑。
CORE_TOOL_NAMES = frozenset({
    # 读
    "read_text", "search_code", "find_files", "list_dir", "get_file_info",
    # 读外部。和上面一组是同一个理由：中文请求（"查一下这个库的文档"）在英文
    # 描述上打不出分，而「上网查」跟「读本地文件」一样是日常动作，不该每次都
    # 先搜一次工具。同组里更专的那些（学术检索、可信度校验）留给检索浮出。
    "web_search", "web_fetch",
    # 写
    "write_file", "edit_file",
    # 跑
    "shell_executor",
    # Matrix (Computer Use 桌面操作原子原语)
    "computer_screenshot", "computer_click", "computer_move_cursor",
    "computer_type", "computer_press_key", "computer_scroll", "computer_drag",
    "app_launch", "window_focus",
    # Voyager (Browser 浏览器操作原子原语)
    "navigate", "snapshot", "click", "fill", "evaluate",
    # git 的日常闭环。看改动 + 暂存 + 提交 + 看历史几乎是每个编码回合的收尾，
    # 而「相关性」那一段靠英文词重合打分，对中文请求（"帮我提交一下"）基本失效
    # —— 分词切不出 commit，`git_commit` 就浮不上来。所以这几个必须写死在核心
    # 集里，否则最常见的操作反而要先搜一次工具。刻意不含 `git_push`：它是高危
    # 且不那么频繁，多一次 tool_search 换一次「不会顺手推上去」是划算的。
    "git_status", "git_diff", "git_add", "git_commit", "git_log",
    # 问 / 派 / 记
    "ask_user", "task", "plan_write", "memory_add", "memory_search",
    # 发现自己没有的能力
    "tool_search", "recommend",
})

#: 元工具自身的名字。单独拎出来是因为它的可见性规则和别人相反：
#: 只有在**确实发生了裁剪**时才该出现。
SEARCH_TOOL_NAME = "tool_search"

#: 总数不到这个值就不裁剪。约等于「无 MCP 的默认安装」的规模 —— 那种情况下
#: 全量目录塞得下，裁剪纯属自损。
TRIM_MIN_TOTAL = 45

#: 「本轮相关」最多放几个。上限存在的意义是让目录规模可预测：核心集是常量，
#: 相关集有上限，所以视图大小与注册表规模脱钩，接多少 MCP 都不会失控。
RELEVANT_LIMIT = 8

#: 关键词重合度的入选门槛。刻意压得很低：这里不是「给模型的建议」而只是
#: 「目录成员资格」，多一个不相关的选项代价很小，少一个必需的工具代价很大。
RELEVANT_MIN_SCORE = 0.08

#: `tool_search` 单次最多返回几条。
SEARCH_RESULT_LIMIT = 10


def group_of(tool: Any) -> str:
    """这个工具属于哪一组。

    显式 ``group`` 优先，否则回落到 ``domain``。MCP 工具在注册时会带上
    ``mcp:<服务器名>``，所以同一个服务器的工具天然成组、能被整组折叠或整组
    浮出——按 domain 分的话所有 MCP 工具会糊成一个 "mcp" 大组，用户装了三个
    服务器也分不开。
    """
    explicit = str(getattr(tool, "group", "") or "").strip()
    if explicit:
        return explicit
    return str(getattr(tool, "domain", "") or "general").strip()


def _relevant_names(query: str, scope: str, all_names: set[str]) -> set[str]:
    """用 recommender 打分选出本轮相关的工具名。

    打分失败必须是零代价的：排序是个弱信号，为它牺牲一整轮不值得，所以任何
    异常都退化成「只剩核心集」而不是抛出去。
    """
    q = (query or "").strip()
    if len(q) < 4:  # "ok" / "继续" 这种长度，词重合没有意义
        return set()
    try:
        from recommender import get_recommender
        ranked = get_recommender().recommend(
            q, limit=RELEVANT_LIMIT, kinds=("tool",), scope=scope,
        ).get("results", [])
    except Exception:
        return set()
    out = set()
    for row in ranked:
        if not isinstance(row, dict):
            continue
        name = row.get("name")
        if not isinstance(name, str) or name not in all_names:
            continue
        if float(row.get("score") or 0) >= RELEVANT_MIN_SCORE:
            out.add(name)
    return out


def visible_names(registry: Any, *, query: str = "",
                  revealed: Optional[Iterable[str]] = None,
                  scope: str = "") -> set[str]:
    """本轮该让模型看见哪些工具名。

    Args:
        registry: 全量 `ToolRegistry`。
        query: 用户本轮的请求，用来打「相关性」分。
        revealed: 本轮 `tool_search` 已经命中过、应当继续可见的名字。
        scope: 工作区路径，透传给 recommender 做缓存隔离。

    Returns:
        名字集合。总数不到软上限时返回**全量**——调用方据此得到一个空的
        `exclude`，也就是完全维持裁剪前的行为。
    """
    all_names = {t.name for t in registry.list_tools()}
    if len(all_names) <= TRIM_MIN_TOTAL:
        return all_names
    visible = {n for n in CORE_TOOL_NAMES if n in all_names}
    visible |= {n for n in (revealed or ()) if n in all_names}
    visible |= _relevant_names(query, scope, all_names)
    return visible


def trim_exclude(registry: Any, *, query: str = "",
                 revealed: Optional[Iterable[str]] = None,
                 scope: str = "") -> set[str]:
    """把视图翻译成 `to_openai_tools(exclude=...)` 认得的排除名单。

    返回排除集而不是可见集，是为了和 `_tool_specs_for` 里已有的三个来源
    （远程 denylist、子代理 allowlist 取反、task/ask_user 特例）用同一种
    语言——它们都往一个 `exclude` 里并集，谁都不需要知道别人的存在。
    """
    all_names = {t.name for t in registry.list_tools()}
    visible = visible_names(registry, query=query, revealed=revealed, scope=scope)
    if visible >= all_names:
        # 没有发生裁剪：元工具此时是纯噪音——目录已经是全的，没有「剩下的」
        # 可搜。让它只在真正需要时出现。
        return {SEARCH_TOOL_NAME} if SEARCH_TOOL_NAME in all_names else set()
    return all_names - visible


def is_trimmed(registry: Any) -> bool:
    """当前注册表规模是否已经到了要裁剪的程度。"""
    return len(registry.list_tools()) > TRIM_MIN_TOTAL


# ── tool_search 元工具 ────────────────────────────────────────────────────────

SEARCH_TOOL_DESCRIPTION = (
    "Search the FULL tool registry by keyword. Your visible tool list is "
    "intentionally trimmed to the tools most likely relevant this turn — more "
    "tools exist than you can see. Call this when you need a capability that "
    "isn't in your list (browser control, app/UI automation, web search, "
    "process management, less-common git operations, or any MCP server tool). "
    "Matching tools become directly callable for the rest of this turn. "
    "Omit `query` to list the available tool groups first."
)


def _search_impl(args: dict, ctx: dict) -> Result:
    """查全量注册表。

    ``revealed_tools`` 放在 meta 里而不是正文里：router 用它扩大本轮视图，
    但模型读的是正文。两者分开，模型就无法靠伪造正文骗出一个不存在的工具名
    ——router 那侧还会拿注册表再核一遍。
    """
    from tools import get_tool_registry
    registry = get_tool_registry()
    query = str(args.get("query") or "").strip()
    limit = int(args.get("limit") or SEARCH_RESULT_LIMIT)
    return Result.success(**_search_payload(registry, query, limit))


def _search_payload(registry: Any, query: str, limit: int) -> dict:
    """`Result.success(value=..., **meta)` 的两半，拆开好测。"""
    tools = registry.list_tools()
    if not query:
        return {"value": _group_overview(tools), "revealed_tools": []}

    from recommender import _tokens  # 同一套分词，避免两处口径不一致
    qtokens = _tokens(query)
    scored = []
    for t in tools:
        if t.name == SEARCH_TOOL_NAME:
            continue  # 搜「搜索工具」没有意义，且会挤掉一个真结果
        hay = _tokens(" ".join([
            t.name,
            t.description or "",
            group_of(t),
            getattr(t, "when_to_use", "") or "",
            getattr(t, "domain", "") or "",
        ]))
        hits = sum(1 for tk in qtokens if tk in hay)
        # 名字子串命中单独加权：模型往往已经隐约记得工具叫什么（"screenshot"、
        # "browser"），这种命中比描述里蹭到一个词可信得多。
        if query.lower() in t.name.lower():
            hits += 2
        if hits:
            scored.append((hits, t))
    scored.sort(key=lambda pair: (-pair[0], pair[1].name))
    picked = [t for _, t in scored[: max(1, limit)]]
    if not picked:
        return {
            "value": {
                "query": query, "matches": [],
                "note": "没有工具匹配这个关键词。可以不带 query 再调一次看有哪些组，"
                        "或者换个说法（工具名和描述都是英文的）。",
                "groups": _group_overview(tools)["groups"],
            },
            "revealed_tools": [],
        }
    return {
        "value": {
            "query": query,
            "matches": [{
                "name": t.name,
                "group": group_of(t),
                "risk": getattr(t, "risk_level", "low"),
                "description": t.description or "",
            } for t in picked],
            "note": "这些工具现在已经可以直接调用了（本回合内有效）。",
        },
        "revealed_tools": [t.name for t in picked],
    }


def _group_overview(tools: list) -> dict:
    """不带 query 时的回答：有哪些组、各组多大、举几个例子。

    给的是「地图」而不是「全量清单」——把 60 个工具的名字全列出来，等于绕过
    裁剪把 token 又花回去了。
    """
    groups: dict[str, list[str]] = {}
    for t in tools:
        if t.name == SEARCH_TOOL_NAME:
            continue
        groups.setdefault(group_of(t), []).append(t.name)
    return {
        "groups": [{
            "group": g,
            "count": len(names),
            "examples": sorted(names)[:5],
        } for g, names in sorted(groups.items())],
        "note": "带上 query 再调一次就能拿到某一类的具体工具并直接使用。",
    }


def register_tools(registry: Any = None) -> None:
    """注册 `tool_search`。

    无条件注册、由视图决定它是否可见：注册是廉价且幂等的，而可见性要按每轮
    的注册表规模决定（用户随时可能连上一个 MCP 服务器把总数顶过软上限）。
    把这个判断留在 `trim_exclude` 里，就不需要在启动时猜未来。
    """
    from tools import ToolDef, get_tool_registry
    registry = registry or get_tool_registry()
    registry.register(ToolDef(
        SEARCH_TOOL_NAME,
        SEARCH_TOOL_DESCRIPTION,
        {"type": "object", "properties": {
            "query": {"type": "string",
                      "description": "What capability you're looking for, in English "
                                     "keywords (e.g. 'screenshot', 'browser click', "
                                     "'kill process'). Omit to list tool groups."},
            "limit": {"type": "integer", "default": SEARCH_RESULT_LIMIT},
        }, "required": []},
        _search_impl, domain="general", risk_level="low",
    ))

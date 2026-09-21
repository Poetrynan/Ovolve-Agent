"""moa.py — 多模型会诊（Mixture-of-Agents）按需协作

## 解决什么

单一模型再强也有盲区：架构决策、复杂 bug 根因分析这类"错一次代价很大"
的题，第二个视角经常直接点破被第一个模型忽略的关键。MoA 的做法是先让
少数几个**不同**模型各自独立作答（advisors），把他们的意见作为"同行会
诊"材料并入主模型的上下文，由主模型写终稿——主模型保持对工具调用和
回答的全部控制权，advisors 只出主意、不干活。

## 为什么是"按需"而不是常开

会诊的费用是 (N+1) 倍、延迟是慢 advisor 的耗时。日常"改个按钮颜色"
用它纯属烧钱。所以触发权完全交给用户：消息以 ``/moa`` 开头时本轮启用，
结束即自动关闭；不配置第二个模型时静默降级为单模型——
**没有 advisor 就单干，绝不因为会诊缺席而让一轮对话失败。**

## 适配 Ovolve 的三个接入纪律

1. **advisor 池来自 model_registry.scene_candidates**：只从用户已配置、
   已带凭证、清过场景能力门槛的模型里挑——不新建模型管理，凭证缺失的
   provider 在那里就已经被过滤掉了。
2. **advisor 客户端用 LLMClient.bind**：与降级重试（UD2）同一套绑定机
   制，provider/kind/effort 的翻译逻辑零复制。
3. **一切 fail-open**：会诊是锦上添花。advisor 全挂、超时、返回空——
   都只记日志并退回单模型，主流程永远不被旁路拖死。
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("moa")

#: 最多请几位会诊医生。3 个 advisor = 4 倍费用起步，收益曲线已经压平。
MAX_ADVISORS = 2

#: 单位 advisor 的回答上限。会诊意见要的是判断与提醒，不是论文——
#: advisor 的输出会被整段塞进主模型上下文，长意见就是长账单。
ADVISOR_MAX_TOKENS = 700

#: 全体会诊的墙钟预算。超时未回的 advisor 直接除名（asyncio.wait 超时）。
COUNCIL_TIMEOUT_S = 45.0

#: 触发前缀。剥掉前缀后的剩余文本才是真正的用户请求。
MOA_PREFIX = "/moa"


def strip_moa_prefix(user_message: str) -> tuple[bool, str]:
    """识别并剥掉 ``/moa`` 触发前缀，返回 ``(启用?, 剩余请求)``。"""
    text = (user_message or "").strip()
    if text.lower().startswith(MOA_PREFIX):
        return True, text[len(MOA_PREFIX):].strip()
    return False, user_message or ""


@dataclass
class AdvisorOpinion:
    """一位 advisor 的会诊意见（或失败记录）。"""

    model_id: str
    provider_id: str
    ok: bool
    text: str = ""
    elapsed_s: float = 0.0
    error: str = ""


@dataclass
class CouncilResult:
    """一场会诊的完整回执：意见列表 + 注入用文本块。"""

    opinions: list = field(default_factory=list)
    council_block: str = ""          # 空串 = 本轮没有可用意见，按单模型走
    advisors_asked: int = 0
    elapsed_s: float = 0.0


def select_advisors(scene_candidates: list, current_model: str,
                    limit: int = MAX_ADVISORS) -> list[dict]:
    """从 scene 候选里挑会诊医生。

    筛选规则，按优先级：
    1. 排除当前主模型——自己给自己会诊没有信息增量；
    2. **不同 provider 优先**：同一个 provider 下的两个模型往往是同一家
       训练的血统，观点相关性高；跨 provider 的分歧才是会诊的价值来源。
    3. 候选顺序已是 cheapest-first（scene_candidates 的契约），同 provider
       内取最便宜的——advisor 的回答不需要旗舰级质量，够格提不同看法即可。
    """
    picked: list[dict] = []
    seen_providers: set[str] = set()
    current = current_model or ""
    current_pid = ""
    for cand in scene_candidates or []:
        pid = str(cand.get("providerId") or cand.get("provider_id") or "")
        mid = str(cand.get("modelId") or cand.get("model_id") or "")
        if not current_pid and mid == current:
            # 主模型所属 provider 记入去重：同 provider 的其他模型血统相同
            # （同厂训练、观点相关性高），会诊价值低，整个 provider 不占席。
            current_pid = pid
            continue
        if not mid or mid == current:
            continue
        if pid in seen_providers or (pid and pid == current_pid):
            continue  # 每 provider 一席，血统去重
        picked.append(cand)
        seen_providers.add(pid)
        if len(picked) >= limit:
            break
    return picked


def build_council_block(opinions: list[AdvisorOpinion]) -> str:
    """把成功意见拼成注入主模型上下文的「同行会诊」块。

    框架性指令放在块头：意见是参考视角不是标准答案，主模型有权基于自己
    的工具调用结果反驳——否则主模型容易被 advisor 的自信带偏。
    """
    good = [o for o in opinions if o.ok and o.text.strip()]
    if not good:
        return ""
    lines = [
        "【同行会诊意见（供参考，非标准答案）】",
        "以下是其他模型的独立观点。请批判性采纳：与你的工具观察和推理冲突时，以你的判断为准；采纳时不需要声明。",
        "",
    ]
    for o in good:
        lines.append(f"▍视角·{o.model_id}")
        lines.append(o.text.strip())
        lines.append("")
    return "\n".join(lines).strip()


async def _ask_one_advisor(base_llm, cand: dict, question: str,
                           recent_tail: str) -> AdvisorOpinion:
    """向一位 advisor 提问。失败返回 ok=False 的意见，绝不抛出。"""
    pid = str(cand.get("providerId") or cand.get("provider_id") or "")
    mid = str(cand.get("modelId") or cand.get("model_id") or "")
    t0 = time.monotonic()
    try:
        client = base_llm.bind(cand)
        prompt = (
            "你是另一位 AI 助手，受邀为下面这个任务提供独立 second opinion。"
            "请给出：① 你会怎么做（步骤级）；② 主流做法容易踩的坑；"
            "③ 如果信息不足，最有价值的追问是什么。直接说结论，不要客套。\n\n"
            f"【任务】\n{question}\n"
        )
        if recent_tail:
            prompt += f"\n【最近对话摘要（供上下文）】\n{recent_tail}\n"
        res = await asyncio.wait_for(
            client.chat(
                [{"role": "user", "content": prompt}],
                max_tokens=ADVISOR_MAX_TOKENS,
                temperature=0.4,
                reasoning_effort="low",
            ),
            timeout=COUNCIL_TIMEOUT_S,
        )
        elapsed = time.monotonic() - t0
        if not res.ok:
            return AdvisorOpinion(mid, pid, ok=False, elapsed_s=elapsed,
                                  error=str(res.error)[:160])
        text = str((res.value or {}).get("content") or "").strip()
        return AdvisorOpinion(mid, pid, ok=bool(text), text=text[:2400],
                              elapsed_s=elapsed)
    except asyncio.TimeoutError:
        return AdvisorOpinion(mid, pid, ok=False,
                              elapsed_s=time.monotonic() - t0,
                              error=f"timeout after {COUNCIL_TIMEOUT_S}s")
    except Exception as exc:  # noqa: BLE001 — 会诊绝不拖垮主流程
        return AdvisorOpinion(mid, pid, ok=False,
                              elapsed_s=time.monotonic() - t0,
                              error=str(exc)[:160])


async def convene(base_llm, advisors: list[dict], question: str,
                  recent_tail: str = "") -> CouncilResult:
    """并行召集所有 advisor，返回会诊回执。永不抛出、永不阻塞主流程。"""
    result = CouncilResult(advisors_asked=len(advisors))
    if not advisors:
        return result
    t0 = time.monotonic()
    opinions = await asyncio.gather(
        *[_ask_one_advisor(base_llm, cand, question, recent_tail)
          for cand in advisors]
    )
    result.opinions = list(opinions)
    result.council_block = build_council_block(result.opinions)
    result.elapsed_s = time.monotonic() - t0
    ok_n = sum(1 for o in result.opinions if o.ok)
    logger.info(
        "[moa] council done: %d/%d advisor(s) replied in %.1fs, block=%d chars",
        ok_n, len(advisors), result.elapsed_s, len(result.council_block),
    )
    return result

"""stream_scrubber.py — 跨 delta 边界的内嵌思考块过滤状态机

## 要解决什么

推理模型的思考内容有两种走线：

1. 独立字段（``delta.reasoning_content``）——llm_client 已经单独分流成
   reasoning 事件，没有问题；
2. **内嵌在正文里**（``<think>…</think>`` 直接混在 content 中流出）——
   Qwen / MiniMax / 部分开源模型的 OpenAI-compatible 网关就是这么干的。
   不过滤的话，``<think>`` 原文会原样出现在聊天气泡里，用户看到的是
   半截标签和推理草稿混在一起。

对完整字符串做正则删除是容易的；难点在**流式**：``<think>`` 可能被切
在两个 delta 的边界上（上一个 delta 以 ``<th`` 结尾、下一个以 ``ink>``
开头）。按 delta 逐段做正则会把边界残片当普通文本漏过去——开标签从未
以完整形态出现在任何单个 delta 里，后续所有内容就都被当正文泄漏了。

## 状态机

- **NORMAL**：正常输出。攒下可能是 ``<think>`` 真前缀的末尾残片
  （最长后缀匹配），其余放行；见到完整 ``<think>`` 切 IN_THINK。
- **IN_THINK**：吞内容。见到 ``</think>`` 切回 NORMAL；末尾同样 hold
  可能的闭合标签真前缀。吞掉的思考内容不丢弃——作为 reasoning 交付，
  前端思考流组件直接复用，用户照样能展开看，只是不再污染正文。

## flush 语义

流结束时调用 ``flush()``：
- NORMAL 下 hold 的残片被证明不是标签开头——原样吐回正文（这就是
  "hold 住等下一个 delta"的代价与正确性来源：宁可晚一拍，不可错放）；
- IN_THINK 下未闭合就断流——剩余内容按思考交付（它在 think 块语义里，
  作为正文放出来只会更怪）。
"""

from __future__ import annotations

import re

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"

_PROTOCOL_TAG_PATTERN = re.compile(
    r"</?(?:longcat|tool_call|tool_calls|function_call|arg_key|arg_val|arg_value)[^>]*>",
    re.IGNORECASE,
)


def strip_protocol_tags(text: str) -> str:
    """Strip leaked raw RPC/model protocol tags from text."""
    if not text:
        return ""
    return _PROTOCOL_TAG_PATTERN.sub("", text).strip()


def _longest_suffix_prefix(haystack: str, needle: str) -> int:
    """haystack 末尾与 needle 开头重合的最长长度。

    返回值 k 满足 ``haystack.endswith(needle[:k])`` 且 0 <= k < len(needle)；
    haystack 已包含完整 needle 时返回 -1（调用方应先查包含关系）。
    """
    for k in range(min(len(needle) - 1, len(haystack)), 0, -1):
        if haystack.endswith(needle[:k]):
            return k
    return 0


class StreamingThinkScrubber:
    """跨 delta 维持状态的内嵌思考块过滤器。

    用法::

        scrubber = StreamingThinkScrubber()
        for delta in stream:
            visible, reasoning = scrubber.feed(delta)
            if visible:
                yield visible          # 正文事件
            if reasoning:
                yield reasoning        # 思考事件
        visible, reasoning = scrubber.flush()
        ...  # 流收尾，处理 held-back 残片与未闭合块
    """

    def __init__(self) -> None:
        self._state = "NORMAL"  # NORMAL | IN_THINK
        self._buf = ""

    def feed(self, delta: str) -> tuple[str, str]:
        """喂入一个 delta，返回 ``(visible, reasoning)``。

        两者都可能为空串；同一次 feed 一般只有一边非空（边界情形除外）。
        """
        if not delta:
            return "", ""
        self._buf += delta
        return self._drain(final=False)

    def flush(self) -> tuple[str, str]:
        """流收尾：交还一切被 hold 的内容。调用后状态机复位。"""
        visible, reasoning = self._drain(final=True)
        if self._buf:
            if self._state == "IN_THINK":
                reasoning += self._buf
            else:
                visible += self._buf
            self._buf = ""
        self._state = "NORMAL"
        return visible, reasoning

    # ------------------------------------------------------------------

    def _drain(self, *, final: bool) -> tuple[str, str]:
        visible_parts: list[str] = []
        reasoning_parts: list[str] = []

        while self._buf:
            if self._state == "NORMAL":
                idx = self._buf.find(THINK_OPEN)
                if idx >= 0:
                    visible_parts.append(self._buf[:idx])
                    self._buf = self._buf[idx + len(THINK_OPEN):]
                    self._state = "IN_THINK"
                    continue
                if final:
                    visible_parts.append(self._buf)
                    self._buf = ""
                    break
                hold = _longest_suffix_prefix(self._buf, THINK_OPEN)
                if hold and hold < len(self._buf):
                    visible_parts.append(self._buf[:-hold])
                    self._buf = self._buf[-hold:]
                    break  # 等下一个 delta 来决断
                if hold == len(self._buf):
                    break  # 整个 buf 都可能是标签前缀，全部 hold
                visible_parts.append(self._buf)
                self._buf = ""
                break
            else:  # IN_THINK
                idx = self._buf.find(THINK_CLOSE)
                if idx >= 0:
                    reasoning_parts.append(self._buf[:idx])
                    self._buf = self._buf[idx + len(THINK_CLOSE):]
                    self._state = "NORMAL"
                    continue
                if final:
                    reasoning_parts.append(self._buf)
                    self._buf = ""
                    self._state = "NORMAL"
                    break
                hold = _longest_suffix_prefix(self._buf, THINK_CLOSE)
                if hold and hold < len(self._buf):
                    reasoning_parts.append(self._buf[:-hold])
                    self._buf = self._buf[-hold:]
                    break
                if hold == len(self._buf):
                    break
                reasoning_parts.append(self._buf)
                self._buf = ""
                break

        return "".join(visible_parts), "".join(reasoning_parts)


def scrub_static(text: str) -> tuple[str, str]:
    """非流式版本：一次性从完整文本里剥离思考块与协议残留标签。

    返回 ``(正文, 思考)``。多个 think 块的思考按出现顺序拼接；未闭合的
    think 块整体按思考处理（与流式 flush 语义一致）。
    """
    scrubber = StreamingThinkScrubber()
    visible, reasoning = scrubber.feed(text or "")
    v2, r2 = scrubber.flush()
    clean_visible = strip_protocol_tags(visible + v2)
    return clean_visible, reasoning + r2

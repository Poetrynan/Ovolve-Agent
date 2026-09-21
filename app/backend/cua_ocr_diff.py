"""OCR 反馈 diff 化：只把屏幕上"变化的部分"回传给模型。

连续动作场景下，两次 OCR 文本九成相同（同一块屏幕）——让模型把同样的行
反复读一遍是纯浪费。本模块维护"上一次 OCR 行集"，本次 OCR 后做行级 diff，
反馈摘要里只出现增/删/改的行；屏幕几乎没变时输出单行结论。

设计判据（零依赖离线可用）：
- 用 difflib.SequenceMatcher 按行对比（标准库），相似度按行集全量比率计
- 相似度 > ``UNCHANGED_SIMILARITY`` 判定"屏幕几乎未变"，输出 1 行，省全部 token
- 变化行带前缀 [+]/[-]/[~]（增/删/改），首行给计数标记（如 ``屏幕变化: +3 行 / -1 行``）
- 变化行展示量双上限（行数 + 字符数），超出部分以"N 行未展示"提示兜底，
  模型需要全貌时可主动调 screenshot 动作

用法（每个观察目标一个状态实例）::

    state = OcrDiffState()
    summary, diff = state.update_from_ocr(ocr_value)   # 首帧建基线
    summary, diff = state.update_from_ocr(ocr_value)   # 之后每帧只回传变化
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from typing import Optional

#: 行集相似度超过该值视为"屏幕几乎未变"——单行输出，不再罗列变化。
#: 严格大于：恰好 0.95 也算有变化（边界留给真实改动）。
UNCHANGED_SIMILARITY = 0.95

#: 变化行的展示上限（行数/字符数双闸），与 cua_actions 的 OCR 摘要预算同思路。
DIFF_MAX_LINES = 12
DIFF_MAX_CHARS = 600

_PREFIX_ADD = "[+] "
_PREFIX_DEL = "[-] "
_PREFIX_MOD = "[~] "


@dataclass
class OcrDiffResult:
    """一次行级 diff 的完整产物：变化行、统计量、两个快捷判定位。"""

    changed_lines: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    unchanged_screen: bool = False
    is_first_frame: bool = False


def _norm_lines(texts) -> list[str]:
    """归一化行集：转字符串、去首尾空白、丢空行——OCR 噪声的第一道滤网。"""
    return [str(t).strip() for t in (texts or []) if str(t).strip()]


def diff_ocr_lines(prev: list[str], curr: list[str]) -> OcrDiffResult:
    """对两帧 OCR 行集做行级 diff：返回（变化行, 统计）。

    变化行带前缀 [+]/[-]/[~]；相似度超阈值时 ``unchanged_screen=True`` 且
    变化行为空。纯函数，不改任何入参。
    """
    prev_n = _norm_lines(prev)
    curr_n = _norm_lines(curr)

    if not prev_n and not curr_n:
        return OcrDiffResult(
            changed_lines=[],
            stats={"added": 0, "removed": 0, "changed": 0,
                   "similarity": 1.0, "prev_lines": 0, "curr_lines": 0},
            unchanged_screen=True,
        )

    # 首帧：没有基线，整屏都是"新增"，但这是建基线不是真变化。
    if not prev_n:
        return OcrDiffResult(
            changed_lines=[_PREFIX_ADD + line for line in curr_n],
            stats={"added": len(curr_n), "removed": 0, "changed": 0,
                   "similarity": 0.0, "prev_lines": 0, "curr_lines": len(curr_n)},
            unchanged_screen=False,
            is_first_frame=True,
        )

    matcher = difflib.SequenceMatcher(a=prev_n, b=curr_n, autojunk=False)
    similarity = matcher.ratio()

    if similarity > UNCHANGED_SIMILARITY:
        return OcrDiffResult(
            changed_lines=[],
            stats={"added": 0, "removed": 0, "changed": 0,
                   "similarity": round(similarity, 3),
                   "prev_lines": len(prev_n), "curr_lines": len(curr_n)},
            unchanged_screen=True,
        )

    changed: list[str] = []
    added = removed = modded = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "delete":
            for line in prev_n[i1:i2]:
                changed.append(_PREFIX_DEL + line)
                removed += 1
        elif tag == "insert":
            for line in curr_n[j1:j2]:
                changed.append(_PREFIX_ADD + line)
                added += 1
        else:  # replace：旧→新成对记 [~]，多出来的部分各自记 [+]/[-]
            pairs = min(i2 - i1, j2 - j1)
            for k in range(pairs):
                changed.append(_PREFIX_MOD + curr_n[j1 + k])
                modded += 1
            for line in prev_n[i1 + pairs:i2]:
                changed.append(_PREFIX_DEL + line)
                removed += 1
            for line in curr_n[j1 + pairs:j2]:
                changed.append(_PREFIX_ADD + line)
                added += 1

    return OcrDiffResult(
        changed_lines=changed,
        stats={"added": added, "removed": removed, "changed": modded,
               "similarity": round(similarity, 3),
               "prev_lines": len(prev_n), "curr_lines": len(curr_n)},
        unchanged_screen=False,
    )


def render_ocr_diff(result: OcrDiffResult) -> str:
    """把 diff 结果渲染成反馈摘要：首行计数标记，随后是（限量后的）变化行。"""
    if result.is_first_frame:
        n = result.stats.get("added", 0)
        return f"屏幕观察(首帧): 基线已建立（{n} 行），下一步起只回传屏幕变化"
    if result.unchanged_screen:
        pct = int(round(result.stats.get("similarity", 1.0) * 100))
        return f"屏幕几乎未变（相似度 {pct}%），无需重读屏幕内容"

    stats = result.stats
    header = f"屏幕变化: +{stats.get('added', 0)} 行 / -{stats.get('removed', 0)} 行"
    if stats.get("changed"):
        header += f" / ~{stats['changed']} 行改动"

    shown: list[str] = []
    used = 0
    for line in result.changed_lines:
        if len(shown) >= DIFF_MAX_LINES or used + len(line) > DIFF_MAX_CHARS:
            break
        shown.append(line)
        used += len(line)

    dropped = len(result.changed_lines) - len(shown)
    tail = f"\n（另有 {dropped} 行变化未展示，需要全貌请调 screenshot）" if dropped else ""
    return "\n".join([header] + shown) + tail


@dataclass
class OcrDiffState:
    """一个观察目标的滚动基线：记住上一次 OCR 行集，每帧产出 diff 摘要。

    每台桌面目标 / 每个浏览器标签各持一个实例；目标切换或会话结束时调
    ``reset()`` 清基线，避免跨屏幕错比。
    """

    last_lines: list[str] = field(default_factory=list)
    has_baseline: bool = False

    def update_from_lines(self, texts: list[str]) -> tuple[str, OcrDiffResult]:
        """喂入本次 OCR 行文本，返回（反馈摘要, diff 产物），并推进基线。"""
        curr = _norm_lines(texts)
        if not self.has_baseline:
            result = diff_ocr_lines([], curr)
            # 首帧空屏（如 OCR 失败）也按"建基线"报告，而不是误导性的"屏幕几乎未变"
            result.is_first_frame = True
            self.last_lines = curr
            self.has_baseline = True
            return render_ocr_diff(result), result
        result = diff_ocr_lines(self.last_lines, curr)
        self.last_lines = curr
        return render_ocr_diff(result), result

    def update_from_ocr(self, ocr_value: dict) -> tuple[str, OcrDiffResult]:
        """便捷入口：直接喂 OCR 引擎的原始输出（与 summarize_ocr 同一提取约定）。"""
        lines = []
        if isinstance(ocr_value, dict):
            for item in ocr_value.get("lines") or []:
                if isinstance(item, dict):
                    lines.append(str(item.get("text", "")))
        return self.update_from_lines(lines)

    def reset(self) -> None:
        """清基线：目标切换/会话结束后调用，下一帧重新按首帧处理。"""
        self.last_lines = []
        self.has_baseline = False

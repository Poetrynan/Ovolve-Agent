"""repeat_tool_guard.py — 循环死锁与重复调用主动守卫。

职责：
1. 在 AgentLoop 工具执行流中实时监控工具调用指纹；
2. 识别连续相似调用且产出无进展的死循环模式；
3. 生成建议性脱困提示（Advisory Context），引导模型跳出局部死锁；
4. 输出结构化故障指纹（Failure Signature），直接作为高质量负反馈信号喂入 GEPA 自进化引擎。
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


def _normalize_args_fingerprint(args: Any) -> str:
    """提取参数的规范化哈希指纹，忽略字典键序与空值微小抖动。"""
    if not isinstance(args, dict):
        return str(args)
    # 提取核心参数键值
    clean_dict = {}
    for k, v in sorted(args.items()):
        if k in ("session_id", "timestamp", "request_id"):
            continue
        if isinstance(v, str):
            clean_dict[k] = v.strip()
        elif isinstance(v, (int, float, bool)):
            clean_dict[k] = v
        elif isinstance(v, (list, dict)):
            clean_dict[k] = json.dumps(v, sort_keys=True, ensure_ascii=False)
    serialized = json.dumps(clean_dict, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(serialized.encode("utf-8")).hexdigest()[:12]


@dataclass
class ToolCallEntry:
    tool_name: str
    args_fingerprint: str
    args_summary: str
    timestamp: float = field(default_factory=time.time)
    outcome_ok: bool = True
    outcome_length: int = 0


class RepeatToolGuard:
    """工具循环死锁检测器与脱困建议生成器。"""

    def __init__(self, max_window_size: int = 10, repeat_threshold: int = 3):
        self.max_window_size = max_window_size
        self.repeat_threshold = repeat_threshold
        self.history: List[ToolCallEntry] = []
        self._last_alert_fingerprint: Optional[str] = None

    def record_call(self, tool_name: str, args: dict, outcome_ok: bool = True, outcome_content: str = "") -> None:
        """记录一次工具调用的指纹。"""
        fp = _normalize_args_fingerprint(args)
        summary = str(args)[:100]
        entry = ToolCallEntry(
            tool_name=tool_name,
            args_fingerprint=fp,
            args_summary=summary,
            timestamp=time.time(),
            outcome_ok=outcome_ok,
            outcome_length=len(str(outcome_content or "")),
        )
        self.history.append(entry)
        if len(self.history) > self.max_window_size:
            self.history.pop(0)

    def check_loop(self) -> Optional[Dict[str, Any]]:
        """检查当前窗口是否命中工具死循环模式。"""
        if len(self.history) < self.repeat_threshold:
            return None

        # 检查尾部连续调用
        tail = self.history[-self.repeat_threshold:]
        target_tool = tail[0].tool_name
        target_fp = tail[0].args_fingerprint

        # 如果尾部 N 次全都是同一个工具，且参数指纹一致或相似
        is_exact_repeat = all(e.tool_name == target_tool and e.args_fingerprint == target_fp for e in tail)

        # 或者滑动窗口内同一工具、同一参数调用次数超过阈值
        count = sum(1 for e in self.history if e.tool_name == target_tool and e.args_fingerprint == target_fp)

        if (is_exact_repeat or count >= self.repeat_threshold) and target_fp != self._last_alert_fingerprint:
            self._last_alert_fingerprint = target_fp
            return {
                "detected": True,
                "tool_name": target_tool,
                "repeat_count": count,
                "args_summary": tail[-1].args_summary,
                "advisory_message": (
                    f"【系统防死循环守卫提示】: 你已连续 {count} 次执行类似的 `{target_tool}` 操作且未取得新突破。"
                    "请停止重复盲试！请尝试：1) 更换排查关键词或检索策略；2) 查看目录树或文件结构；3) 向用户澄清或说明当前困境。"
                ),
                "failure_signature": f"repeat_loop:{target_tool}:{target_fp}",
            }
        return None

    def reset(self) -> None:
        """重置守卫历史。"""
        self.history.clear()
        self._last_alert_fingerprint = None

"""tool_output_spill.py — 工具超长输出溢出转储与精简预览系统。

职责：
1. 拦截超过阈值（默认 16,000 字符 / ~4,000 tokens）的超大工具执行输出；
2. 自动将完整无损内容持久化落盘至本地会话 Spill 文件中（`spills/spill_*.txt`）；
3. 向模型上下文返回包含 Head-Tail 双端关键信息的紧凑有界预览；
4. 彻底净化 Agent 上下文与自进化记忆提取（Pre-compaction Flush），防止海量构建日志污染。
"""
from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class SpillResult:
    is_spilled: bool
    content: str
    spill_id: str = ""
    spill_path: str = ""
    total_chars: int = 0
    total_lines: int = 0


class ToolOutputSpillManager:
    """工具超长输出管理与安全转储器。"""

    def __init__(
        self,
        threshold_chars: int = 16000,
        head_lines: int = 40,
        tail_lines: int = 40,
        spill_dir: Optional[str] = None,
    ):
        self.threshold_chars = threshold_chars
        self.head_lines = head_lines
        self.tail_lines = tail_lines
        self.spill_dir = spill_dir or os.path.join(os.path.expanduser("~"), ".ovolve", "spills")
        try:
            os.makedirs(self.spill_dir, exist_ok=True)
        except Exception:
            pass

    def process_output(
        self,
        raw_output: str,
        tool_name: str = "tool",
        session_id: str = "default",
        workspace: Optional[str] = None,
    ) -> SpillResult:
        """检查并处理超长输出。若未超限原样返回，超限则安全转储。"""
        if not raw_output or len(raw_output) <= self.threshold_chars:
            return SpillResult(
                is_spilled=False,
                content=raw_output or "",
                total_chars=len(raw_output or ""),
                total_lines=len((raw_output or "").splitlines()),
            )

        lines = raw_output.splitlines()
        total_lines = len(lines)
        total_chars = len(raw_output)

        spill_id = f"spill_{uuid.uuid4().hex[:8]}"
        target_dir = self.spill_dir
        if workspace and os.path.isdir(workspace):
            target_dir = os.path.join(workspace, ".ovolve", "spills")
        try:
            os.makedirs(target_dir, exist_ok=True)
        except Exception:
            target_dir = self.spill_dir

        spill_path = os.path.join(target_dir, f"{spill_id}_{tool_name}.txt")

        # 写入全量无损文本
        try:
            with open(spill_path, "w", encoding="utf-8", errors="replace") as f:
                f.write(raw_output)
        except Exception as e:
            # 降级：若写入失败，仍返回截断文本
            spill_path = f"write_failed: {e}"

        head_part = "\n".join(lines[: self.head_lines])
        tail_part = "\n".join(lines[-self.tail_lines :]) if total_lines > self.head_lines else ""
        omitted_lines = max(0, total_lines - self.head_lines - self.tail_lines)
        omitted_chars = max(0, total_chars - len(head_part) - len(tail_part))

        rendered_preview = (
            f"[⚠️ 工具 `{tool_name}` 输出过长（共 {total_chars} 字符 / {total_lines} 行），已自动安全转储至磁盘以节省 Token 并防止上下文污染]\n"
            f"· 转储文件路径: {spill_path}\n"
            f"· Spill ID: {spill_id}\n\n"
            f"=== 头部输出 (前 {min(self.head_lines, total_lines)} 行) ===\n"
            f"{head_part}\n\n"
            f"... [中间已安全省略 {omitted_lines} 行 / {omitted_chars} 字符；如需精准查阅，可通过文件读取工具查看完整文件] ...\n\n"
            f"=== 尾部输出 (后 {min(self.tail_lines, len(lines) - self.head_lines)} 行) ===\n"
            f"{tail_part}"
        )

        return SpillResult(
            is_spilled=True,
            content=rendered_preview,
            spill_id=spill_id,
            spill_path=spill_path,
            total_chars=total_chars,
            total_lines=total_lines,
        )

    def read_spill(self, file_path: str, start_line: int = 1, line_count: int = 100) -> str:
        """从转储文件中切片读取特定行范围。"""
        if not os.path.isfile(file_path):
            return f"Error: Spill file not found: {file_path}"
        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
            start_idx = max(0, start_line - 1)
            end_idx = min(len(lines), start_idx + line_count)
            return "".join(lines[start_idx:end_idx])
        except Exception as e:
            return f"Error reading spill file: {e}"


# 全局单例
_default_spill_mgr = ToolOutputSpillManager()

def get_spill_manager() -> ToolOutputSpillManager:
    return _default_spill_mgr

"""
agent_logger.py - Comprehensive Agent & Tool Debugging Logger for Ovolve.

Logs every agent thought, model call, tool dispatch, risk/permission authorization,
and execution result with precise timing, structured JSON, and clean formatting.
Outputs to:
  1. Console stdout (safe encoding)
  2. Log file: <workspace>/logs/agent_debug.log (UTF-8)
"""
import os
import sys
import time
import json
import logging
from typing import Any, Optional

_logger: Optional[logging.Logger] = None
_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
_LOG_FILE = os.path.join(_LOG_DIR, "agent_debug.log")


class SafeStreamHandler(logging.StreamHandler):
    """StreamHandler that encodes to stdout using errors='replace' so Windows GBK won't crash on emoji."""
    def emit(self, record):
        try:
            msg = self.format(record)
            stream = self.stream
            # If stdout has reconfigure or buffer, use safe write
            if hasattr(stream, "buffer"):
                stream.buffer.write((msg + self.terminator).encode(stream.encoding or "utf-8", errors="replace"))
                stream.buffer.flush()
            else:
                stream.write(msg + self.terminator)
                self.flush()
        except Exception:
            self.handleError(record)


def get_agent_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger

    os.makedirs(_LOG_DIR, exist_ok=True)
    logger = logging.getLogger("ovolve.agent")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    if not logger.handlers:
        # File handler (with UTF-8 encoding)
        try:
            fh = logging.FileHandler(_LOG_FILE, mode="a", encoding="utf-8")
            fh.setLevel(logging.DEBUG)
            file_fmt = logging.Formatter(
                "[%(asctime)s] [%(levelname)s] %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
            fh.setFormatter(file_fmt)
            logger.addHandler(fh)
        except Exception as e:
            sys.stderr.write(f"Failed to open agent debug log file: {e}\n")

        # Safe Console handler
        ch = SafeStreamHandler(sys.stdout)
        ch.setLevel(logging.INFO)
        console_fmt = logging.Formatter("[Agent Debug] %(message)s")
        ch.setFormatter(console_fmt)
        logger.addHandler(ch)

    _logger = logger
    return _logger


def log_turn_start(session_id: str, turn_index: int, prompt: str, permission: str, model: str):
    logger = get_agent_logger()
    logger.info(
        f">> TURN START [#{turn_index}] Session={session_id[:8]} Mode={permission} Model={model}\n"
        f"   User Prompt: {prompt[:200]}"
    )


def log_reasoning_step(step: int, reasoning: str):
    logger = get_agent_logger()
    preview = reasoning.strip().replace("\n", " ")[:200]
    logger.info(f"   [Step {step}] Thought: {preview}...")


def log_tool_dispatch(
    tool_name: str,
    args: dict,
    call_id: str,
    permission: str,
    confirmed: bool,
    sandbox_mode: str,
):
    logger = get_agent_logger()
    args_json = json.dumps(args, ensure_ascii=False)
    logger.info(
        f"   [TOOL DISPATCH] `{tool_name}` (callId={call_id[:8]})\n"
        f"      Args: {args_json[:300]}\n"
        f"      Auth: mode={permission}, confirmed={confirmed}, sandbox={sandbox_mode}"
    )


def log_tool_result(
    tool_name: str,
    call_id: str,
    ok: bool,
    status: str,
    duration_ms: float,
    result_preview: str,
    error: Optional[str] = None,
):
    logger = get_agent_logger()
    tag = "[SUCCESS]" if ok else "[FAILED]"
    logger.info(
        f"   {tag} TOOL RESULT: `{tool_name}` [{status}] in {duration_ms:.1f}ms\n"
        f"      {('Error: ' + str(error)) if error else ('Output: ' + result_preview[:200])}"
    )


def log_turn_end(session_id: str, turn_index: int, total_steps: int, duration_s: float):
    logger = get_agent_logger()
    logger.info(
        f"<< TURN END [#{turn_index}] Steps={total_steps} Duration={duration_s:.2f}s\n"
        f"{'='*60}"
    )

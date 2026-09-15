"""ask_user_question.py — 结构化决策模态卡片交互系统 

当 AI 遇到架构决策分歧、多方案选型或关键参数不确定时，
调用 ask_user_question 工具挂起当前任务并向前端推送结构化决策卡片。
前端弹出单选/多选/推荐项模态卡片供用户一键选择，无需繁琐打字。
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class QuestionOption:
    id: str
    label: str
    description: str = ""
    is_recommended: bool = False
    preview_snippet: str = ""


@dataclass
class UserQuestionPayload:
    question_id: str
    title: str
    description: str
    options: list[QuestionOption]
    allow_multiple: bool = False
    allow_custom_input: bool = True
    status: str = "pending"  # "pending" | "answered" | "cancelled"
    selected_options: list[str] = field(default_factory=list)
    custom_input: str = ""


class QuestionRegistry:
    """内存中的提问挂起与异步应答注册表"""

    def __init__(self):
        self._pending: dict[str, UserQuestionPayload] = {}
        self._futures: dict[str, asyncio.Future] = {}

    def create_question(
        self,
        title: str,
        description: str,
        options: list[dict[str, Any]],
        allow_multiple: bool = False,
        allow_custom_input: bool = True,
    ) -> UserQuestionPayload:
        qid = f"q-{uuid.uuid4().hex[:8]}"
        opts = [
            QuestionOption(
                id=o.get("id", f"opt-{i}"),
                label=o.get("label", str(o)),
                description=o.get("description", ""),
                is_recommended=bool(o.get("is_recommended", False)),
                preview_snippet=o.get("preview_snippet", ""),
            )
            for i, o in enumerate(options)
        ]
        payload = UserQuestionPayload(
            question_id=qid,
            title=title,
            description=description,
            options=opts,
            allow_multiple=allow_multiple,
            allow_custom_input=allow_custom_input,
        )
        self._pending[qid] = payload
        return payload

    async def wait_for_answer(self, question_id: str, timeout: float = 300.0) -> dict[str, Any]:
        """异步等待用户从前端点击提交答案"""
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self._futures[question_id] = fut

        try:
            res = await asyncio.wait_for(fut, timeout=timeout)
            return res
        except asyncio.TimeoutError:
            if question_id in self._pending:
                self._pending[question_id].status = "cancelled"
            return {"status": "timeout", "selected": [], "custom": ""}
        finally:
            self._futures.pop(question_id, None)

    def submit_answer(self, question_id: str, selected_options: list[str], custom_input: str = "") -> bool:
        """前端通过 HTTP API 提交用户的选择"""
        if question_id not in self._pending:
            return False
        payload = self._pending[question_id]
        payload.status = "answered"
        payload.selected_options = selected_options
        payload.custom_input = custom_input

        if question_id in self._futures and not self._futures[question_id].done():
            self._futures[question_id].set_result({
                "status": "answered",
                "question_id": question_id,
                "selected": selected_options,
                "custom": custom_input,
            })
            return True
        return True

    def get_pending(self, question_id: str) -> Optional[UserQuestionPayload]:
        return self._pending.get(question_id)

    def list_pending(self) -> list[UserQuestionPayload]:
        return [p for p in self._pending.values() if p.status == "pending"]


_GLOBAL_QUESTION_REGISTRY: Optional[QuestionRegistry] = None


def get_question_registry() -> QuestionRegistry:
    global _GLOBAL_QUESTION_REGISTRY
    if _GLOBAL_QUESTION_REGISTRY is None:
        _GLOBAL_QUESTION_REGISTRY = QuestionRegistry()
    return _GLOBAL_QUESTION_REGISTRY


async def ask_user_question_handler(
    title: str,
    description: str,
    options: list[dict[str, Any]],
    allow_multiple: bool = False,
    allow_custom_input: bool = True,
    timeout: float = 180.0,
) -> dict[str, Any]:
    """ask_user_question 工具运行时处理入口"""
    registry = get_question_registry()
    q = registry.create_question(
        title=title,
        description=description,
        options=options,
        allow_multiple=allow_multiple,
        allow_custom_input=allow_custom_input,
    )
    # 在非交互环境或直接调用时，默认推荐项返回
    return {
        "status": "question_created",
        "question_id": q.question_id,
        "title": q.title,
        "options_count": len(q.options),
        "options": [
            {
                "id": o.id,
                "label": o.label,
                "is_recommended": o.is_recommended,
            }
            for o in q.options
        ],
    }

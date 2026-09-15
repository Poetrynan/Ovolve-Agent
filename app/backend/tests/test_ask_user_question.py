import pytest
import asyncio
from ask_user_question import QuestionRegistry, get_question_registry, ask_user_question_handler


@pytest.mark.asyncio
async def test_question_creation_and_answer():
    reg = QuestionRegistry()
    q = reg.create_question(
        title="选择前端框架",
        description="请选择重构使用的前端框架",
        options=[
            {"id": "react", "label": "React 19", "is_recommended": True},
            {"id": "vue", "label": "Vue 3"},
        ],
    )
    assert q.status == "pending"
    assert len(q.options) == 2

    # Async answer simulation
    async def simulate_user_click():
        await asyncio.sleep(0.05)
        reg.submit_answer(q.question_id, ["react"], custom_input="")

    asyncio.create_task(simulate_user_click())
    ans = await reg.wait_for_answer(q.question_id, timeout=2.0)
    assert ans["status"] == "answered"
    assert ans["selected"] == ["react"]


@pytest.mark.asyncio
async def test_ask_user_question_handler():
    out = await ask_user_question_handler(
        title="测试决策",
        description="测试选项",
        options=[{"id": "opt1", "label": "选项1"}],
    )
    assert out["status"] == "question_created"
    assert out["options_count"] == 1

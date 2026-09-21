"""Test storage layer against the real Storage API."""
import pytest
import os
import time
import uuid
import tempfile
from storage import Storage


@pytest.fixture
def temp_storage():
    """Create a temporary storage instance.

    Storage must be closed before the TemporaryDirectory is removed: WAL mode
    keeps -wal/-shm handles open, and on Windows an open handle makes the
    cleanup raise WinError 32.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        db_dir = os.path.join(tmpdir, "db")
        storage = Storage(db_dir=db_dir)
        try:
            yield storage
        finally:
            storage.close()


def test_storage_creation(temp_storage):
    """Test storage creation."""
    assert temp_storage is not None
    assert os.path.exists(temp_storage.db_dir)


def test_session_creation(temp_storage):
    """Test session creation (void return, not Result)."""
    sid = str(uuid.uuid4())
    temp_storage.create_session(sid, "Test session")
    # Verify by retrieving messages (empty list, no error)
    msgs = temp_storage.get_messages(sid)
    assert msgs == []


def test_message_add_retrieve(temp_storage):
    """Test adding and retrieving messages."""
    sid = str(uuid.uuid4())
    temp_storage.create_session(sid, "Test session")

    temp_storage.add_message(sid, "user", "Hello world")
    temp_storage.add_message(sid, "assistant", "Hi there!")

    messages = temp_storage.get_messages(sid)
    assert len(messages) == 2
    assert messages[0]["role"] == "user"
    assert messages[0]["content"] == "Hello world"
    assert messages[1]["role"] == "assistant"


def test_kv_store(temp_storage):
    """Test key-value storage."""
    temp_storage.kv_set("test_key", "test_value")
    result = temp_storage.kv_get("test_key")
    assert result == "test_value"

    result = temp_storage.kv_get("nonexistent", default="default")
    assert result == "default"


def test_kv_store_json(temp_storage):
    """Test that kv_set handles dicts (JSON serialized)."""
    temp_storage.kv_set("obj_key", {"nested": True, "count": 42})
    result = temp_storage.kv_get("obj_key")
    assert isinstance(result, dict)
    assert result["nested"] == True
    assert result["count"] == 42


def test_goal_operations(temp_storage):
    """Test goal save/get/list using the real API."""
    gid = str(uuid.uuid4())
    sid = str(uuid.uuid4())

    # Save goal (positional: id, desc, status, iteration, session_id, verification)
    temp_storage.save_goal(gid, "Test goal", "active", 0, sid, "")

    # Get goal
    goal = temp_storage.get_goal(gid)
    assert goal is not None
    assert goal["description"] == "Test goal"
    assert goal["status"] == "active"

    # Update status
    temp_storage.save_goal(gid, "Test goal", "completed", 1, sid, '{"passed":true}')
    goal_updated = temp_storage.get_goal(gid)
    assert goal_updated["status"] == "completed"
    assert goal_updated["iteration"] == 1

    # List goals
    goals = temp_storage.list_goals()
    assert any(g["id"] == gid for g in goals)

    # List by status
    completed = temp_storage.list_goals(status="completed")
    assert any(g["id"] == gid for g in completed)
    active = temp_storage.list_goals(status="active")
    assert not any(g["id"] == gid for g in active)


def test_cron_operations(temp_storage):
    """Test cron job save/get/update/list."""
    cid = str(uuid.uuid4())
    now = int(time.time())

    job = {
        "id": cid,
        "title": "Test Cron",
        "prompt": "Run test",
        "cron_expr": "*/5 * * * *",
        "delay_minutes": 0,
        "recurring": 1,
        "max_runs": 0,
        "next_run_at": now + 300,
        "last_run_at": 0,
        "run_count": 0,
        "status": "active",
        "bot_delivery_target": "",
        "session_id": "",
        "created_at": now,
    }

    # Save cron
    temp_storage.save_cron_job(job)

    # Update status via update_cron_job (returns None; verify by reload)
    temp_storage.update_cron_job(cid, status="paused")

    # List all cron jobs — no per-job get_cron helper exists, so pick from list
    crons = temp_storage.get_cron_jobs(active=False)
    match = [c for c in crons if c["id"] == cid]
    assert len(match) == 1
    assert match[0]["title"] == "Test Cron"
    assert match[0]["status"] == "paused"


def test_memory_entries(temp_storage):
    """Test memory save/search."""
    eid = str(uuid.uuid4())
    temp_storage.save_memory_entry(
        eid=eid, sid="sess1", root="/proj", scope="project",
        content="User prefers dark mode", mem_type="preference",
        importance=0.8, tags=["ui"], archived=0,
    )

    entries = temp_storage.get_memory_entries(root="/proj")
    assert len(entries) == 1
    assert entries[0]["content"] == "User prefers dark mode"

    # Keyword search
    found = temp_storage.search_memory_semantic(root="/proj", keywords=["dark"])
    assert len(found) == 1

    # Archive
    temp_storage.archive_memory(eid)
    active = temp_storage.get_memory_entries(root="/proj", include_archived=False)
    assert len(active) == 0


def test_config(temp_storage):
    """Test config get/set."""
    temp_storage.set_config("theme", "dark")
    assert temp_storage.get_config("theme") == "dark"
    assert temp_storage.get_config("missing", "fallback") == "fallback"


def test_session_synthesis(temp_storage):
    """Test session synthesis save/get."""
    sid = str(uuid.uuid4())
    syn = {"Goal": ["build app"], "Progress": ["created router"], "Decisions": [], "Open Issues": []}
    temp_storage.save_session_synthesis(sid, syn)
    loaded = temp_storage.get_session_synthesis(sid)
    assert loaded["Goal"] == ["build app"]

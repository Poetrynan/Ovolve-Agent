import sys
import os
import tempfile
from pathlib import Path
import pytest
from PIL import Image

# Ensure app/backend and scripts are in sys.path
backend_dir = Path(__file__).parent.parent
project_root = backend_dir.parent.parent
scripts_dir = project_root / "scripts"

if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))
if str(scripts_dir) not in sys.path:
    sys.path.insert(0, str(scripts_dir))

# ---------------------------------------------------------------------------
# Database isolation — set at conftest IMPORT time, not in a fixture.
#
# `storage.get_storage()` is a lazy singleton that defaults to
# ~/.ovolve/db — the user's live database. Any test (or any module imported
# by a test) that touched that singleton wrote real rows into the running
# app: 98 fabricated goals once appeared on the user's Goals board this way.
#
# A fixture is too late, because a test module can build the singleton during
# import. So the redirect happens here, before pytest imports anything else.
# ---------------------------------------------------------------------------
_TEST_DB_DIR = tempfile.mkdtemp(prefix="ovolve-test-db-")
os.environ["OVOLVE_DB_DIR"] = _TEST_DB_DIR


@pytest.fixture(scope="session", autouse=True)
def _assert_db_isolated():
    """Fail loudly if anything re-pointed storage at the real database.

    A silent fallback is what caused the original damage, so this asserts
    rather than warns.
    """
    from storage import get_storage

    real = os.path.join(os.path.expanduser("~"), ".ovolve", "db")
    got = os.path.abspath(get_storage().db_dir)
    assert got != os.path.abspath(real), (
        f"tests are writing to the production database at {got}"
    )
    yield


# ---------------------------------------------------------------------------
# Process-singleton reset — module-level state leaks between tests.
#
# Several modules keep state on module globals (lazy singletons, a process-wide
# lock). A test that leaves one behind changes what the NEXT test sees. The
# symptom is "passes alone, fails in the full run", and the failure surfaces
# far away from the polluter — which is why it reads as flakiness and gets
# mislabelled "environment legacy" instead of being debugged.
#
# Two confirmed cases, both reproduced:
#   · evolution._engine — a lazy singleton some tests leave in ACTIVE mode.
#     approvals_projection falls back to it when no engine is passed, so a
#     leftover engine injected ghost "pending proposals" into a later test's
#     counts.
#   · instance_lock._state — a process-wide lock. A test that acquired it and
#     never released made the next test's first acquire() return
#     acquired=False, failing an assertion about the SECOND holder.
#
# Reset here, once, instead of sprinkling cleanup into individual test files:
# per-file fixes only protect that file, and the next leak gets found the same
# expensive way.
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_process_singletons():
    """每个用例结束后把进程级单例恢复成模块初始状态。"""
    import evolution
    import instance_lock

    yield

    # 锁：先松开句柄再复位状态。锁文件落在用例自己的 tmp_path 里，目录由
    # pytest 收走；但状态不复位的话，下一个用例的首次 acquire() 会以为
    # 锁还被别人持有。
    try:
        if instance_lock._state.get("acquired"):
            instance_lock.release()
    except Exception:
        pass
    instance_lock._state.clear()
    instance_lock._state.update({"lock_path": "", "acquired": False})

    # 懒单例：清回 None，下一个用例要么自己建、要么走"没建过"的降级分支。
    evolution._engine = None


@pytest.fixture
def temp_image_dir(tmp_path):
    """Fixture providing temporary input and output directories for image processing."""
    input_dir = tmp_path / "raw_assets"
    output_dir = tmp_path / "processed_assets"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    return input_dir, output_dir


@pytest.fixture
def sample_standee_png(temp_image_dir):
    """Fixture creating a test 300x300 PNG with a solid background and colored center."""
    input_dir, output_dir = temp_image_dir
    img = Image.new("RGBA", (300, 300), (255, 255, 255, 255))
    # Draw character in center (purple for file_agent)
    for x in range(100, 200):
        for y in range(80, 260):
            img.putpixel((x, y), (147, 51, 234, 255))

    file_path = input_dir / "file_agent_idle.png"
    img.save(file_path)
    return file_path, output_dir

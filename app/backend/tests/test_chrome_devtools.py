import os
import shutil
import tempfile
import pytest
from chrome_devtools import ChromeDevToolsClient, get_chrome_devtools_client, chrome_devtools_handler


def test_chrome_devtools_diagnostics_mock():
    client = ChromeDevToolsClient(cdp_port=9999)  # unreachable port
    assert client.is_chrome_running_with_cdp() is False

    summary = client.get_diagnostics_summary()
    assert summary["status"] == "cdp_unavailable"

    # Test error recording
    client.record_simulated_error("error", "Uncaught TypeError: Cannot read property of undefined", "app.js", 42)
    assert len(client._console_logs) == 1
    assert client._console_logs[0].level == "error"


def test_chrome_devtools_handler():
    res = chrome_devtools_handler(action="summary")
    assert "status" in res


def test_chrome_devtools_screencast_actions():
    from chrome_devtools import chrome_devtools_handler
    # 未连上真实 CDP 时应安全返回说明或模拟成功，绝不抛出未处理异常
    res = chrome_devtools_handler(action="screencast_status")
    assert "status" in res
    assert res["status"] == "ok"
    assert res["recording"] is False


def test_chrome_devtools_screencast_lifecycle():
    """录屏全生命周期必须可在无 Chrome 环境下安全跑完（fail-open）。"""
    from chrome_devtools import get_screencast_recorder

    tmp_dir = tempfile.mkdtemp(prefix="ovolve_test_dt_screencast_")
    try:
        start_res = chrome_devtools_handler(
            action="screencast_start", tab_id="tab-unit", output_dir=tmp_dir
        )
        assert "status" in start_res
        assert start_res["status"] in ("ok", "degraded")
        assert get_screencast_recorder().is_recording()

        mid = chrome_devtools_handler(action="screencast_status")
        assert mid["status"] == "ok"
        assert mid["recording"] is True
        assert mid["session"]["tab_id"] == "tab-unit"

        stop_res = chrome_devtools_handler(action="screencast_stop")
        assert stop_res["status"] == "ok"
        assert not get_screencast_recorder().is_recording()
        assert stop_res["summary"]["total_frames"] == 0
    finally:
        # 录制器是进程级单例：断言中途失败也必须复位，否则会污染后续用例。
        if get_screencast_recorder().is_recording():
            chrome_devtools_handler(action="screencast_stop")
        shutil.rmtree(tmp_dir, ignore_errors=True)

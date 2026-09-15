# -*- coding: utf-8 -*-
"""test_cdp_screencast.py — CDP 录屏帧捕获、背压流控与合帧管线单元测试。

覆盖：
1. CDPScreencastRecorder 的启动/落帧/停止生命周期与背压确认号配对。
2. VideoComposer 的 ffmpeg 合帧与无 ffmpeg 时的 PIL 长图优雅降级。
"""
import base64
import os
import shutil
import tempfile
from pathlib import Path
import pytest
from cdp_screencast import CDPScreencastRecorder, VideoComposer

@pytest.fixture
def temp_record_dir():
    d = tempfile.mkdtemp(prefix="ovolve_test_screencast_")
    yield d
    shutil.rmtree(d, ignore_errors=True)

def test_screencast_recorder_lifecycle(temp_record_dir):
    recorder = CDPScreencastRecorder(output_dir=temp_record_dir)
    assert not recorder.is_recording()

    # 启动录屏
    res = recorder.start_recording(tab_id="tab-123", fps=10, quality=80)
    assert res.ok
    assert recorder.is_recording()
    assert recorder.session_info["tab_id"] == "tab-123"

    # 模拟写入 3 帧
    fake_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
    b64_data = base64.b64encode(fake_png).decode("utf-8")

    for i in range(3):
        ack = recorder.handle_frame_sync(session_id=i + 1, base64_data=b64_data)
        assert ack == i + 1

    # 检查帧落盘
    frames = list(recorder.get_recorded_frames())
    assert len(frames) == 3
    assert os.path.exists(frames[0])

    # 停止录屏
    stop_res = recorder.stop_recording()
    assert stop_res.ok
    assert not recorder.is_recording()
    assert stop_res.value["total_frames"] == 3


from cdp_screencast import VideoComposer
from PIL import Image

def test_video_composer_strip_fallback(temp_record_dir):
    # 生成 5 张真实测试小图 (100x100 纯色)
    frame_paths = []
    for i in range(5):
        img = Image.new("RGB", (100, 100), color=(i * 40, 100, 200))
        p = os.path.join(temp_record_dir, f"frame_{i+1:05d}.jpg")
        img.save(p)
        frame_paths.append(p)

    composer = VideoComposer()
    strip_target = os.path.join(temp_record_dir, "overview_strip.jpg")
    strip_res = composer.create_frame_strip(frame_paths, strip_target, max_frames=4)

    assert strip_res.ok
    assert os.path.exists(strip_target)
    strip_img = Image.open(strip_target)
    # 横向拼接 4 张 100x100 图，总宽应为 400，高为 100
    assert strip_img.size == (400, 100)

def test_video_composer_ffmpeg_detection():
    composer = VideoComposer()
    has_ffmpeg = composer.has_ffmpeg()
    assert isinstance(has_ffmpeg, bool)


def test_video_composer_custom_ffmpeg_dir_hit(tmp_path, monkeypatch):
    bin_dir = tmp_path / "custom_ffmpeg_bin"
    bin_dir.mkdir()
    fake_exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    fake_exe = bin_dir / fake_exe_name
    fake_exe.write_text("#!/bin/sh\necho ffmpeg", encoding="utf-8")

    monkeypatch.setenv("OVOLVE_FFMPEG_DIR", str(bin_dir))
    assert VideoComposer.has_ffmpeg() is True
    bin_path = VideoComposer.get_ffmpeg_bin()
    assert bin_path is not None
    assert str(fake_exe.resolve()).lower() == str(Path(bin_path).resolve()).lower()


def test_video_composer_custom_ffmpeg_dir_fallback(monkeypatch):
    monkeypatch.setenv("OVOLVE_FFMPEG_DIR", "D:/non_existent_fake_dir_99999")
    # 应回落到标准 PATH 探测
    expected = shutil.which("ffmpeg")
    assert VideoComposer.get_ffmpeg_bin() == expected


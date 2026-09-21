# -*- coding: utf-8 -*-
"""cdp_screencast.py — Chrome DevTools Protocol (CDP) 录屏与合帧管线。

职责：
1. 监听 CDP Page.screencastFrame 帧事件，将序列帧低开销写入临时目录。
2. 严格配对 Page.screencastFrameAck，保障浏览器端不发生内存膨胀（背压流控）。
3. 提供 VideoComposer，通过 ffmpeg 或 PIL 关键帧画卷生成最终审计凭证。

Fail-Open 承诺：本模块任何异常都不得向上冒泡阻断主 Agent 交互；
缺少 ffmpeg 时自动降级为静态长图画卷，而非抛出错误。
"""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from result import Result


class CDPScreencastRecorder:
    """CDP Screencast 帧接收与流控管理器"""

    def __init__(self, output_dir: Optional[str] = None):
        self._output_dir = Path(output_dir) if output_dir else None
        self._is_recording: bool = False
        self._frame_count: int = 0
        self._session_info: Dict[str, Any] = {}
        self._frame_paths: List[str] = []

    @property
    def session_info(self) -> Dict[str, Any]:
        return dict(self._session_info)

    def is_recording(self) -> bool:
        return self._is_recording

    def get_recorded_frames(self) -> List[str]:
        return list(self._frame_paths)

    def start_recording(
        self,
        tab_id: str,
        output_dir: Optional[str] = None,
        fps: int = 10,
        quality: int = 80,
        max_width: int = 1280,
        max_height: int = 720,
    ) -> Result:
        if self._is_recording:
            return Result.failure("录屏已在进行中，不可重复启动")

        if output_dir:
            self._output_dir = Path(output_dir)

        if not self._output_dir:
            ts = int(time.time())
            folder = Path.home() / ".ovolve" / "screencasts" / f"session_{tab_id}_{ts}"
            folder.mkdir(parents=True, exist_ok=True)
            self._output_dir = folder
        else:
            self._output_dir.mkdir(parents=True, exist_ok=True)

        self._frame_count = 0
        self._frame_paths.clear()
        self._is_recording = True
        self._session_info = {
            "tab_id": tab_id,
            "fps": fps,
            "quality": quality,
            "max_width": max_width,
            "max_height": max_height,
            "start_time": time.time(),
            "output_dir": str(self._output_dir),
        }
        return Result.success(self._session_info)

    def handle_frame_sync(self, session_id: int, base64_data: str) -> int:
        """接收单帧 base64 数据落盘并返回待确认的 sessionId。

        返回的 sessionId 供调用方立即下发 Page.screencastFrameAck，
        构成背压：未 Ack 的帧浏览器不会继续推送，避免内存膨胀。
        """
        if not self._is_recording or not self._output_dir:
            return session_id

        self._frame_count += 1
        frame_filename = f"frame_{self._frame_count:05d}.jpg"
        target_path = self._output_dir / frame_filename

        try:
            raw_bytes = base64.b64decode(base64_data)
            with open(target_path, "wb") as f:
                f.write(raw_bytes)
            self._frame_paths.append(str(target_path))
        except Exception:
            pass

        return session_id

    def stop_recording(self) -> Result:
        if not self._is_recording:
            return Result.failure("当前未在录屏状态")

        self._is_recording = False
        duration = time.time() - float(self._session_info.get("start_time", time.time()))
        summary = {
            "tab_id": self._session_info.get("tab_id"),
            "total_frames": self._frame_count,
            "duration_sec": round(duration, 2),
            "output_dir": str(self._output_dir),
            "frames": list(self._frame_paths),
        }
        return Result.success(summary)


class VideoComposer:
    """负责将离散序列帧合成为视频或生成概览长图"""

    @staticmethod
    def get_ffmpeg_bin() -> Optional[str]:
        """获取 ffmpeg 可执行文件路径，优先查 OVOLVE_FFMPEG_DIR，再回落 PATH。"""
        custom_dir = os.environ.get("OVOLVE_FFMPEG_DIR", "").strip()
        if custom_dir and os.path.isdir(custom_dir):
            for candidate in ("ffmpeg", "ffmpeg.exe"):
                bin_path = os.path.join(custom_dir, candidate)
                if os.path.isfile(bin_path):
                    return os.path.abspath(bin_path)

        return shutil.which("ffmpeg")

    @classmethod
    def has_ffmpeg(cls) -> bool:
        return cls.get_ffmpeg_bin() is not None

    def compose(
        self,
        frame_dir: Path | str,
        output_path: Path | str,
        fps: int = 10,
    ) -> Result:
        frame_path_obj = Path(frame_dir)
        output_obj = Path(output_path)
        output_obj.parent.mkdir(parents=True, exist_ok=True)

        frames = sorted(list(frame_path_obj.glob("frame_*.jpg")))
        if not frames:
            return Result.failure(f"目录 {frame_dir} 中未找到任何可合成的序列帧 (frame_*.jpg)")

        ffmpeg_bin = self.get_ffmpeg_bin()
        if ffmpeg_bin:
            cmd = [
                ffmpeg_bin,
                "-y",
                "-framerate", str(fps),
                "-i", str(frame_path_obj / "frame_%05d.jpg"),
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                str(output_obj),
            ]
            try:
                proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
                if proc.returncode == 0 and output_obj.exists():
                    return Result.success({
                        "mode": "ffmpeg_mp4",
                        "output_file": str(output_obj),
                        "frames_count": len(frames),
                        "fps": fps,
                    })
            except Exception:
                pass  # 发生异常走优雅降级

        # 降级：无 ffmpeg 或命令异常时，生成长图画卷
        strip_file = output_obj.with_suffix(".strip.jpg")
        frame_str_list = [str(p) for p in frames]
        strip_res = self.create_frame_strip(frame_str_list, strip_file)
        if strip_res.ok:
            return Result.success({
                "mode": "fallback_image_strip",
                "output_file": str(strip_file),
                "frames_count": len(frames),
                "notice": "系统未检测到可用 ffmpeg，已自动降级为关键帧画卷",
            })

        return Result.failure("视频合成失败且画卷降级未成功")

    def create_frame_strip(
        self,
        frame_paths: List[str],
        output_path: Path | str,
        max_frames: int = 6,
    ) -> Result:
        """抽取首、尾及均匀间隔帧，横向拼接为长图画卷"""
        if not frame_paths:
            return Result.failure("序列帧列表为空")

        from PIL import Image

        total = len(frame_paths)
        if total <= max_frames:
            sampled_indices = list(range(total))
        else:
            step = (total - 1) / (max_frames - 1)
            sampled_indices = [int(round(i * step)) for i in range(max_frames)]
            sampled_indices = sorted(list(set(sampled_indices)))

        images: List[Image.Image] = []
        try:
            for idx in sampled_indices:
                p = frame_paths[idx]
                if os.path.exists(p):
                    img = Image.open(p)
                    images.append(img.copy())
                    img.close()

            if not images:
                return Result.failure("未能成功加载任何有效帧图像")

            # 统一高度，按比例缩放后横向拼接
            base_height = images[0].height
            if base_height <= 0:
                return Result.failure("图像高度无效")
            resized_images = []
            total_width = 0
            for img in images:
                if img.height <= 0:
                    continue
                if img.height != base_height:
                    w_percent = base_height / float(img.height)
                    new_w = int(float(img.width) * w_percent)
                    r_img = img.resize((new_w, base_height), Image.Resampling.LANCZOS)
                else:
                    r_img = img
                resized_images.append(r_img)
                total_width += r_img.width

            strip = Image.new("RGB", (total_width, base_height), color=(240, 240, 240))
            current_x = 0
            for r_img in resized_images:
                strip.paste(r_img, (current_x, 0))
                current_x += r_img.width

            out_p = Path(output_path)
            out_p.parent.mkdir(parents=True, exist_ok=True)
            strip.save(out_p, "JPEG", quality=85)

            return Result.success({
                "strip_path": str(out_p),
                "sampled_frames": len(images),
                "width": total_width,
                "height": base_height,
            })
        except Exception as e:
            return Result.failure(f"生成画卷异常: {str(e)}")

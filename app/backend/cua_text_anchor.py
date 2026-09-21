# -*- coding: utf-8 -*-
"""cua_text_anchor.py - 本地 OCR 文本锚点解析与 DPI 自适应中心坐标计算

全部计算在本地完成，图像不上传至任何多模态服务。
无需将图像上传到多模态大模型，直接在本地 50ms 内根据 OCR 文本框检索中心坐标，
并完成多显示器 / Windows 缩放比例（100%, 125%, 150%, 200%）的 DPI 物理-逻辑坐标映射。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple, Union


def _normalize_box(box: Any) -> Optional[Dict[str, Any]]:
    """统一规范化 OCR 文本框结构。

    支持两种常见格式：
    1. 字典格式：{"text": str, "x": int, "y": int, "width": int, "height": int}
       或 {"text": str, "box": [x1, y1, x2, y2]}
    2. 列表格式：[x1, y1, x2, y2, text] 或 [[x1, y1, x2, y2], (text, score)]
    """
    if isinstance(box, dict):
        text = str(box.get("text") or box.get("content") or "").strip()
        if not text:
            return None
        if "x" in box and "y" in box and "width" in box and "height" in box:
            return {
                "text": text,
                "x": float(box["x"]),
                "y": float(box["y"]),
                "width": float(box["width"]),
                "height": float(box["height"]),
            }
        b = box.get("box") or box.get("bbox") or box.get("rect")
        if isinstance(b, (list, tuple)) and len(b) >= 4:
            if isinstance(b[0], (list, tuple)):
                xs = [float(pt[0]) for pt in b if isinstance(pt, (list, tuple)) and len(pt) >= 2]
                ys = [float(pt[1]) for pt in b if isinstance(pt, (list, tuple)) and len(pt) >= 2]
                if xs and ys:
                    min_x, max_x = min(xs), max(xs)
                    min_y, max_y = min(ys), max(ys)
                    return {
                        "text": text,
                        "x": min_x,
                        "y": min_y,
                        "width": max_x - min_x,
                        "height": max_y - min_y,
                    }
            else:
                x1, y1, x2, y2 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
                return {
                    "text": text,
                    "x": min(x1, x2),
                    "y": min(y1, y2),
                    "width": abs(x2 - x1),
                    "height": abs(y2 - y1),
                }

    if isinstance(box, (list, tuple)):
        # [x1, y1, x2, y2, text]
        if len(box) >= 5 and isinstance(box[4], str):
            x1, y1, x2, y2 = float(box[0]), float(box[1]), float(box[2]), float(box[3])
            return {
                "text": str(box[4]).strip(),
                "x": min(x1, x2),
                "y": min(y1, y2),
                "width": abs(x2 - x1),
                "height": abs(y2 - y1),
            }
        # [[x1, y1, x2, y2], (text, conf)]
        if len(box) >= 2 and isinstance(box[0], (list, tuple)) and len(box[0]) >= 4:
            coords = box[0]
            x1, y1, x2, y2 = float(coords[0]), float(coords[1]), float(coords[2]), float(coords[3])
            text = box[1][0] if isinstance(box[1], (list, tuple)) else str(box[1])
            return {
                "text": str(text).strip(),
                "x": min(x1, x2),
                "y": min(y1, y2),
                "width": abs(x2 - x1),
                "height": abs(y2 - y1),
            }

    return None


class TextAnchorResolver:
    """本地 OCR 文本目标解析器。"""

    @staticmethod
    def find_text_boxes(
        ocr_boxes: List[Any],
        query: str,
        exact: bool = False,
        case_sensitive: bool = False,
    ) -> List[Dict[str, Any]]:
        """在 OCR 候选框列表中检索所有匹配文本框，并计算中心点。"""
        if not query or not ocr_boxes:
            return []

        q = query if case_sensitive else query.lower().strip()
        matched = []

        for raw_box in ocr_boxes:
            norm = _normalize_box(raw_box)
            if not norm:
                continue

            candidate = norm["text"] if case_sensitive else norm["text"].lower()
            is_hit = (candidate == q) if exact else (q in candidate)

            if is_hit:
                cx = norm["x"] + (norm["width"] / 2.0)
                cy = norm["y"] + (norm["height"] / 2.0)
                item = dict(norm)
                item["center_x"] = cx
                item["center_y"] = cy
                matched.append(item)

        return matched

    @staticmethod
    def calculate_dpi_compensated_coords(
        x: float,
        y: float,
        scale_factor: float = 1.0,
        to_logical: bool = True,
    ) -> Tuple[int, int]:
        """进行 DPI 物理像素与逻辑坐标转换。

        当截图为物理像素（如 150% 缩放下的 2880x1800），而 SendInput 点击需要
        逻辑坐标（1920x1200）时，to_logical=True 将坐标除以 scale_factor。
        """
        factor = float(scale_factor or 1.0)
        if factor <= 0.01:
            factor = 1.0

        if to_logical:
            target_x = x / factor
            target_y = y / factor
        else:
            target_x = x * factor
            target_y = y * factor

        return int(round(target_x)), int(round(target_y))

    @classmethod
    def resolve_click_target(
        cls,
        ocr_boxes: List[Any],
        text: str,
        occurrence: int = 1,
        exact: bool = False,
        scale_factor: float = 1.0,
        to_logical: bool = True,
    ) -> Tuple[bool, Union[Tuple[int, int], str]]:
        """高层解析接口：查找第 N 个匹配的文本中心点并返回补偿后的坐标。

        Returns:
            (True, (target_x, target_y)) 成功
            (False, error_reason) 失败
        """
        matches = cls.find_text_boxes(ocr_boxes, text, exact=exact)
        if not matches:
            return (False, f"在当前屏幕 OCR 中未检测到文本 '{text}'")

        idx = occurrence - 1
        if idx < 0 or idx >= len(matches):
            return (
                False,
                f"检测到文本 '{text}' 共 {len(matches)} 处，指定的序号 occurrence={occurrence} 超出范围",
            )

        target_box = matches[idx]
        px, py = cls.calculate_dpi_compensated_coords(
            target_box["center_x"],
            target_box["center_y"],
            scale_factor=scale_factor,
            to_logical=to_logical,
        )
        return (True, (px, py))

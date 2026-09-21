"""image_extract.py — 从各家模型响应里挖出图片

# 为什么需要一个专门的模块

`llm_client` 现在只做一件事：`message.get("content") or ""`。这在纯文本时代没问题，
但多模态响应的 `content` 可能是一个**数组**，里面混着文字块和图片块。此时那行代码
会返回一个 list，下游所有当它是 str 的地方（拼接、截断、`len()`）行为都不可预测 ——
这是一个已经埋在代码里、只等接入多模态模型就会触发的 bug。

更麻烦的是每家的图片块长得都不一样。这里把差异全吃掉，对外只给两个结果：
干净的文字 + 统一形状的图片列表。

# 支持的响应形状（按实际遇到的顺序）

1. **OpenAI 兼容 · content 数组**
   ``content: [{"type":"text","text":"..."}, {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]``

2. **OpenRouter / 部分网关 · 顶层 images 字段**
   ``message: {"content":"...", "images":[{"type":"image_url","image_url":{"url":"data:..."}}]}``
   —— 图片和文字分开放，content 仍是字符串。

3. **Anthropic 风格块**（走兼容网关时会原样透出）
   ``{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}``

4. **Gemini 原生块**（部分网关不做转换，直接透传 Google 的形状）
   ``{"inlineData":{"mimeType":"image/png","data":"..."}}`` 或 snake_case ``inline_data``

5. **OpenAI Responses API · output_image**
   ``{"type":"output_image","image_url":"data:..."}`` / ``{"type":"output_image","result":"<base64>"}``

6. **Images API 直连**（gpt-image-1 / DALL·E，响应根上是 data 数组）
   ``{"data":[{"b64_json":"..."} 或 {"url":"https://..."}]}``

# 刻意不做的事

**不下载远程 URL。** DALL·E 的 `url` 形式给的是一个有时效的 Azure blob 链接。
我们把 URL 原样交给前端让浏览器直接加载 —— 后端代下载等于多一次网络往返、多一份
超时和失败处理，而且拿不到任何好处（前端反正要联网才能显示）。代价是链接过期后
图片会失效，这一点在返回结构里用 ``kind="url"`` 明确标出来，前端可以据此提示用户
"另存为"。
"""
from __future__ import annotations

from typing import Any, Iterable, Optional


def _as_dict(x: Any) -> dict:
    return x if isinstance(x, dict) else {}


def _push(out: list[dict], data: str = "", url: str = "", mime: str = "", name: str = "") -> None:
    """收敛成统一形状。空数据直接丢弃 —— 不给下游制造 None 判断负担。"""
    data = (data or "").strip()
    url = (url or "").strip()
    if not data and not url:
        return
    # data: URI 出现在 url 位置很常见，按数据处理而不是按远程链接处理。
    if url.startswith("data:"):
        data, url = url, ""
    out.append({
        "kind": "url" if url else "base64",
        "data": data,
        "url": url,
        "mime": (mime or "").strip().lower(),
        "name": (name or "").strip(),
    })


def _from_part(part: Any, out: list[dict]) -> bool:
    """尝试把单个 content 块解析成图片。返回是否命中。"""
    p = _as_dict(part)
    if not p:
        return False
    ptype = str(p.get("type") or "").lower()

    # 形状 1 / 2：OpenAI image_url
    if ptype in ("image_url", "input_image", "output_image"):
        iu = p.get("image_url")
        if isinstance(iu, str):
            _push(out, url=iu)
            return True
        iu = _as_dict(iu)
        if iu.get("url"):
            _push(out, url=str(iu["url"]))
            return True
        # Responses API 的 output_image 有时把 base64 放在 result / b64_json
        for key in ("result", "b64_json", "data"):
            if isinstance(p.get(key), str) and p[key]:
                _push(out, data=p[key], mime=str(p.get("mime_type") or p.get("mimeType") or ""))
                return True
        return False

    # 形状 3：Anthropic image block
    if ptype == "image":
        src = _as_dict(p.get("source"))
        if src.get("data"):
            _push(out, data=str(src["data"]), mime=str(src.get("media_type") or ""))
            return True
        if src.get("url"):
            _push(out, url=str(src["url"]))
            return True
        # 少数网关把 base64 直接挂在块上
        if isinstance(p.get("data"), str) and p["data"]:
            _push(out, data=p["data"], mime=str(p.get("mimeType") or p.get("mime_type") or ""))
            return True
        return False

    # 形状 4：Gemini inlineData（驼峰与下划线两种都见过）
    for key in ("inlineData", "inline_data"):
        inline = _as_dict(p.get(key))
        if inline.get("data"):
            _push(
                out,
                data=str(inline["data"]),
                mime=str(inline.get("mimeType") or inline.get("mime_type") or ""),
            )
            return True

    return False


def _walk_parts(parts: Iterable[Any], out: list[dict]) -> list[str]:
    """遍历 content 数组，抽图片、同时把文字块收集出来。"""
    texts: list[str] = []
    for part in parts or []:
        if isinstance(part, str):
            texts.append(part)
            continue
        if _from_part(part, out):
            continue
        p = _as_dict(part)
        # 文字块：{"type":"text","text":"..."} 或 Responses 的 output_text
        if isinstance(p.get("text"), str):
            texts.append(p["text"])
    return texts


def normalize_content(content: Any, out: list[dict]) -> str:
    """把 content（字符串或数组）压成纯文字，顺路把图片挖进 ``out``。

    这是修掉那个潜在 bug 的地方：数组进来，字符串出去，下游永远拿到 str。
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(t for t in _walk_parts(content, out) if t)
    return str(content)


def extract(message: dict, raw: Optional[dict] = None) -> tuple[str, list[dict]]:
    """从一条 assistant message（以及可选的完整响应体）里取出文字与图片。

    Args:
        message: ``choices[0].message``。
        raw: 完整响应体。用来兜住 Images API 那种图片挂在根 ``data`` 上的形状。

    Returns:
        ``(text, images)``。``images`` 每项为
        ``{"kind": "base64"|"url", "data", "url", "mime", "name"}``。
    """
    images: list[dict] = []
    msg = _as_dict(message)

    text = normalize_content(msg.get("content"), images)

    # 形状 2：图片单独挂在 message.images
    extra = msg.get("images")
    if isinstance(extra, list):
        _walk_parts(extra, images)

    # Responses API：message.output / message.content 之外还有 output 数组
    for container_key in ("output", "outputs"):
        container = msg.get(container_key)
        if isinstance(container, list):
            for item in container:
                inner = _as_dict(item).get("content")
                if isinstance(inner, list):
                    _walk_parts(inner, images)
                else:
                    _from_part(item, images)

    # 形状 6：Images API 直连 —— 图片在响应根上，不在 message 里
    root = _as_dict(raw)
    if isinstance(root.get("data"), list):
        for item in root["data"]:
            d = _as_dict(item)
            if d.get("b64_json"):
                _push(images, data=str(d["b64_json"]), mime="image/png",
                      name=str(d.get("revised_prompt") or "")[:80])
            elif d.get("url"):
                _push(images, url=str(d["url"]),
                      name=str(d.get("revised_prompt") or "")[:80])

    return text, images


def has_images(message: dict, raw: Optional[dict] = None) -> bool:
    """便捷判断，避免调用方为了判空而做完整解析。"""
    return bool(extract(message, raw)[1])

"""image_store.py — 生成图片的落盘、取回、清理

# 为什么必须落盘，不能塞进消息内容里

一张 1024×1024 PNG base64 之后约 1–2 MB，按 4 字符 ≈ 1 token 估算是 25–50 万 token。
`router._build_history()` 会把 `session_messages.content` 原样重放进下一轮上下文。
结果：只要有一张图片的 base64 进了 content 列，下一轮对话直接超限报错。

所以规矩是硬的：

  · **图片字节 → 磁盘**（本模块）
  · **`content` 列 → 只放短占位符**（约 10 token）
  · **`metadata` 列 → 只放轻量引用**（id / mime / bytes / name / prompt），_build_history 不读

# 为什么走 HTTP 而不是 data: URI

data: URI 看着省事，但每次会话恢复都要把整坨 base64 从 SQLite 读出来塞进 WS，
Zustand store 里挂着 base64 字符串，React re-render 一次搬一次内存，还没法"另存为"。
落盘 + `GET /api/images/{id}` 之后浏览器自己缓存，刷新页面不重传。

# 为什么远程 URL 也要下载下来

DALL·E / gpt-image-1 返回的 URL 是**约 1 小时后过期**的 Azure blob 链接。持久化的
聊天记录里放会过期的链接，用户明天翻记录图片全裂。所以 URL 也走同一条路 —— 下载
后落盘，得到和 base64 完全一致的引用形状。

# 为什么用 asyncio.to_thread 而不是直接同步写

后端是 aiohttp 单线程事件循环。同步 `write_bytes` 一张 20MB 的 PNG 会**阻塞整个
事件循环** —— 所有 WebSocket 消息在写盘期间全部堵着。写盘走 `asyncio.to_thread`
挤出 IO 到线程池，事件循环继续跑。

# 存哪

``<workspace>/.ovolve/images/{id}.{ext}``

放工作区而不是用户目录：AI 生成的图片通常跟当前项目相关（架构图、示意图），跟着
项目走比堆在 `~/.ovolve` 里更合理，也方便用户在文件管理器里找到。

id 就是文件名主干，不需要额外索引表 —— 少一份需要同步的状态。

# 一处刻意的取舍：尺寸探测

理想是落盘时读 PNG 头拿到 width/height，前端预留正确的占位框避免布局跳动（CLS）。
但每格式都要单独写 header parser 或者引入 Pillow（多 10MB 依赖）。当前实现**不做
尺寸探测**，只记录 `bytes`；前端占位框按方形（大部分 AI 生图是方形）+ 加载完时
淡出。改进项在 TODO_DEVELOPMENT。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import re
import uuid
from pathlib import Path
from typing import Optional


#: MIME → 扩展名。未知类型当 bin 存，不猜；load 走 glob 匹配任意扩展名。
_EXT_BY_MIME = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
}

_MIME_BY_EXT = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "svg": "image/svg+xml",
}

#: 单张图片上限 32MB —— 超过基本不是正常生成结果，拒绝落盘避免磁盘被打满。
MAX_IMAGE_BYTES = 32 * 1024 * 1024

#: 远程 URL 下载超时（秒）。DALL·E 图通常 <200KB，2–3 秒够。
DOWNLOAD_TIMEOUT = 15

#: 只接受这个字符集的 id，防止 ``../..`` 之类的路径穿越。
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

SUBDIR = Path(".ovolve") / "images"


def _dir_for(workspace: str) -> Path:
    return Path(workspace) / SUBDIR


def _ext_for_mime(mime: str) -> str:
    return _EXT_BY_MIME.get((mime or "").strip().lower(), "bin")


def mime_for_path(path: Path) -> str:
    """从文件名后缀反查 MIME，用于 HTTP 响应的 Content-Type。"""
    ext = path.suffix.lstrip(".").lower()
    return _MIME_BY_EXT.get(ext, "application/octet-stream")


def _strip_data_url(raw: str) -> tuple[str, Optional[str]]:
    """``data:image/png;base64,XXXX`` → ``("XXXX", "image/png")``。"""
    if not raw:
        return "", None
    s = raw.strip()
    if not s.startswith("data:"):
        return s, None
    head, _, payload = s.partition(",")
    mime = head[5:].split(";")[0] or None
    return payload, mime


def _new_id() -> str:
    """32 位 uuid hex。id 不可变、内容不可变，配合 Cache-Control immutable 可放心长缓存。"""
    return uuid.uuid4().hex


def _write_blob(path: Path, blob: bytes) -> None:
    """真正的写盘操作，跑在线程池里。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)


def _make_ref(image_id: str, path: Path, mime: str, size: int, name: str) -> dict:
    """统一的引用形状 —— 不带图片数据本身。"""
    return {
        "id": image_id,
        "mime": mime,
        "bytes": size,
        "ext": path.suffix.lstrip("."),
        "name": (name or f"image{path.suffix}")[:120],
        "path": str(path),
        "url": f"/api/images/{image_id}",
    }


async def save_bytes(
    blob: bytes,
    mime: str = "image/png",
    workspace: str = ".",
    name_hint: str = "",
) -> Optional[dict]:
    """把字节直接写进工作区。失败返回 None（绝不抛）。"""
    if not blob or len(blob) > MAX_IMAGE_BYTES:
        return None
    image_id = _new_id()
    ext = _ext_for_mime(mime)
    path = _dir_for(workspace) / f"{image_id}.{ext}"
    try:
        await asyncio.to_thread(_write_blob, path, blob)
    except OSError:
        return None
    return _make_ref(image_id, path, mime.strip().lower(), len(blob), name_hint)


async def save_base64(
    data: str,
    mime: str = "image/png",
    workspace: str = ".",
    name_hint: str = "",
) -> Optional[dict]:
    """把 base64 图片写进工作区。可接受带 ``data:`` 前缀的输入。"""
    payload, embedded_mime = _strip_data_url(data)
    if not payload:
        return None
    try:
        # validate must be passed as a keyword: b64decode's second POSITIONAL
        # arg is `altchars`, so to_thread(..., payload, True) silently means
        # "altchars=True" and blows up inside base64.
        blob = await asyncio.to_thread(base64.b64decode, payload, validate=True)
    except (binascii.Error, ValueError, TypeError):
        # 模型偶尔会返回被截断的 base64。丢掉这张图，不写坏文件让前端显示成碎图。
        return None
    return await save_bytes(
        blob,
        mime=(embedded_mime or mime or "image/png"),
        workspace=workspace,
        name_hint=name_hint,
    )


async def save_url(
    url: str,
    workspace: str = ".",
    name_hint: str = "",
) -> Optional[dict]:
    """下载远程 URL 图片并落盘。

    DALL·E / gpt-image-1 返回的 blob 链接约 1 小时后过期，必须自己拉下来存。失败
    返回 None —— 调用方决定是丢弃还是保留一个已知会失效的原始 URL 引用。
    """
    if not url or not url.startswith(("http://", "https://")):
        return None
    try:
        import aiohttp
    except ImportError:
        return None
    try:
        timeout = aiohttp.ClientTimeout(total=DOWNLOAD_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    return None
                # 优先信任 Content-Type，其次从 URL 尾端猜。
                mime = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if not mime.startswith("image/"):
                    ext = url.rsplit(".", 1)[-1].split("?")[0].lower()
                    mime = _MIME_BY_EXT.get(ext, "image/png")
                # aiohttp 的 read() 内部走异步，不阻塞。
                blob = await resp.read()
    except (asyncio.TimeoutError, aiohttp.ClientError, OSError):
        return None
    return await save_bytes(blob, mime=mime, workspace=workspace, name_hint=name_hint)


async def save_ref(item: dict, workspace: str, name_hint: str = "") -> Optional[dict]:
    """入口：接收 ``image_extract`` 吐出的引用，走 base64 或 url 分支。

    这一层让 router 只用调一次，无需关心图片来源。
    """
    if not isinstance(item, dict):
        return None
    kind = item.get("kind")
    mime = item.get("mime") or ""
    name = item.get("name") or name_hint
    if kind == "base64":
        return await save_base64(item.get("data") or "", mime=mime, workspace=workspace,
                                 name_hint=name)
    if kind == "url":
        return await save_url(item.get("url") or "", workspace=workspace, name_hint=name)
    return None


def resolve(image_id: str, workspace: str = ".") -> Optional[Path]:
    """按 id 找回文件路径。id 非法或文件不存在返回 None。

    id 走白名单正则 —— HTTP 路径参数是不可信输入，不校验就是路径穿越漏洞。
    resolve() 后二次确认真实路径仍在目标目录内。
    """
    if not image_id or not _SAFE_ID.match(image_id):
        return None
    target_dir = _dir_for(workspace)
    try:
        real_target = target_dir.resolve()
    except OSError:
        return None
    try:
        for p in target_dir.glob(f"{image_id}.*"):
            if p.is_file():
                real_p = p.resolve()
                # 确认真实路径的父目录就是我们指定的目录，防 symlink 逃逸。
                if real_p.parent == real_target:
                    return real_p
    except OSError:
        return None
    return None


async def delete(image_id: str, workspace: str = ".") -> bool:
    """按 id 删除图片。返回是否真的删掉了。"""
    path = resolve(image_id, workspace)
    if not path:
        return False
    try:
        await asyncio.to_thread(path.unlink)
        return True
    except OSError:
        return False


def placeholder(ref: dict) -> str:
    """给 ``session_messages.content`` 用的短占位符。

    模型在后续轮次需要知道"我上一轮生成过一张图"，否则用户说"把刚那张图改成蓝色"
    时它一脸茫然。但这句话必须极短 —— 它会被每一轮历史重放带上。
    """
    name = (ref or {}).get("name") or "image"
    return f"[图片: {name}]"

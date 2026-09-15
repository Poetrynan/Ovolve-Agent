"""Tests for image_store — disk persistence, path-traversal guard, cleanup.

The security-relevant part is `resolve()`: its input comes straight off an HTTP
path parameter, so an unvalidated id is a path-traversal hole. Those tests are
the ones that matter most here.
"""
import base64
import pytest

import image_store


TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8"
    "AAQTAGAFKcBQGkGvSuAAAAAElFTkSuQmCC"
)


# ── save_base64 ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_save_base64_writes_file_and_returns_ref(tmp_path):
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path), "cat.png")
    assert ref is not None
    assert ref["mime"] == "image/png"
    assert ref["ext"] == "png"
    assert ref["name"] == "cat.png"
    assert ref["bytes"] > 0
    assert ref["url"] == f"/api/images/{ref['id']}"
    # The file really exists on disk under the expected subdir.
    written = tmp_path / ".ovolve" / "images" / f"{ref['id']}.png"
    assert written.is_file()
    assert written.read_bytes() == base64.b64decode(TINY_PNG_B64)


@pytest.mark.asyncio
async def test_ref_never_contains_image_data(tmp_path):
    """The whole design rests on refs being lightweight. If the payload ever
    rides along in the ref, someone will put it in `content` and blow the window."""
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    assert "data" not in ref
    for value in ref.values():
        assert TINY_PNG_B64 not in str(value)


@pytest.mark.asyncio
async def test_save_base64_accepts_data_url_prefix(tmp_path):
    ref = await image_store.save_base64(
        f"data:image/webp;base64,{TINY_PNG_B64}", "image/png", str(tmp_path)
    )
    assert ref is not None
    # The mime embedded in the data URL wins over the declared one.
    assert ref["mime"] == "image/webp"
    assert ref["ext"] == "webp"


@pytest.mark.asyncio
async def test_save_base64_rejects_truncated_payload(tmp_path):
    """A cut-off base64 must be dropped, not written as a corrupt file that the
    frontend renders as a broken image."""
    assert await image_store.save_base64("!!!not base64!!!", "image/png", str(tmp_path)) is None


@pytest.mark.asyncio
async def test_save_base64_rejects_empty(tmp_path):
    assert await image_store.save_base64("", "image/png", str(tmp_path)) is None
    assert await image_store.save_base64("   ", "image/png", str(tmp_path)) is None


@pytest.mark.asyncio
async def test_save_bytes_rejects_oversized(tmp_path):
    too_big = b"x" * (image_store.MAX_IMAGE_BYTES + 1)
    assert await image_store.save_bytes(too_big, "image/png", str(tmp_path)) is None


@pytest.mark.asyncio
async def test_unknown_mime_falls_back_to_bin(tmp_path):
    ref = await image_store.save_bytes(b"\x00\x01", "application/x-weird", str(tmp_path))
    assert ref is not None
    assert ref["ext"] == "bin"


@pytest.mark.asyncio
async def test_each_save_gets_a_distinct_id(tmp_path):
    a = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    b = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    assert a["id"] != b["id"]


# ── resolve: the security-critical path ────────────────────────────────────

@pytest.mark.asyncio
async def test_resolve_finds_saved_file(tmp_path):
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    found = image_store.resolve(ref["id"], str(tmp_path))
    assert found is not None and found.is_file()


@pytest.mark.parametrize("evil", [
    "../../../../etc/passwd",
    "..\\..\\windows\\system32\\config\\sam",
    "abc/../../secret",
    "....//....//x",
    "a" * 200,          # over the length cap
    "short",            # under the length cap
    "has space",
    "semi;colon",
    "null\x00byte",
    "",
    None,
])
def test_resolve_rejects_hostile_ids(tmp_path, evil):
    """id comes off an HTTP path param — it is untrusted input."""
    assert image_store.resolve(evil, str(tmp_path)) is None


def test_resolve_returns_none_for_valid_but_missing_id(tmp_path):
    assert image_store.resolve("a" * 32, str(tmp_path)) is None


def test_resolve_does_not_create_directories(tmp_path):
    """The reference doc's version called mkdir() during lookup, which turned an
    unauthenticated GET into arbitrary directory creation. Lookup must be read-only."""
    target = tmp_path / "nowhere"
    image_store.resolve("a" * 32, str(target))
    assert not (target / ".ovolve").exists()


# ── delete ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_removes_file(tmp_path):
    ref = await image_store.save_base64(TINY_PNG_B64, "image/png", str(tmp_path))
    path = image_store.resolve(ref["id"], str(tmp_path))
    assert path.is_file()

    assert await image_store.delete(ref["id"], str(tmp_path)) is True
    assert not path.exists()
    assert image_store.resolve(ref["id"], str(tmp_path)) is None


@pytest.mark.asyncio
async def test_delete_missing_id_returns_false(tmp_path):
    assert await image_store.delete("b" * 32, str(tmp_path)) is False


@pytest.mark.asyncio
async def test_delete_rejects_hostile_id(tmp_path):
    assert await image_store.delete("../../etc/passwd", str(tmp_path)) is False


# ── save_ref dispatch ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_save_ref_handles_base64_kind(tmp_path):
    ref = await image_store.save_ref(
        {"kind": "base64", "data": TINY_PNG_B64, "mime": "image/png", "name": "x.png"},
        str(tmp_path),
    )
    assert ref is not None and ref["ext"] == "png"


@pytest.mark.asyncio
async def test_save_ref_rejects_unknown_kind(tmp_path):
    assert await image_store.save_ref({"kind": "telepathy"}, str(tmp_path)) is None
    assert await image_store.save_ref({}, str(tmp_path)) is None
    assert await image_store.save_ref(None, str(tmp_path)) is None


@pytest.mark.asyncio
async def test_save_url_rejects_non_http_schemes(tmp_path):
    """file:// would let a malicious response exfiltrate local files into the
    workspace image dir."""
    for bad in ["file:///etc/passwd", "ftp://x/y.png", "javascript:alert(1)", ""]:
        assert await image_store.save_url(bad, str(tmp_path)) is None


# ── placeholder: the LLM-facing hint ───────────────────────────────────────

def test_placeholder_is_short():
    """It rides along in EVERY history replay, so length is a real cost."""
    text = image_store.placeholder({"name": "generated_cat.png"})
    assert len(text) < 40
    assert "generated_cat.png" in text


def test_placeholder_survives_missing_name():
    assert image_store.placeholder({}) == "[图片: image]"
    assert image_store.placeholder(None) == "[图片: image]"


# ── mime_for_path: used for the HTTP Content-Type ──────────────────────────

@pytest.mark.parametrize("name,expected", [
    ("a.png", "image/png"),
    ("a.jpg", "image/jpeg"),
    ("a.jpeg", "image/jpeg"),
    ("a.webp", "image/webp"),
    ("a.gif", "image/gif"),
    ("a.svg", "image/svg+xml"),
    ("a.bin", "application/octet-stream"),
])
def test_mime_for_path(tmp_path, name, expected):
    assert image_store.mime_for_path(tmp_path / name) == expected

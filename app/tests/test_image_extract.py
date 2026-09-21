"""Fixture tests for image_extract — the module I trust least.

Every fixture below is a REAL response shape (or the closest public documentation
of one), not an invented one. The point of this file is to fail loudly when a
provider shape isn't actually handled, because `image_extract` was written from
knowledge of the APIs rather than from captured traffic.

Two invariants matter most:
- `text` is ALWAYS a str. A list leaking through breaks every downstream
  len()/slice/concat in router.py and llm_client.py.
- base64 payloads never silently vanish. A dropped image looks like "the model
  didn't generate one" to the user, which is unfalsifiable from the UI.
"""
import pytest

from image_extract import extract, has_images, normalize_content


TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8"
    "AAQTAGAFKcBQGkGvSuAAAAAElFTkSuQmCC"
)


# ── invariant: text is always a str ────────────────────────────────────────

def test_plain_string_content_passes_through():
    text, images = extract({"content": "hello"})
    assert text == "hello"
    assert images == []


def test_none_content_becomes_empty_string():
    text, images = extract({"content": None})
    assert text == ""
    assert images == []


def test_array_content_is_flattened_to_str():
    """The latent bug: old code returned the list itself for multi-modal."""
    text, _ = extract({"content": [
        {"type": "text", "text": "第一段"},
        {"type": "text", "text": "第二段"},
    ]})
    assert isinstance(text, str)
    assert "第一段" in text and "第二段" in text


def test_missing_content_key_is_safe():
    text, images = extract({})
    assert text == ""
    assert images == []


def test_extract_never_raises_on_garbage():
    for junk in [None, [], "", 0, {"content": 42}, {"content": [None, 1, "x"]}]:
        text, images = extract(junk if isinstance(junk, dict) else {"content": junk})
        assert isinstance(text, str)
        assert isinstance(images, list)


# ── shape 1: OpenAI-compatible content array ───────────────────────────────

def test_openai_content_array_with_image_url_data_uri():
    text, images = extract({"content": [
        {"type": "text", "text": "这是你要的图"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{TINY_PNG}"}},
    ]})
    assert text == "这是你要的图"
    assert len(images) == 1
    assert images[0]["kind"] == "base64"
    assert images[0]["data"].startswith("data:image/png") or TINY_PNG in images[0]["data"]


def test_openai_content_array_with_remote_url():
    _, images = extract({"content": [
        {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}},
    ]})
    assert len(images) == 1
    assert images[0]["kind"] == "url"
    assert images[0]["url"] == "https://example.com/a.png"


def test_image_url_as_bare_string():
    """Some gateways flatten image_url to a string instead of {url: ...}."""
    _, images = extract({"content": [
        {"type": "image_url", "image_url": "https://example.com/b.png"},
    ]})
    assert len(images) == 1
    assert images[0]["url"] == "https://example.com/b.png"


# ── shape 2: OpenRouter-style top-level images ─────────────────────────────

def test_openrouter_images_field_alongside_string_content():
    text, images = extract({
        "content": "画好了",
        "images": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{TINY_PNG}"}},
        ],
    })
    assert text == "画好了"
    assert len(images) == 1
    assert images[0]["kind"] == "base64"


# ── shape 3: Anthropic image block ─────────────────────────────────────────

def test_anthropic_image_block():
    _, images = extract({"content": [
        {"type": "image", "source": {
            "type": "base64", "media_type": "image/jpeg", "data": TINY_PNG,
        }},
    ]})
    assert len(images) == 1
    assert images[0]["mime"] == "image/jpeg"
    assert images[0]["data"] == TINY_PNG


# ── shape 4: Gemini inlineData (both casings) ──────────────────────────────

def test_gemini_inline_data_camel_case():
    _, images = extract({"content": [
        {"inlineData": {"mimeType": "image/png", "data": TINY_PNG}},
    ]})
    assert len(images) == 1
    assert images[0]["mime"] == "image/png"
    assert images[0]["data"] == TINY_PNG


def test_gemini_inline_data_snake_case():
    _, images = extract({"content": [
        {"inline_data": {"mime_type": "image/webp", "data": TINY_PNG}},
    ]})
    assert len(images) == 1
    assert images[0]["mime"] == "image/webp"


def test_gemini_mixed_text_and_image_parts():
    """The realistic Gemini shape: prose part + image part in one response."""
    text, images = extract({"content": [
        {"text": "这是一只猫："},
        {"inlineData": {"mimeType": "image/png", "data": TINY_PNG}},
    ]})
    assert "这是一只猫" in text
    assert len(images) == 1


# ── shape 5: Responses API output_image ────────────────────────────────────

def test_responses_api_output_image_with_result_base64():
    _, images = extract({"content": [
        {"type": "output_image", "result": TINY_PNG, "mime_type": "image/png"},
    ]})
    assert len(images) == 1
    assert images[0]["data"] == TINY_PNG


def test_responses_api_nested_output_array():
    _, images = extract({
        "content": "",
        "output": [
            {"content": [
                {"type": "output_image", "image_url": f"data:image/png;base64,{TINY_PNG}"},
            ]},
        ],
    })
    assert len(images) == 1


# ── shape 6: Images API root data array (DALL·E / gpt-image-1) ─────────────

def test_images_api_b64_json_on_root():
    _, images = extract({}, raw={"data": [{"b64_json": TINY_PNG}]})
    assert len(images) == 1
    assert images[0]["kind"] == "base64"
    assert images[0]["mime"] == "image/png"


def test_images_api_url_on_root_carries_revised_prompt_as_name():
    _, images = extract({}, raw={"data": [
        {"url": "https://oaidalleapi.blob.core.windows.net/x.png",
         "revised_prompt": "一只戴帽子的橘猫"},
    ]})
    assert len(images) == 1
    assert images[0]["kind"] == "url"
    assert "橘猫" in images[0]["name"]


def test_images_api_multiple_images():
    _, images = extract({}, raw={"data": [
        {"b64_json": TINY_PNG}, {"b64_json": TINY_PNG}, {"b64_json": TINY_PNG},
    ]})
    assert len(images) == 3


# ── data: URI placed in the url slot must be treated as data ───────────────

def test_data_uri_in_url_slot_is_classified_as_base64():
    """Providers put data: URIs in `url` constantly. Classifying it as a remote
    URL would make the frontend try to fetch a 2MB string as a URL."""
    _, images = extract({"content": [
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{TINY_PNG}"}},
    ]})
    assert images[0]["kind"] == "base64"
    assert images[0]["url"] == ""


# ── empty / degenerate image blocks are dropped, not passed as None ────────

def test_empty_image_blocks_are_dropped():
    _, images = extract({"content": [
        {"type": "image_url", "image_url": {}},
        {"type": "image", "source": {}},
        {"inlineData": {}},
    ]})
    assert images == []


def test_has_images_matches_extract():
    msg = {"content": [{"inlineData": {"mimeType": "image/png", "data": TINY_PNG}}]}
    assert has_images(msg) is True
    assert has_images({"content": "no pictures here"}) is False


# ── normalize_content is used directly by the streaming path ───────────────

def test_normalize_content_returns_str_for_every_input():
    sink: list[dict] = []
    assert normalize_content("x", sink) == "x"
    assert normalize_content(None, sink) == ""
    assert isinstance(normalize_content([{"text": "a"}, {"text": "b"}], sink), str)
    assert isinstance(normalize_content(123, sink), str)


def test_normalize_content_collects_images_into_sink():
    sink: list[dict] = []
    normalize_content([{"inlineData": {"mimeType": "image/png", "data": TINY_PNG}}], sink)
    assert len(sink) == 1

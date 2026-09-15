"""Single source of truth for backend token estimation.

Before this module there were four independent char-ratio estimators in the
backend, and they disagreed with each other:

    context_compactor.estimate_tokens   CJK / 1.8  + rest / 4   (0.56 tok/CJK char)
    memory_tiers.estimate_tokens        CJK * 1.0  + rest / 4   (1.00 tok/CJK char)
    memory_retrieval._token_len         a hand-copied clone of the above
    llm_client.estimate_request_tokens  utf-8 bytes / 3.5

They also disagreed on *what counts as CJK*: the compactor saw only
``\\u4e00-\\u9fff``, memory_tiers additionally counted kana, and the frontend
fallback used a third range. So Japanese text was divided by 4 in one place and
counted 1:1 in another, and the same conversation produced numbers up to 1.8x
apart depending on which subsystem asked. That is not a rounding difference —
it decides whether context folding fires.

The canonical choice here is the **pessimistic** one, 1 token per wide
character, for the reason ``context_compactor.estimate_tokens_multi`` already
documents: the two failure modes are asymmetric. Under-estimating skips a fold
and the next request dies with a context-length error the user has to drive
around; over-estimating folds one turn early and costs a summarization nobody
notices. Note also that 1.0 tok/wide-char is close to what the byte heuristic
(3 utf-8 bytes / 3.5 = 0.857) was already producing, and since
``estimate_tokens_multi`` takes the maximum of its signals, the byte estimate
was silently overruling the compactor's 0.56 anyway. Making it explicit changes
the number the compactor reports on its own, not the fold decision it was
already making.

None of this is a tokenizer. Real BPE lives on the frontend
(``app/ui/src/lib/tokens.ts``, gpt-tokenizer) where the model id is known and a
50 MB vocabulary is already in the bundle. The backend needs a cheap, stable,
dependency-free number that never *under*-counts; that is what this is. The
authoritative count remains the provider's own ``usage`` block, which
``token_analytics`` and ``estimate_tokens_multi`` prefer whenever it exists.
"""
from __future__ import annotations

import json
import re

# Rust acceleration (ovolve_core.context_compactor mirrors this module's
# algorithms exactly — same wide-char ranges, same ceil division, same
# byte signal). Probed directly to avoid an import cycle through
# rust_adapters, whose context_compactor delegates back to this module.
try:
    from ovolve_core.context_compactor import (
        estimate_tokens as _rust_estimate_tokens,
        wide_chars as _rust_wide_chars,
        estimate_bytes as _rust_estimate_bytes,
    )
except Exception:  # ImportError or a broken/proxy module shape
    _rust_estimate_tokens = _rust_wide_chars = _rust_estimate_bytes = None

#: Characters that occupy one token each. Deliberately broader than any of the
#: ranges it replaces, because every range that was *missing* from a subsystem
#: caused that subsystem to under-count:
#:   3000-303f  CJK punctuation (、。「」etc.)
#:   3040-30ff  hiragana + katakana
#:   3400-4dbf  CJK Unified Ext-A
#:   4e00-9fff  CJK Unified (the common Chinese block)
#:   ac00-d7af  Hangul syllables
#:   f900-faff  CJK compatibility ideographs
#:   ff00-ffef  fullwidth / halfwidth forms
_WIDE_RE = re.compile(
    r"[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff"
    r"\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]"
)

#: Non-wide characters per token. Matches the long-standing ~4 chars/token rule
#: of thumb for English prose and code under cl100k/o200k.
CHARS_PER_TOKEN = 4

#: utf-8 bytes per token, used by the byte-length signal. 3.5 is conservative
#: for multilingual text and is what the rate limiter has always reserved with.
BYTES_PER_TOKEN = 3.5

# Image cost is not defined here on purpose. It lives in
# ``context_refs.IMAGE_TOKEN_ESTIMATE`` next to the ref machinery that owns
# image handling; duplicating the constant here would be the exact kind of
# fork this module exists to kill.


def wide_chars(text: str) -> int:
    """How many characters in ``text`` are counted 1 token each."""
    if not text:
        return 0
    if _rust_wide_chars is not None:
        return _rust_wide_chars(text)
    return len(_WIDE_RE.findall(text))


def estimate_tokens(text: str) -> int:
    """Estimate the token cost of ``text``.

    Ceiling division on the tail, so any non-empty string costs at least 1 —
    a zero estimate reads as "free", and nothing is free.
    """
    if not text:
        return 0
    if _rust_estimate_tokens is not None:
        return _rust_estimate_tokens(text)
    wide = wide_chars(text)
    rest = len(text) - wide
    return wide + (rest + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


def estimate_bytes(text: str) -> int:
    """The byte-length signal: utf-8 length / :data:`BYTES_PER_TOKEN`.

    Kept alongside the char estimate rather than folded into it because they
    fail in opposite directions, and callers that care (the compactor) take the
    max of both instead of trusting either.
    """
    if not text:
        return 0
    if _rust_estimate_bytes is not None:
        return _rust_estimate_bytes(text)
    return int(len(text.encode("utf-8")) / BYTES_PER_TOKEN)


def estimate_tokens_of(value) -> int:
    """Estimate any value: strings directly, everything else via compact JSON.

    Tool-call arguments and JSON schemas arrive as dicts, and stringifying them
    the same way every caller does is half the point of centralising this.
    """
    if value is None:
        return 0
    if isinstance(value, str):
        return estimate_tokens(value)
    try:
        return estimate_tokens(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    except (TypeError, ValueError):
        return estimate_tokens(str(value))

"""Attribution facts read from a capability's own files.

A skill or plugin usually states its licence in its own metadata. When it does
not, the copyright line in a bundled LICENSE or NOTICE file is the next best
evidence, and it has the useful property of travelling with the artifact: it
cannot fall out of date the way a hand-maintained table can.

This module only reports what a file actually says. It never guesses a holder
and never fills in a licence that is not evidenced somewhere on disk.
"""

import os
import re

__all__ = [
    "read_license_file",
    "sniff_copyright",
    "infer_license",
    "attribution_from",
]

#: Files that conventionally carry licence or copyright terms, most specific
#: first so a real LICENSE wins over a NOTICE that merely summarises.
_LICENSE_FILES = (
    "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE.rst",
    "LICENCE", "LICENCE.md", "LICENCE.txt",
    "COPYING", "COPYING.md", "COPYING.txt",
    "NOTICE", "NOTICE.md", "NOTICE.txt",
)

#: Ordered: the first match wins. Apache is checked before MIT because an
#: Apache text also contains permissive wording.
_LICENSE_HINTS = (
    ("Apache-2.0", ("apache license", "licensed under the apache")),
    ("GPL-3.0", ("gnu general public license",)),
    ("MPL-2.0", ("mozilla public license",)),
    ("BSD-3-Clause", ("redistribution and use in source and binary forms",)),
    ("ISC", ("permission to use, copy, modify, and/or distribute",)),
    ("MIT", ("permission is hereby granted, free of charge", "mit license")),
)

_COPYRIGHT_RE = re.compile(
    r"copyright\s*(?:\(c\)|©)?\s*"
    r"(?:\d{4}\s*(?:[-–,]\s*\d{4}\s*)?)?"
    r"(?P<holder>[^\r\n]{2,120})",
    re.IGNORECASE,
)

#: Trailing punctuation and connective words that trail a real holder name.
_TRAILING = re.compile(r"[\s.,;:]+$|(?:\s+(?:and|&|\.)\s*)+$", re.IGNORECASE)


def read_license_file(directory: str) -> str:
    """Return the text of the first licence-like file in ``directory``.

    Returns an empty string when there is no such file, so callers can treat a
    missing file and an unreadable one the same way.
    """
    if not directory or not os.path.isdir(directory):
        return ""
    for name in _LICENSE_FILES:
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fp:
                    return fp.read(200_000)
            except OSError:
                continue
    return ""


def sniff_copyright(text: str) -> str:
    """Extract the first copyright holder named in ``text``.

    Only the holder is returned, not the year: the year belongs to the release
    that carried it and goes stale, while the holder does not.
    """
    if not text:
        return ""
    for match in _COPYRIGHT_RE.finditer(text):
        holder = (match.group("holder") or "").strip()
        holder = _TRAILING.sub("", holder).strip()
        # "All rights reserved" and similar boilerplate is not a holder.
        if not holder or len(holder) < 3:
            continue
        if holder.lower().startswith("all rights"):
            continue
        # 只按**精确匹配**跳过样板词。用 startswith 会误伤——"Notice Only Ltd"
        # 这种把样板词当公司名的合法版权人会被整条略掉（真踩过）。
        if holder.lower() in {"reserved", "notice", "copyright", "license"}:
            continue
        return holder
    return ""


def infer_license(text: str) -> str:
    """Name the licence whose wording appears in ``text``, else ``""``.

    Returns an empty string rather than a guess when the wording is absent, so
    an unknown licence reads as unknown instead of as MIT.
    """
    if not text:
        return ""
    head = text[:4000].lower()
    for name, needles in _LICENSE_HINTS:
        for needle in needles:
            if needle in head:
                return name
    return ""


def attribution_from(directory: str, declared_license: str = "",
                     declared_author: str = "", declared_upstream: str = "") -> dict:
    """Resolve attribution for one capability directory.

    Declared metadata wins; a licence file on disk is only consulted for the
    fields the metadata left empty. Nothing is invented: a field with no
    evidence stays empty.
    """
    declared_license = str(declared_license or "").strip()
    declared_author = str(declared_author or "").strip()
    declared_upstream = str(declared_upstream or "").strip()

    text = read_license_file(directory)
    return {
        "license": declared_license or infer_license(text),
        "author": declared_author or sniff_copyright(text),
        "copyright": sniff_copyright(text) if text else "",
        "upstream": declared_upstream,
        #: Whether the licence came from the artifact itself rather than from
        #: declared metadata, so a reader can tell how confident it is.
        "licenseFromFile": bool(text) and not declared_license,
    }

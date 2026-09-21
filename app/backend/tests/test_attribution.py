"""Attribution resolution for installed skills and plugins.

A capability that states its own licence should be taken at its word; one that
does not should still be attributable from the licence file it ships. What this
must never do is invent a holder or a licence, because a wrong attribution is
worse than a blank one — it looks authoritative and is not.
"""
import os
import sys
import tempfile

import pytest

here = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.abspath(os.path.join(here, ".."))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from attribution import attribution_from, infer_license, sniff_copyright

_MIT = (
    "MIT License\n\n"
    "Copyright (c) 2024 Acme Robotics\n\n"
    "Permission is hereby granted, free of charge, to any person obtaining a copy "
    "of this software and associated documentation files (the \"Software\"), to deal "
    "in the Software without restriction...\n"
)

_APACHE = (
    "                                 Apache License\n"
    "                           Version 2.0, January 2004\n"
    "Copyright 2024 Example Corp\n"
    "Licensed under the Apache License, Version 2.0 (the \"License\");\n"
)


def _dir_with(text: str, name: str = "LICENSE") -> str:
    d = tempfile.mkdtemp(prefix="ovolve-attr-")
    with open(os.path.join(d, name), "w", encoding="utf-8") as fp:
        fp.write(text)
    return d


def test_license_and_holder_are_read_from_the_licence_file():
    d = _dir_with(_MIT)
    a = attribution_from(d)
    assert a["license"] == "MIT"
    assert a["copyright"] == "Acme Robotics"
    assert a["licenseFromFile"] is True


def test_declared_metadata_wins_over_the_file():
    d = _dir_with(_MIT)
    a = attribution_from(d, declared_license="Apache-2.0", declared_author="Jane Doe")
    assert a["license"] == "Apache-2.0"
    assert a["author"] == "Jane Doe"
    # 仍来自声明时不能标成"从文件推断的"。
    assert a["licenseFromFile"] is False


def test_holder_falls_back_to_copyright_when_author_is_absent():
    d = _dir_with(_MIT)
    a = attribution_from(d)
    # 没有声明作者时，文件里的版权人是唯一证据。
    assert a["author"] == "Acme Robotics"


def test_nothing_is_invented_when_there_is_no_evidence():
    empty = tempfile.mkdtemp(prefix="ovolve-attr-")
    a = attribution_from(empty)
    assert a["license"] == ""
    assert a["author"] == ""
    assert a["copyright"] == ""
    assert a["licenseFromFile"] is False


def test_apache_is_not_misread_as_mit():
    """Apache text also contains permissive wording; it must not match MIT."""
    assert infer_license(_APACHE) == "Apache-2.0"
    assert sniff_copyright(_APACHE) == "Example Corp"


def test_license_without_a_copyright_line_still_names_the_licence():
    """A missing holder must not suppress a licence that is evidenced."""
    d = _dir_with("MIT License\n\nPermission is hereby granted, free of charge...")
    a = attribution_from(d)
    assert a["license"] == "MIT"
    assert a["copyright"] == ""


def test_notice_file_is_used_when_no_license_file_exists():
    d = _dir_with("Copyright (c) 2023 Notice Only Ltd\n", name="NOTICE")
    a = attribution_from(d)
    assert a["copyright"] == "Notice Only Ltd"


def test_skill_import_resolves_attribution_and_exports_it():
    """A skill shipping a licence file must be attributable without metadata."""
    from skill_loader import SkillLoader, TrustLevel

    d = tempfile.mkdtemp(prefix="ovolve-attr-skill-")
    with open(os.path.join(d, "LICENSE"), "w", encoding="utf-8") as fp:
        fp.write(_MIT)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as fp:
        fp.write("---\nname: attr-skill\ndescription: used when checking attribution\n---\n\nBody.\n")

    loader = SkillLoader()
    res = loader.import_skill(d, TrustLevel.VERIFIED)
    assert res.ok, res.error

    detail = loader.get_skill_detail("attr-skill")
    assert detail.ok
    value = detail.value
    assert value["license"] == "MIT"
    assert value["copyright"] == "Acme Robotics"
    assert value["licenseFromFile"] is True


def test_plugin_import_resolves_attribution_and_exports_it():
    """A plugin's manifest and licence file both feed its public payload."""
    from plugin_registry import get_plugin_registry

    d = tempfile.mkdtemp(prefix="ovolve-attr-plugin-")
    with open(os.path.join(d, "LICENSE"), "w", encoding="utf-8") as fp:
        fp.write(_MIT)
    with open(os.path.join(d, "plugin.json"), "w", encoding="utf-8") as fp:
        fp.write('{"name": "attr-plugin", "version": "1.0.0", '
                 '"description": "checks attribution", "homepage": "https://example.invalid"}')

    reg = get_plugin_registry()
    res = reg.import_plugin(d, activate=False)
    assert res.ok, res.error
    public = res.value
    assert public["license"] == "MIT"
    assert public["copyright"] == "Acme Robotics"
    # homepage 没有单独的 upstream 声明时，它就是上游线索。
    assert public["upstream"] == "https://example.invalid"

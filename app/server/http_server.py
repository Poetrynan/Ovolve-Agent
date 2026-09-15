"""
Shim — forward to the full HTTP server in ``app/backend/server/http_server.py``.

``app/server`` is a real Python package (has ``__init__.py``) while
``app/backend/server`` is only a directory, so ``import server.http_server``
from ``main.py`` always resolved here. The stub copy was missing most routes
(``/api/goals``, ``/api/approvals/pending``, git, settings, …) and caused
widespread HTTP 404s in the UI.
"""
from __future__ import annotations

import importlib.util
import os

_BACKEND_HTTP = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "backend",
    "server",
    "http_server.py",
)

_spec = importlib.util.spec_from_file_location("ovolve_backend_http_server", _BACKEND_HTTP)
_module = importlib.util.module_from_spec(_spec)
assert _spec is not None and _spec.loader is not None
_spec.loader.exec_module(_module)

run_server = _module.run_server


def __getattr__(name: str):
    return getattr(_module, name)


def __dir__():
    return sorted(set(globals()) | set(dir(_module)))

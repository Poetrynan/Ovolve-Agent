"""Make the backend package importable from this test tree.

``app/tests`` ships an ``__init__.py``, so pytest inserts ``app/`` (the first
directory *without* one) onto ``sys.path`` — never ``app/backend``. Every module
these tests exercise lives in ``app/backend``, so without this shim they all die
at import with ``ModuleNotFoundError: No module named 'storage'``.

``app/backend/pytest.ini`` already sets ``pythonpath = .``, but that only applies
when pytest's rootdir resolves to ``app/backend`` (i.e. when running
``app/backend/tests``). Running this tree directly does not, so the shim has to
live here.

Put the backend *ahead* of ``app/`` so a same-named module resolves to the
backend copy rather than an unrelated one further up the tree.
"""

import sys
from pathlib import Path

_BACKEND = str(Path(__file__).resolve().parents[1] / "backend")
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

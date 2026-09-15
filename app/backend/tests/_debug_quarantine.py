import sys
sys.path.insert(0, '.')
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

from subagent_runtime import _quarantine

# Create temp dir with file
tmp = Path(tempfile.mkdtemp(prefix="ovolve-test-"))
src_dir = tmp / "src"
src_dir.mkdir()
(src_dir / "router.py").write_text("def hello():\n    return 'fixed'\n")

wc = MagicMock()
wc.id = "test-wc-001"
wc.label = "test-coder"
wc.source_root = str(tmp)
wc.root = str(tmp)
wc.changes.return_value = [
    {"rel": "src/router.py", "kind": "write", "bytes": 30},
]

print("wc.root:", wc.root)
print("changes:", wc.changes())
print("file exists:", (Path(wc.root) / "src/router.py").exists())

try:
    path = _quarantine(wc, reason="test_discard")
    print("quarantine path:", path)
except Exception as e:
    print("Exception:", e)
    import traceback
    traceback.print_exc()

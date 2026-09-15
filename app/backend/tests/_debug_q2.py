import sys
sys.path.insert(0, '.')
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

# Import directly from the module
import importlib.util
spec = importlib.util.spec_from_file_location("subagent_runtime", "subagent_runtime.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

_quarantine = mod._quarantine

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

path = _quarantine(wc, reason="test_discard")
print("quarantine path:", path)

if path:
    print("content:")
    print(Path(path).read_text())

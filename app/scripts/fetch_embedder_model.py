#!/usr/bin/env python3
"""Download Xenova/bge-base-zh-v1.5 ONNX into app/resources/embedder for offline packaging.

Usage:
  python app/scripts/fetch_embedder_model.py

After this succeeds, `npm run dist` / electron-builder will pack the folder via
extraResources so end users do not need a second model download.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "resources" / "embedder"
HF_REPO = "Xenova/bge-base-zh-v1.5"


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub is required: pip install huggingface_hub", file=sys.stderr)
        return 1

    print(f"Downloading {HF_REPO} -> {DEST}")
    snapshot_download(
        repo_id=HF_REPO,
        local_dir=str(DEST),
    )
    onnx = DEST / "onnx" / "model.onnx"
    if not onnx.is_file():
        print(f"ERROR: expected {onnx} after download", file=sys.stderr)
        return 2
    size_mb = onnx.stat().st_size / (1024 * 1024)
    print(f"OK: {onnx} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

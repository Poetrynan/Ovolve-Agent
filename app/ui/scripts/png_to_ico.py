"""Pack a PNG into one or more Windows .ico files (multi-size)."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: png_to_ico.py <source.png> <dest.ico> [dest2.ico ...]", file=sys.stderr)
        return 1
    src = Path(sys.argv[1])
    img = Image.open(src).convert("RGBA")
    for dest in sys.argv[2:]:
        img.save(dest, sizes=SIZES)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

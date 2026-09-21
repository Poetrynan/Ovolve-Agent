#!/usr/bin/env python3
"""
build_rust.py - Build the Ovolve Core Rust extension for Python.

Usage:
    python build_rust.py          # Build in release mode
    python build_rust.py --debug  # Build in debug mode
    python build_rust.py --test   # Run Rust tests
"""
import subprocess
import sys
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).parent
RUST_DIR = ROOT / "rust_core"
# PyO3 maturin builds to a wheel; we use develop mode for local dev
ADAPTER_DIR = ROOT / "rust_adapters"


def check_prerequisites():
    """Check that required tools are available."""
    # Check Rust toolchain
    try:
        result = subprocess.run(
            ["rustc", "--version"], capture_output=True, text=True
        )
        print(f"  Rust: {result.stdout.strip()}")
    except FileNotFoundError:
        print("  Rust: NOT FOUND - install from https://rustup.rs")
        return False
    
    # Check maturin
    try:
        result = subprocess.run(
            ["maturin", "--version"], capture_output=True, text=True
        )
        print(f"  Maturin: {result.stdout.strip()}")
    except FileNotFoundError:
        print("  Maturin: NOT FOUND - install with: pip install maturin")
        return False
    
    return True


def build(debug=False):
    """Build the Rust extension using maturin."""
    print("\n=== Building Ovolve Core Rust Extension ===")
    
    if not check_prerequisites():
        print("\nPrerequisites not met. Install Rust and maturin first.")
        return False
    
    cmd = ["maturin", "develop"]
    if not debug:
        cmd.append("--release")
    
    print(f"\nRunning: {' '.join(cmd)}")
    print(f"Directory: {RUST_DIR}")
    
    result = subprocess.run(cmd, cwd=str(RUST_DIR))
    
    if result.returncode == 0:
        print("\n=== Build successful! ===")
        print("\nTo use the Rust backend:")
        print("  import ovolve_core")
        print("  from rust_adapters.embedder import LocalEmbedder")
        return True
    else:
        print("\n=== Build failed ===")
        return False


def run_tests():
    """Run Rust unit tests."""
    print("\n=== Running Rust Tests ===")
    result = subprocess.run(
        ["cargo", "test", "--release"],
        cwd=str(RUST_DIR)
    )
    return result.returncode == 0


def main():
    debug = "--debug" in sys.argv
    test_only = "--test" in sys.argv
    
    if test_only:
        success = run_tests()
    else:
        success = build(debug)
        if success and "--with-tests" in sys.argv:
            run_tests()
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()

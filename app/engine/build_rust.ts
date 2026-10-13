/**
 * build_rust.ts — Build the Ovolve Core Rust extension for Python.
 *
 * Ported from `app/backend/build_rust.py` (100 lines).
 *
 * Usage:
 *     node build_rust.js          # Build in release mode
 *     node build_rust.js --debug  # Build in debug mode
 *     node build_rust.js --test   # Run Rust tests
 *
 * RULEBOOK CITATIONS
 *   §1  node:child_process (spawnSync) / node:path。
 *   §2  源是 Python 构建脚本（maturin develop → .whl）。TS 引擎侧对应的
 *       产物是 cdylib 静态库/PHPUnit？——不：本文件忠实保留源的 maturin
 *       构建语义（rust_core 的 PyO3 wheel 仍是 Python 宿主侧的合法消费
 *       形态），仅把脚本宿主从 python 换成 node。maturin/cargo 调用形状
 *       与打印文本逐字保留。
 *   §4  naming: build_rust.py → build_rust.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";

// Path(__file__).parent → 引擎目录（.ts 源与 .py 源同目录语义）
// ESM 无 __dirname：编译产物（CommonJS）有；ESM 下退回 cwd。
declare const __dirname: string | undefined;
const ROOT = typeof __dirname === "string" ? __dirname : process.cwd();
const RUST_DIR = path.join(ROOT, "rust_core");

/** Check that required tools are available. */
export function check_prerequisites(): boolean {
  // Check Rust toolchain
  try {
    const result = spawnSync("rustc", ["--version"], { encoding: "utf-8" });
    if (result.error) {
      throw result.error;
    }
    console.log(`  Rust: ${(result.stdout ?? "").trim()}`);
  } catch {
    console.log("  Rust: NOT FOUND - install from https://rustup.rs");
    return false;
  }

  // Check maturin
  try {
    const result = spawnSync("maturin", ["--version"], { encoding: "utf-8" });
    if (result.error) {
      throw result.error;
    }
    console.log(`  Maturin: ${(result.stdout ?? "").trim()}`);
  } catch {
    console.log("  Maturin: NOT FOUND - install with: pip install maturin");
    return false;
  }

  return true;
}

/** Build the Rust extension using maturin. */
export function build(debug = false): boolean {
  console.log("\n=== Building Ovolve Core Rust Extension ===");

  if (!check_prerequisites()) {
    console.log("\nPrerequisites not met. Install Rust and maturin first.");
    return false;
  }

  const cmd = ["maturin", "develop"];
  if (!debug) {
    cmd.push("--release");
  }

  console.log(`\nRunning: ${cmd.join(" ")}`);
  console.log(`Directory: ${RUST_DIR}`);

  const result = spawnSync(cmd[0]!, cmd.slice(1), { cwd: RUST_DIR, stdio: "inherit" });

  if (result.status === 0) {
    console.log("\n=== Build successful! ===");
    console.log("\nTo use the Rust backend:");
    console.log("  import ovolve_core");
    console.log("  from rust_adapters.embedder import LocalEmbedder");
    return true;
  } else {
    console.log("\n=== Build failed ===");
    return false;
  }
}

/** Run Rust unit tests. */
export function run_tests(): boolean {
  console.log("\n=== Running Rust Tests ===");
  const result = spawnSync("cargo", ["test", "--release"], { cwd: RUST_DIR, stdio: "inherit" });
  return result.status === 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const debug = argv.includes("--debug");
  const test_only = argv.includes("--test");

  let success: boolean;
  if (test_only) {
    success = run_tests();
  } else {
    success = build(debug);
    if (success && argv.includes("--with-tests")) {
      run_tests();
    }
  }

  return success ? 0 : 1;
}

if (
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("build_rust.js")
) {
  process.exit(main());
}

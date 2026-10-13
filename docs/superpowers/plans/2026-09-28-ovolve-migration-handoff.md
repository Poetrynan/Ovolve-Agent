# Ovolve Agent Migration (HANDOFF_V11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the full takeover of the Ovolve Agent backend migration according to HANDOFF_V11.md, driving the project from 23 strictly verified units to 221 (100%), completing all remaining Native/Rust implementations (A1 `activity_exec`, A4 `bare_modifier_guard`, A2 `work_copy` merge path, A3 `rust_adapters`), finishing Unit 218 `http_server.py` (S7–S10 + assembly + unified gate), and executing strict 4-check archive backfill across all 193 modules with 0 TODO(port) and complete gate reproducibility.

**Architecture:** Bug-for-bug equivalent porting from CPython 3.13 backend (`app/backend/`) to TypeScript (`app/engine/`) and PyO3 Rust extensions (`app/backend/rust_core/src/`). All I/O, persistence, subprocesses, and external dependencies are encapsulated behind test seams (`_SEAMS`) and fake virtual environments. Dual-side parity probes (`probe_py` vs `probe_ts` / `probe_rs`) record immutable execution ledgers, verified with zero tolerance (`FAILURES=0`). Every module is validated by >=40 single-point mutant negative control tests (>=20 per side, 100% caught, 0 bad, byte-restored) before final stamping into `verified/*.json` via `lead_stamp_writer.mjs`.

**Tech Stack:** TypeScript 5.x (`tsc --noEmit`), Node.js (ESM), Rust 2021 + PyO3 0.22, Python 3.13 (-X utf8), Maturin, PowerShell.

**Spec:** `D:\ovolve-migration\HANDOFF_V11.md`

## Global Constraints

- Absolute Red Line 5: 100% Non-invasive probes. Never touch `~/.ovolve/db/*.db` (must verify byte-exact `DB_UNCHANGED=true` before and after every probe).
- Absolute Red Line 3: Never execute `git commit` or `git push` in `D:\Ovolve Agent`.
- Absolute Source Immutability: `app/backend/**` (outside `rust_core/**`) is strictly read-only. Every gate verifies source file SHA-256 is unchanged.
- Zero `TODO(port)`: Every TS/Rust port must end with `// PORT STATUS: 本文件无 TODO(port)。` and contain 0 unhandled `TODO(port)` markers. Any language divergence must be documented as `DIVERGENCE(port):`.
- Strict 4-Check Verification: A unit is ONLY done when:
  1. `tmp/<safeStem>_full_gate.log` ends with `FULL_GATE=PASSED` (<=24h fresh).
  2. `tmp/<safeStem>_neg_summary.log` has `MUTANTS>=40` (>=20 per side), `CAUGHT==MUTANTS`, `BAD=0`, `RESTORED=true`.
  3. Source and target hashes match disk bytes right now.
  4. Stamped into `verified/<stem>.json` via `node tmp/lead_stamp_writer.mjs <source.py>`.
- Max concurrency <= 3 active agents or background detached chains.
- Deletions must move to `tmp/quarantine/`, never raw `rm`.
- Long builds/chains (>30s) must run detached with log redirection, polled from disk; never block shared shells synchronously.
- Single Source Mirror Policy for HTTP Server: All CPython emulation helpers must be imported from `app/engine/server/http_server_keys.ts` §M, 0 duplicate implementations allowed.

---

### Task 1: Complete and Gate Native Unit A1 (`activity_exec.py` -> Rust `rust_core/src/activity_exec/mod.rs`)

**Files:**
- Modify: `D:/Ovolve Agent/app/backend/rust_core/src/activity_exec/mod.rs`
- Modify: `D:/ovolve-migration/tmp/a1_cases.json`
- Modify: `D:/ovolve-migration/tmp/a1b_mutants.mjs`
- Test: `D:/ovolve-migration/tmp/a1b_full_gate.mjs`
- Output: `D:/ovolve-migration/tmp/activity_exec_full_gate.log`, `D:/ovolve-migration/tmp/activity_exec_neg_summary.log`
- Stamp: `D:/ovolve-migration/verified/activity_exec.json`

**Interfaces:**
- Consumes: Python source `app/backend/activity_exec.py`, PyO3 0.22 bridge, `a1_fixtures.py`, `a1_cases.json`.
- Produces: `ovolve_core.activity_exec` PyO3 module exporting `json_safe`, `resolve_callable_ref`, `classify_execution`, `run_sync_in_subprocess`, `_parse_result_line`, `_on_deadline_impl`, `ACTIVITY_*` constants.

- [ ] **Step 1: Check baseline status and verify the 4 mutant/probe failure points**

Run: `node D:/ovolve-migration/tmp/a1b_anchor_check.mjs`
Expected: `ANCHORS total=71 bad=0`

Review `tmp/a1b_chain.log`:
- `ROUND idx=10 name=cls_side_effects verdict=BAD` (compile failure during mutant build)
- `ROUND idx=15 name=rss_timeout_default verdict=MISSED` (mutant not caught by test cases)
- `ROUND idx=18 name=bind_runsync_kw_required verdict=BAD` (probe `total=NaN`)
- `ROUND idx=24 name=rss_cap_test verdict=MISSED`
- `ROUND idx=31 name=rcr_truthy_and verdict=MISSED`
- Gate failure: `FULL_GATE=FAILED env_at_import`

- [ ] **Step 2: Fix mutant definitions and test cases**

1. In `D:/ovolve-migration/tmp/a1b_mutants.mjs`:
   - Fix `cls_side_effects`: ensure replacement produces valid Rust syntax without breaking closing braces or type expectations.
   - Fix `bind_runsync_kw_required`: ensure child runner invocation receives correct JSON format so total does not evaluate to NaN.
2. In `D:/ovolve-migration/tmp/a1_cases.json`:
   - Add targeted test cases covering:
     - `rss_timeout_default`: explicit default timeout threshold comparison.
     - `rss_cap_test`: process output capture limit boundary conditions.
     - `rcr_truthy_and`: boolean short-circuit evaluation in reference resolver.
3. In `D:/ovolve-migration/tmp/a1b_envimport.py`:
   - Fix `env_at_import` checks so export names and types match `ovolve_core.activity_exec` precisely.

- [ ] **Step 3: Run anchor check and build wheel**

Run:
```powershell
node D:/ovolve-migration/tmp/a1b_anchor_check.mjs
node D:/ovolve-migration/tmp/a1_build.mjs wheel
```
Expected: `ANCHOR_CHECK=PASSED`, `RESULT=WHEEL_BUILT`, `RESULT=OK`

- [ ] **Step 4: Run parity round and verify 0 failures**

Run: `node D:/ovolve-migration/tmp/a1b_round.mjs both`
Expected: `fails=0`, `differing=0`, `DB_UNCHANGED=true`, `pin_ok=true`

- [ ] **Step 5: Run detached negative controls (48 rounds)**

Launch detached runner:
```powershell
node D:/ovolve-migration/tmp/a1_launch.mjs D:/ovolve-migration/tmp/a1b_negctl.stdout.log -- "C:/Program Files/nodejs/node.exe" D:/ovolve-migration/tmp/a1b_negctl.mjs 48
```
Monitor `D:/ovolve-migration/tmp/a1b_negctl_rounds.log` until complete.
Run: `node D:/ovolve-migration/tmp/a1b_negsum.mjs 40`
Expected: `NEG_SUMMARY=PASSED`, `MUTANTS>=40`, `CAUGHT==MUTANTS`, `BAD=0`, `RESTORED=true`

- [ ] **Step 6: Run full gate and stamp verified archive**

Run: `node D:/ovolve-migration/tmp/a1b_full_gate.mjs`
Expected: Tail of `D:/ovolve-migration/tmp/activity_exec_full_gate.log` is `FULL_GATE=PASSED`.

Stamp:
```powershell
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs activity_exec.py --dry
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs activity_exec.py
```
Expected: `verified/activity_exec.json` written, hashes verified against disk.

---

### Task 2: Implement and Gate Native Unit A4 (`bare_modifier_guard.py` -> Rust `bare_modifier_guard/mod.rs`)

**Files:**
- Create: `D:/Ovolve Agent/app/backend/rust_core/src/bare_modifier_guard/mod.rs`
- Modify: `D:/Ovolve Agent/app/backend/rust_core/src/lib.rs` (register module)
- Create: `D:/ovolve-migration/tmp/bmg_cases.json`, `D:/ovolve-migration/tmp/bmg_probe_py.py`, `D:/ovolve-migration/tmp/bmg_probe_rs.py`, `D:/ovolve-migration/tmp/bmg_compare.mjs`, `D:/ovolve-migration/tmp/bmg_guardctl.mjs`, `D:/ovolve-migration/tmp/bmg_negctl.mjs`, `D:/ovolve-migration/tmp/bmg_full_gate.mjs`
- Stamp: `D:/ovolve-migration/verified/bare_modifier_guard.json`

**Interfaces:**
- Consumes: Python source `app/backend/bare_modifier_guard.py` (100 lines). Windows Win32 API (`GetAsyncKeyState`, `GetCursorPos`).
- Produces: `ovolve_core.bare_modifier_guard` exporting `is_bare_modifier_pressed`, `get_cursor_position`, `BareModifierGuard` struct/functions, matching Python signatures.

- [ ] **Step 1: Write failing compile / anchor test**

Run:
```powershell
cargo check --manifest-path "D:/Ovolve Agent/app/backend/rust_core/Cargo.toml"
```
Verify baseline compiles cleanly before adding `bare_modifier_guard`.

- [ ] **Step 2: Implement `app/backend/rust_core/src/bare_modifier_guard/mod.rs`**

Implement full Windows user32 bindings via PyO3:
- `VK_SHIFT (0x10)`, `VK_CONTROL (0x11)`, `VK_MENU (0x12)`, `VK_LWIN (0x5B)`, `VK_RWIN (0x5C)`.
- Physical key state check via `windows-sys` or `winapi` user32 `GetAsyncKeyState` (checking high bit `0x8000`).
- Cursor position check via `GetCursorPos(&mut point)`.
- Fallback for non-Windows platforms or permission errors (matching Python try/except behavior).
- Add trailer: `// PORT STATUS: 本文件无 TODO(port)。`.
- Wire `pub mod bare_modifier_guard;` and `bare_modifier_guard::register(m)?;` into `lib.rs`.

- [ ] **Step 3: Rebuild wheel and verify `cargo check`**

Run:
```powershell
cargo check --manifest-path "D:/Ovolve Agent/app/backend/rust_core/Cargo.toml"
node D:/ovolve-migration/tmp/dp_pyfile.mjs -e "import ovolve_core.bare_modifier_guard as bmg; print(dir(bmg))"
```
Expected: `EXIT=0`, exports present.

- [ ] **Step 4: Build probe harness and verify dual-side parity**

Create `tmp/bmg_*` following `bap_*` template:
- `bmg_cases.json`: >=60 test cases covering normal, synthetic key state overrides, cursor queries, edge cases.
- Run `node tmp/bmg_probe_py.py` and `node tmp/bmg_probe_rs.py`.
- Run `node tmp/bmg_compare.mjs` -> verify `FAILURES=0`, `DB_UNCHANGED=true`.
- Run `node tmp/bmg_guardctl.mjs` -> verify `GUARDCTL PASSED`.

- [ ] **Step 5: Run negative controls and full gate**

- Construct >=40 mutants (>=20 Rust, >=20 Python) in `tmp/bmg_negctl.mjs`.
- Execute:
```powershell
node D:/ovolve-migration/tmp/bmg_negctl.mjs
node D:/ovolve-migration/tmp/bmg_full_gate.mjs
```
Expected: `FULL_GATE=PASSED`, `MUTANTS>=40`, `CAUGHT==MUTANTS`, `BAD=0`, `RESTORED=true`.

- [ ] **Step 6: Stamp verified archive**

Run:
```powershell
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs bare_modifier_guard.py --dry
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs bare_modifier_guard.py
```
Expected: `verified/bare_modifier_guard.json` created.

---

### Task 3: Complete Native Unit A2 (`work_copy.py` Rust merge path) & Verify A3 (`rust_adapters/**` Absorbed)

**Files:**
- Modify: `D:/Ovolve Agent/app/backend/rust_core/src/work_copy/mod.rs`
- Verify: `D:/Ovolve Agent/app/backend/rust_adapters/**` (12 files)
- Stamp: `D:/ovolve-migration/verified/work_copy.json`

**Interfaces:**
- Consumes: `app/backend/work_copy.py` Python merge path logic, `app/backend/rust_adapters/*.py`.
- Produces: Fully Rust-native merge path in `rust_core/src/work_copy/mod.rs` with 0 residual Python dependencies.

- [ ] **Step 1: Inspect `work_copy` merge path divergence**

Inspect `app/backend/work_copy.py` and `app/backend/rust_core/src/work_copy/mod.rs` around merge functions.
Identify the exact Python merge logic that was previously deferred.

- [ ] **Step 2: Implement Rust-native merge logic in `work_copy/mod.rs`**

- Port three-way file merge / directory merge operations into native Rust using filesystem primitives and git diff parsing.
- Ensure 0 `TODO(port)` remains in `work_copy/mod.rs`.
- Rebuild wheel and test `import ovolve_core.work_copy`.

- [ ] **Step 3: Run dual-side parity and negative controls for `work_copy`**

- Run `node tmp/wc_round.mjs both` or equivalent `work_copy` gate.
- Ensure all merge path test cases pass with `FAILURES=0`, `DB_UNCHANGED=true`.
- Run negative controls (>=40 mutants caught).
- Update and verify `verified/work_copy.json`.

- [ ] **Step 4: Verify absorption of all 12 `rust_adapters/**` modules**

Check each of the 12 `rust_adapters/**` files listed in `manifest.tsv`:
- Verify the corresponding Rust module implements every adapter function.
- Write audit report `tmp/lead_rust_adapters_audit.txt` proving complete absorption.

---

### Task 4: Unit 218 (`server/http_server.py`) S7 & S8 Completion

**Files:**
- Create: `D:/ovolve-migration/tmp/w218_s7_draft/http_server_s7.ts`
- Create: `D:/ovolve-migration/tmp/w218_s8_draft/http_server_s8.ts`
- Test: `D:/ovolve-migration/tmp/w218_s7_probe.mjs`, `D:/ovolve-migration/tmp/w218_s8_probe.mjs`
- Test: `D:/ovolve-migration/tmp/lead_mirror_single_source_check.mjs`

**Interfaces:**
- Consumes: `app/backend/server/http_server.py` lines 5548–6667 (S7: memory/wiki/mcp/outbound), lines 6668–7490 (S8: git/shadow), and `app/engine/server/http_server_keys.ts` §M.
- Produces: Exported handler clusters for S7 and S8, importing §M mirrors with 0 duplicate local helper functions.

- [ ] **Step 1: Check existing S6 completion and verify clean mirror check**

Run:
```powershell
node D:/ovolve-migration/tmp/lead_s6_recheck.mjs
node D:/ovolve-migration/tmp/lead_mirror_single_source_check.mjs s6
```
Expected: `LEAD_S6_RECHECK=ALL_GREEN`, `MIRROR_SINGLE_SOURCE=PASSED`

- [ ] **Step 2: Draft S7 (5548–6667) in `tmp/w218_s7_draft/http_server_s7.ts`**

- Extract memory, wiki, dream, conflict, mcp, channels, outbound, and network policy endpoints.
- Strict rule: All CPython emulation utilities MUST be imported from `http_server_keys.ts` §M. No private `py_strip`, `py_dict_get`, etc.
- Export all handlers matching Python signatures and status codes.
- Add trailer: `// PORT STATUS: 本文件无 TODO(port)。`.

- [ ] **Step 3: Typecheck and test S7 in sandbox**

Run:
```powershell
node D:/ovolve-migration/tmp/lead_mirror_single_source_check.mjs s7
node D:/ovolve-migration/tmp/w218_s7_probe.mjs
```
Expected: `dup=0`, `S7_PROBE=GREEN`

- [ ] **Step 4: Draft S8 (6668–7490) in `tmp/w218_s8_draft/http_server_s8.ts`**

- Extract git and shadow workspace handlers.
- Import §M from `http_server_keys.ts`.
- Implement fail-closed seams for all git subprocess calls.
- Add trailer: `// PORT STATUS: 本文件无 TODO(port)。`.

- [ ] **Step 5: Typecheck and test S8 in sandbox**

Run:
```powershell
node D:/ovolve-migration/tmp/lead_mirror_single_source_check.mjs s8
node D:/ovolve-migration/tmp/w218_s8_probe.mjs
```
Expected: `dup=0`, `S8_PROBE=GREEN`

---

### Task 5: Unit 218 (`server/http_server.py`) S9, S1 & S2, S10 Assembly & Unified Gate

**Files:**
- Create: `D:/ovolve-migration/tmp/w218_s9_draft/http_server_s9.ts`
- Create: `D:/ovolve-migration/tmp/w218_s1s2_draft/http_server_s1s2.ts`
- Assemble into: `D:/Ovolve Agent/app/engine/server/http_server.ts`
- Test: `D:/ovolve-migration/tmp/w218_full_gate.mjs`
- Stamp: `D:/ovolve-migration/verified/server__http_server.json`

**Interfaces:**
- Consumes: S0 (`keys.ts`, `util.ts`, `create.ts`), S3, S4, S5, S6, S7, S8, S9, S1/S2 handlers.
- Produces: Complete `app/engine/server/http_server.ts` routing table wiring all 100+ endpoints, passing whole-repo `tsc --noEmit`, dual-side parity probe on all aiohttp endpoints, and >=40 mutants negative control.

- [ ] **Step 1: Draft S9 (7491–8051) and S1/S2 (40–2795)**

- S9: hooks, evolution, browser claims handlers.
- S1/S2: WebSocketHandler, event bridging, `_run_turn`, `_handle_message`.
- Ensure all handlers import §M and adhere to seam isolation (zero real websocket sockets bound).

- [ ] **Step 2: Assemble S10 into `app/engine/server/http_server.ts`**

- Merge segments S0–S10 into `app/engine/server/http_server.ts` (or maintain modular segment imports from `app/engine/server/http_server_s*.ts`).
- Wire all route registrations in `create_server`.
- Run whole-repo typecheck:
```powershell
node D:/ovolve-migration/tmp/dp_tsc.mjs engine D:/ovolve-migration/tmp/w218_tsc.txt
```
Expected: `EXIT=0`, `ERRORS=0`.

- [ ] **Step 3: Run unified probe and compare**

- Run `node D:/ovolve-migration/tmp/w218_probe_py.py` and `node D:/ovolve-migration/tmp/w218_probe_ts.mjs`.
- Run `node D:/ovolve-migration/tmp/w218_compare.mjs`.
- Verify `FAILURES=0`, `DB_UNCHANGED=true`.
- Run `node D:/ovolve-migration/tmp/w218_guardctl.mjs` -> `GUARDCTL PASSED`.

- [ ] **Step 4: Run negative controls (>=40 mutants)**

- Execute `node D:/ovolve-migration/tmp/w218_negctl.mjs`.
- Verify `MUTANTS>=40`, `CAUGHT==MUTANTS`, `BAD=0`, `RESTORED=true`.

- [ ] **Step 5: Run full gate and stamp verified archive**

Run: `node D:/ovolve-migration/tmp/w218_full_gate.mjs`
Expected: `FULL_GATE=PASSED`.

Stamp:
```powershell
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs server/http_server.py --dry
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs server/http_server.py
```
Expected: `verified/server__http_server.json` created.

---

### Task 6: Strict Archive Backfill Batch 1 (Queue Head 5 Units)

**Files:**
- Target 1: `edge/base.py` -> `app/engine/edge/base.ts` (47L src / 90L tgt)
- Target 2: `path_lock.py` -> `app/engine/path_lock.ts` (51L src / 104L tgt)
- Target 3: `scope_guard.py` -> `app/engine/scope_guard.ts` (51L src / 105L tgt)
- Target 4: `router_modules/goal.py` -> `app/engine/router_modules/goal.ts` (52L src / 85L tgt)
- Target 5: `stream_circuit_breaker.py` -> `app/engine/stream_circuit_breaker.ts` (53L src / 74L tgt)
- Harness: Clone from `tmp/bap_*` for each unit (`ebas_*`, `plk_*`, `scg_*`, `rmg_*`, `scb_*`)
- Stamps: `verified/edge__base.json`, `verified/path_lock.json`, `verified/scope_guard.json`, `verified/router_modules__goal.json`, `verified/stream_circuit_breaker.json`

**Interfaces:**
- Consumes: Existing on-disk TS ports in `app/engine/`.
- Produces: Strict 4-check verified archives for all 5 units, with `tmp/<stem>_full_gate.log` (`FULL_GATE=PASSED`) and `tmp/<stem>_neg_summary.log` (`MUTANTS>=40`, `CAUGHT==MUTANTS`, `BAD=0`, `RESTORED=true`).

- [ ] **Step 1: Check baseline status with `lead_backfill_strict.mjs`**

Run: `node D:/ovolve-migration/tmp/lead_backfill_strict.mjs`
Confirm Queue Head order and check if ports exist on disk and pass `tsc`.

- [ ] **Step 2: Generate test harnesses using `bap_*` as template**

For each unit in Batch 1:
1. Generate `<prefix>_cases.json` (>=60 cases, multi-group, no duplicate collapse vectors).
2. Generate `<prefix>_probe_py.py` and `<prefix>_probe_ts.mjs`.
3. Generate `<prefix>_compare.mjs` and `<prefix>_guardctl.mjs` (knobs >= 30, empty whitelist).
4. Generate `<prefix>_negctl.mjs` (>=40 mutants: >=20 TS, >=20 PY, with check mode).
5. Generate `<prefix>_full_gate.mjs` writing directly to `tmp/<safeStem>_full_gate.log`.

- [ ] **Step 3: Execute gate chain for each unit sequentially**

For each unit:
```powershell
node D:/ovolve-migration/tmp/<prefix>_full_gate.mjs
```
Verify stdout and log file tail: `FULL_GATE=PASSED`.

- [ ] **Step 4: Verify gate reproducibility**

Run:
```powershell
node D:/ovolve-migration/tmp/lead_gate_rerun.mjs <safeStem>
```
Expected: `ok=true`, `last="FULL_GATE=PASSED"`.

- [ ] **Step 5: Stamp verified archives**

For each unit:
```powershell
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs <source.py> --dry
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs <source.py>
```
Expected: All 5 verified archives written with clean hashes and 0 TODO(port).

- [ ] **Step 6: Re-run strict measurement script**

Run: `node D:/ovolve-migration/tmp/lead_backfill_strict.mjs`
Expected: `DONE` count increases from 23 to 28.

---

### Task 7: Strict Archive Backfill Systematized Pipeline (Batches 2..N to close remaining units)

**Files:**
- Queue: Modules listed in `tmp/lead_backfill_strict.txt` sorted by ascending line count.
- Next batches:
  - Batch 2: `edge/openvino_backend.py`, `evolution_pressure.py`, `mcp_server/tools/file_tools.py`, `mcp_server/tools/search_tools.py`, `skill_tools.py`
  - Batch 3: `build_rust.py`, `shadow_session.py`, `providers/common.py`, `_activity_child.py`, `browser_policy_guard.py`
  - Subsequent batches through all 193 modules.
- Stamps: `verified/*.json` for every module in `manifest.tsv`.

**Interfaces:**
- Consumes: Target ports in `app/engine/` and `rust_core/src/`.
- Produces: 221 strictly validated archives with full gate reproducibility.

- [ ] **Step 1: Execute automated batch scaffolding generator**

Use or adapt `tmp/lead_backfill_plan.mjs` to auto-scaffold case generation and probe suites based on module AST and export inspection.

- [ ] **Step 2: Run batch verification in controlled concurrency (<=3 agents)**

Run verification chains for each batch:
- Run dual probes with isolated sandbox environments (`dp_pyfile.mjs` / `dp_tsfile.mjs`).
- Verify ledger parity: `FAILURES=0`, `differing=0`, `DB_UNCHANGED=true`.
- Run negative control mutants: >=40 mutants, 100% caught, 0 bad, byte-restored.
- Run full gate: `FULL_GATE=PASSED`.

- [ ] **Step 3: Stamp verified archives and record in cost-log**

For each verified module:
```powershell
node D:/ovolve-migration/tmp/lead_stamp_writer.mjs <source.py>
```
Append row to `cost-log.tsv`.

- [ ] **Step 4: Continuous strict progress tracking**

After every batch:
```powershell
node D:/ovolve-migration/tmp/lead_backfill_strict.mjs
```
Track progression towards `DONE=221`.

---

### Task 8: Rust Core Task #123 Cleanup & Final 221-Unit Global Verification

**Files:**
- Modify: `D:/Ovolve Agent/app/backend/rust_core/src/validator_registry/mod.rs`
- Modify: `D:/Ovolve Agent/app/backend/rust_core/src/shadow_workspace/mod.rs`
- Modify: `D:/Ovolve Agent/app/backend/rust_core/src/work_copy/mod.rs`
- Script: `D:/ovolve-migration/tmp/lead_todos_ledger.mjs`
- Script: `D:/ovolve-migration/tmp/lead_gate_rerun_all.mjs`
- Tool: `D:/ovolve-migration/tools/burndown.py`

**Interfaces:**
- Consumes: All 221 verified archives, `app/engine/**`, `app/backend/rust_core/**`.
- Produces: 0 real `TODO(port)` across the entire repository (both TS and Rust), 100% burndown, and 221/221 reproducible passing gates.

- [ ] **Step 1: Eliminate residual `TODO(port)` in Rust Core (Task #123)**

Inspect `rust_core` modules with `tmp/lead_todos_ledger.mjs`:
- Resolve 21 residual `TODO(port)` markers in `validator_registry`, `shadow_workspace`, and `work_copy`.
- Ensure every file ends with `// PORT STATUS: 本文件无 TODO(port)。`.
- Recheck: `node D:/ovolve-migration/tmp/lead_todos_ledger.mjs` -> `rust_real=0`, `ts_real=0`.

- [ ] **Step 2: Run whole-repo TypeScript type check**

Run:
```powershell
node D:/ovolve-migration/tmp/dp_tsc.mjs engine D:/ovolve-migration/tmp/final_tsc.txt
```
Expected: `EXIT=0`, `ERRORS=0`.

- [ ] **Step 3: Run whole-repo gate reproducibility scan**

Run:
```powershell
node D:/ovolve-migration/tmp/lead_gate_rerun_all.mjs
```
Expected: `SUMMARY units=221 ok=221 not_reproducible=0`, `GATE_RERUN_ALL=ALL_REPRODUCED`.

- [ ] **Step 4: Run burndown progress check**

Run:
```powershell
python D:/ovolve-migration/tools/burndown.py
```
Expected:
`units: 221 | done: 221 | remaining: 0 | progress: 100.0%`

- [ ] **Step 5: Verify Red Line 5 integrity**

Check SQLite database files:
```powershell
Get-ChildItem -Path "$env:USERPROFILE\.ovolve\db"
```
Verify zero modification during execution.

- [ ] **Step 6: Update HANDOFF_V11.md with final completion audit and deliver report**

Document final completion in `HANDOFF_V11.md` and `cost-log.tsv`.

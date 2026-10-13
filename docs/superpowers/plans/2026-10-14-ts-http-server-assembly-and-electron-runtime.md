# Ovolve TypeScript HTTP Server Assembly & Electron Runtime Switch Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the complete TypeScript backend HTTP server (`app/engine/server/http_server.ts`) with all 160 routes and WebSocket bridge, pass whole-repo `tsc --noEmit`, and switch Electron (`electron/main.ts`) & `run-ovolve.bat` to launch Node/TS backend natively without Python.

**Architecture:** Integrate the pre-drafted segments S1, S4–S9 from `D:/ovolve-migration/tmp/` into modular files under `app/engine/server/`. Wire them into `app/engine/server/http_server.ts` through `ROUTE_TABLE` and `create_server` from `http_server_create.ts`. Provide a Node native `http` + WebSocket server adapter. Create `app/engine/main.ts` as the self-contained backend entrypoint and wire Electron's child process directly to Node.js/tsx.

**Tech Stack:** TypeScript 5.x, Node.js (ESM), `@types/node`, `tsx`, Electron 33.x.

## Global Constraints

- Absolute Source Immutability: `app/backend/**` (outside `rust_core/**`) is strictly read-only.
- Do NOT run `git commit` or `git push` in `D:/Ovolve Agent`.
- Database safety: Do not modify `~/.ovolve/db/*.db`.
- Type Safety: Whole-repo `tsc --noEmit` must exit 0 with 0 errors.

---

### Task 1: Fix Existing Type Baseline Errors in `app/engine`

**Files:**
- Modify: `D:/Ovolve Agent/app/engine/cua_ocr_diff.ts`
- Modify: `D:/Ovolve Agent/app/engine/evolution_miner.ts`

**Interfaces:**
- Consumes: Existing TypeScript engine code.
- Produces: Clean baseline typecheck for all non-server modules.

- [ ] **Step 1: Check baseline errors**
Run: `node D:/ovolve-migration/tmp/dp_tsc.mjs engine D:/ovolve-migration/tmp/baseline_check.txt`
Expected: 4 errors in `cua_ocr_diff.ts` (L71) and `evolution_miner.ts` (L74).

- [ ] **Step 2: Fix `cua_ocr_diff.ts` line 71**
Ensure `string | undefined` is safely defaulted to `""` or cast to `string`.

- [ ] **Step 3: Fix `evolution_miner.ts` line 74**
Ensure `string | undefined` is safely defaulted to `""` or cast to `string`.

- [ ] **Step 4: Verify typecheck passes on baseline**
Run: `node D:/ovolve-migration/tmp/dp_tsc.mjs engine D:/ovolve-migration/tmp/baseline_check.txt`
Expected: `EXIT=0`, `ERRORS=0`.

---

### Task 2: Import & Align Server Segments (S1, S4–S9) into `app/engine/server/`

**Files:**
- Copy & Align:
  - `D:/ovolve-migration/tmp/w218_s1_draft/http_server_s1.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s1.ts`
  - `D:/ovolve-migration/tmp/w218_s4_draft/http_server_s4.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s4.ts`
  - `D:/ovolve-migration/tmp/w218_s5_draft/http_server_s5.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s5.ts`
  - `D:/ovolve-migration/tmp/w218_s6_draft/http_server_s6.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s6.ts`
  - `D:/ovolve-migration/tmp/w218_s7_draft/http_server_s7.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s7.ts`
  - `D:/ovolve-migration/tmp/w218_s8_draft/http_server_s8.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s8.ts`
  - `D:/ovolve-migration/tmp/w218_s9_draft/http_server_s9.ts` -> `D:/Ovolve Agent/app/engine/server/http_server_s9.ts`

**Interfaces:**
- Consumes: Handler functions and WebSocketHandler from S1–S9.
- Produces: Exported handler dictionaries/functions matching `ROUTE_TABLE` requirements.

- [ ] **Step 1: Copy segment files to `app/engine/server/`**
Copy all segment files from draft directories.

- [ ] **Step 2: Check imports in each segment**
Ensure relative imports point correctly to `./http_server_keys.js`, `./http_server_util.js`, etc.

- [ ] **Step 3: Run segment typecheck**
Run: `node D:/ovolve-migration/tmp/dp_tsc.mjs engine D:/ovolve-migration/tmp/segments_tsc.txt`
Review any missing exports or minor type mismatches and fix them cleanly.

---

### Task 3: Assemble `app/engine/server/http_server.ts` & Node Native Server Adapter

**Files:**
- Create: `D:/Ovolve Agent/app/engine/server/http_server.ts`

**Interfaces:**
- Consumes: All handlers from S1–S9, `ROUTE_TABLE`, `create_server` from `http_server_create.ts`.
- Produces: Exported `run_server(config, system_prompt, config_path)` and Node `http.Server` instance running on port 8765.

- [ ] **Step 1: Assemble `HandlerRegistry`**
Aggregate all 155 handlers across S1–S9 into the `HandlerRegistry` mapping.

- [ ] **Step 2: Build Node HTTP Request/Response Bridge**
Map Node incoming HTTP requests (`http.IncomingMessage`) to `WebRequest`:
- Parse URL query and pathname
- Match route from `ROUTE_TABLE` with pattern matching (`{param}`)
- Parse JSON body if present
- Execute matching `HttpHandler`
- Write status, headers, and body back to Node `http.ServerResponse`

- [ ] **Step 3: Build Node WebSocket Upgrade Bridge**
Listen for `upgrade` event on the HTTP server, bridge to `WebSocketHandler.handle_websocket`.

- [ ] **Step 4: Implement `run_server` entrypoint**
Wire initialization of `Router`, `init_risk_controller`, `init_llm`, tool registrations, and start the server on host & port.

- [ ] **Step 5: Verify whole-repo `tsc --noEmit`**
Run: `node D:/ovolve-migration/tmp/dp_tsc.mjs engine D:/ovolve-migration/tmp/full_engine_tsc.txt`
Expected: `EXIT=0`, `ERRORS=0`.

---

### Task 4: Create `app/engine/main.ts` & Switch Electron and Batch Launchers

**Files:**
- Create: `D:/Ovolve Agent/app/engine/main.ts`
- Modify: `D:/Ovolve Agent/electron/main.ts`
- Modify: `D:/Ovolve Agent/run-ovolve.bat`

**Interfaces:**
- Consumes: `http_server.ts:run_server`.
- Produces: Standalone TS backend process started by Node/tsx, completely replacing `python main.py --server`.

- [ ] **Step 1: Create `app/engine/main.ts`**
CLI argument parser supporting `--server`, `--config`, `--command`, mirroring `app/main.py` but pure TypeScript.

- [ ] **Step 2: Test standalone TS server startup**
Launch: `node ./node_modules/tsx/dist/cli.mjs app/engine/main.ts --server`
Test probe in another process:
`curl http://127.0.0.1:8765/api/health`
Expected: 200 OK.

- [ ] **Step 3: Modify `electron/main.ts`**
Change `startPythonBackend` to `startNodeBackend`:
Spawn Node.js using `tsx app/engine/main.ts --server`.
Keep `waitForBackendReady` and `verifyBackendIdentity`.

- [ ] **Step 4: Update `run-ovolve.bat`**
Replace Python uvicorn command with Node TS engine startup.

---

### Task 5: End-to-End Functional Verification

**Files:**
- Test: Full runtime stack (Backend + Electron + Web UI).

- [ ] **Step 1: Health & Authentication Verification**
Test:
- `http://127.0.0.1:8765/api/health`
- `http://127.0.0.1:8765/api/evolution/mode` with `X-Api-Token`

- [ ] **Step 2: WebSocket Connection Verification**
Test WebSocket ping/pong and message dispatch on `ws://127.0.0.1:8765/ws`.

- [ ] **Step 3: Launch Electron Dev Mode & Test UI Interaction**
Run `npm run dev` or `npm run electron:dev`.
Confirm UI loads, connects to backend, and performs basic turn interaction without Python.

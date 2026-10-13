<div align="center">

<img src="public/assets/banner.png" alt="Ovolve Agent Banner" width="100%" />

# Ovolve Agent

**Autonomous Local Coding Agent Powered by Physical Sandboxes, Deterministic Gates & Continuous Self-Evolution**

[ English ](README_en.md) · [ 简体中文 ](README.md)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![GPQA-Diamond](https://img.shields.io/badge/GPQA--Diamond-91.41%25%20(SOTA%20+2.51pp)-brightgreen.svg)](eval_harness/results/gpqa_agent_merged.json)
[![Google IFEval](https://img.shields.io/badge/Google%20IFEval-93.56%25%20(+3.56pp)-brightgreen.svg)](eval_harness/results/ifeval_agent_20260907_234638.json)
[![Base Model](https://img.shields.io/badge/Base%20Model-LongCat--2.0%20(1.6T%20MoE)-orange.svg)](https://api.longcat.chat)
[![Privacy](https://img.shields.io/badge/Privacy-Zero--Telemetry-purple.svg)](#-security--privacy)

[Core Pillars](#-core-pillars) · [Quick Start](#-quick-start) · [Benchmarks](#-benchmarks--physical-evaluations) · [Architecture](#-system-topology) · [Codebase Map](#-codebase-map)

</div>

---

> ### “What you see now is merely the starting point. Mistakes made once are never repeated.”
> 
> **Ovolve Agent** is an autonomous AI coding agent engineered for production-grade software delivery. It iterates and self-heals inside isolated physical sandboxes, distilling failure experiences directly into persistent memory rules — never merging to the main workspace until all tests are green.

---

## 🚀 Core Pillars

### 1. 🛡️ Native Physical Sandboxing & Deterministic Gates
* **Sub-Second Native Sandboxes**: Mounts isolated physical workspaces via underlying Git Worktrees, enabling conflict-free concurrent agent executions;
* **Pre-Landing AST Syntax Gates**: Parses Abstract Syntax Trees before code hits the disk, physically blocking mock code like `pass`, `Ellipsis`, and uncommitted `TODO`s;
* **SHA-256 Acceptance Contracts**: Locks task specifications and test fingerprints upon initiation, strictly preventing the agent from dropping test assertions (Anti-Weakening Gate);
* **3-Way Safe Merge**: Merges into the main workspace only when physical tests inside the sandbox pass completely, with atomic rollbacks and visual resolution upon conflicts.

### 2. 🔄 GEPA Natural Language Continuous Self-Evolution
* **AST-Based Failure Clustering**: Captures runtime compilation errors and assertion failures, clustering them automatically via structural AST signatures;
* **4D Pareto Optimization**: Automatically evolves system guidelines across four Pareto frontiers: accuracy, token cost, response latency, and safety margins;
* **Memory Rule Feedback**: Distills lessons directly into `MEMORY.md`, eliminating manual prompt tweaks and making the agent smarter with every session.

### 3. 🧠 6-Tier Spatiotemporal Memory Matrix
* **Hierarchical 6-Tier Architecture**: Ranges from process-level ephemeral scratchpads (Working), dynamic hourly decays (Short-term), and 25KB hard-budgeted rulebooks (Long-term / `MEMORY.md`), to vector retrieval (Semantic), entity graphs (Wiki), and idle reflection dreaming — never overflowing the context window;
* **30-Day Half-Life & MMR Re-Ranking**: Incorporates temporal decay $w(t) = 2^{-\Delta t / 30}$ alongside Maximal Marginal Relevance re-ranking to detect knowledge contradictions and recall high-signal, low-redundancy context;
* **Pre-Compaction & Microfolding**: Extracts user preferences and critical decisions to disk prior to conversation truncation, preventing knowledge loss; pairs with tool output Microfolding and Head-Tail log trimming to eliminate mid-context attention drift (Lost in the Middle).

### 4. ⚡ Desktop-Grade CUA & Full-Scenario Browser Automation
* **Native Windows Automation**: Directly invokes the Windows `IUIAutomation` vtable via ctypes, traversing the OS control tree in milliseconds for pixel-accurate interactions;
* **Compact DOM Snapshots & Ref Protocol**: Extracts interactive elements into compact snapshots (e.g., `[e12] button "Submit"`), referencing nodes by Ref ID to dramatically reduce token consumption and eliminate coordinate drift;
* **CDP Screencasting & Skill Promotion**: Records real browser workflows under backpressure, extracts parametric slots, and promotes validated workflows to reusable skills through a strict three-gate validation pipeline.

---

## ⚡ Quick Start

### Method 1: Windows One-Click Launch (Recommended)
Double-click the root bootstrap script:
```powershell
.\run-ovolve.bat
```
The script will automatically detect local dependencies, start the backend engine on port 8000, and launch the frontend studio on port 3000.

### Method 2: Manual Developer Setup

```bash
# 1. Start backend engine (Python 3.10+)
cd app/backend
pip install -r requirements.txt
python -m uvicorn server.http_server:app --port 8000 --host 127.0.0.1

# 2. Start frontend studio (Node.js 18+)
cd app/ui
npm install
npm run dev
```

---

## 📊 Benchmarks & Physical Evaluations

Under **rigorous controlled variables** (unified LongCat-2.0 1.6T MoE base model) and **zero-docker native subprocess exit code assertions (`exit_code == 0`)**:

| Benchmark | Evaluation Scope | LongCat-2.0 Base Model | **Ovolve Agent Enhanced** | Architecture Delta | Verification Mechanism |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **GPQA-Diamond** | 198 PhD-level interdisciplinary scientific reasoning questions | 88.90% | **91.41%** (181/198) | **+2.51pp** | Unified Runner with 16 concurrency + sandbox self-healing loop |
| **Google IFEval** | 541 system-level strict format and rule compliance tasks | 90.00% | **93.56%** (654/699) | **+3.56pp** | Deterministic physical rule validation on execution outputs |

---

## 🗺️ System Topology

```
[ User Request / Task Objective ]
               │
               ▼
[ Phase 0: Contract Locking ] ──> SHA-256 fingerprinting locks test cases
               │
               ▼
[ Phase 1: Physical Sandbox ] ──> Sub-second Git Worktree sandbox isolation
               │
               ▼
[ Phase 2: Reason & Self-Heal Loop ]
   ├── 6-Tier Memory Assembly (25KB Hard Cap) + Pre-Compaction Injection
   ├── AST Syntax Inspection ──> Rejects empty functions & placeholder code
   ├── Native Sandbox Compilation & Automated Testing
   └── Failure Self-Healing ──> Traceback-driven self-correction loop
               │
               ▼ (All sandbox tests pass with exit code 0)
[ Phase 3: Delivery & Merge ]
   ├── Anti-Weakening Verification ──> Verifies assertion count & script hash
   ├── 3-Way Safe Merge ──> Safely merges into main tree; zero pollution
   └── Experience Crystallization ──> Triggers GEPA to persist rules into MEMORY.md
```

---

## 📦 Codebase Map

| Core Architecture Module | Source Path | Primary Responsibility |
| :--- | :--- | :--- |
| **Dispatch & ReAct Kernel** | `app/backend/router_modules/` | Admission gatekeeping, routing dispatch, and ReAct loop execution |
| **6-Tier Spatiotemporal Memory** | `app/backend/memory_domain.py` | Unified facade, 30-day half-life decay, MMR ranking & contradiction detection |
| **Pre-Compaction & Microfolding** | `app/backend/context_compactor.py` | Memory persistence, historical tool microfolding & Head-Tail log trimming |
| **Physical Sandbox & Safe Merge** | `app/backend/worktree_manager.py` | Git Worktree millisecond isolation, lifecycle control & 3-Way safe merge |
| **Acceptance Contract & Gates** | `app/backend/acceptance_contract.py` | SHA-256 task fingerprinting, anti-weakening test case verification |
| **AST Pre-Landing Inspector** | `app/backend/ast_reviewer_enhanced.py` | AST scanning before disk write; blocks empty functions and stubs |
| **Native Windows UIA** | `app/backend/uia_tree.py` | ctypes direct Windows `IUIAutomation` vtable calls for millisecond tree walks |
| **DOM Snapshots & Ref Protocol** | `app/backend/browser_dom_snapshot.py` | Compact DOM snapshots with stable Ref IDs, slashing context token cost |
| **CDP Screencast & Skill Promotion** | `app/backend/cdp_screencast.py` | Backpressured screencasting, parameter extraction & skill promotion (`WorkflowSkillPromoter`) |
| **Deep Defense & URL Guard** | `app/backend/url_guard.py` | 5-layer SSRF defense, blocking IMDS endpoints and private network probes |
| **Secret Leak Prevention** | `app/backend/secret_scan.py` | Trie pre-filtering + regex + Shannon entropy checks to block credential leaks |
| **Natural Language Self-Evolution** | `app/backend/evolution.py` | AST failure clustering, 4D Pareto candidate evaluation & rule crystallization |

---

## 🔒 Security & Privacy

- **Strict Zero-Telemetry**: Runs 100% locally with no analytics, tracking, or hardware fingerprint collection;
- **Sandbox-Level Isolation**: All modifications and test runs occur in temporary Git Worktrees, protecting your primary working tree from damage;
- **Defense in Depth**: Built-in SSRF guards, process-level HMAC authentication, secret leakage scanners, and destructive command interception.

---

## 📄 License

This project is licensed under the [Apache-2.0 License](LICENSE).

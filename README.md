<div align="center">

# Ovolve Agent

**Open-source, autonomous AI software engineering desktop application built with native TypeScript & Rust.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-33.4-informational.svg)](https://www.electronjs.org/)

</div>

---

## Overview

Ovolve Agent is an autonomous AI coding assistant and desktop engineering environment. Designed for production-grade reliability, it runs entirely on your local machine with an isolated Git worktree sandbox, multi-model orchestration, and a zero-Python native TypeScript and Rust runtime.

## Key Features

- **Zero Python Dependency**: Fully decoupled from Python runtimes. The backend is powered by a native Node.js/TypeScript engine and compiled Rust core.
- **Physical Sandbox Isolation**: Millisecond-level Git worktree isolation ensures changes are tested and verified before touching your main working tree.
- **Desktop & Browser Automation**: Native Windows UI Automation (`IUIAutomation`) and Chrome DevTools Protocol (CDP) for full-system agent workflows.
- **Streaming Architecture**: Integrated RFC 6455 WebSocket gateway and 155+ REST API endpoints for real-time IPC and UI synchronization.
- **Local & Private**: Complete on-device execution. Zero telemetry, zero external tracking, and strict path-level permission gates.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Desktop UI (React 18 + Vite + TailwindCSS + Radix UI) │
└───────────────────────────┬────────────────────────────┘
                            │  HTTP / WebSocket (Port: 8765)
┌───────────────────────────▼────────────────────────────┐
│  Engine Runtime (Native TypeScript / Node.js)          │
│  - Router & Dispatcher   - Session Host & Continuity   │
│  - Multi-tier Memory     - Safety Gates & Policies     │
└───────────────────────────┬────────────────────────────┘
                            │  Native Process / FFI
┌───────────────────────────▼────────────────────────────┐
│  Core Acceleration (Rust Core)                         │
│  - Git Worktree Sandbox  - Fast Memory Retrieval       │
│  - Native Desktop UIA    - Sandbox Subprocess Isolation│
└────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js** >= 18.0.0
- **Git** >= 2.30.0

### Installation

```bash
# Clone the repository
git clone https://github.com/Poetrynan/Ovolve-Agent.git
cd Ovolve-Agent

# Install project dependencies
npm install
```

### Running the Application

**Option 1: Windows One-Click Launch**
```cmd
.\run-ovolve.bat
```

**Option 2: Desktop Development Mode (Electron + Vite)**
```bash
npm run electron:dev
```

**Option 3: Standalone Engine Server Mode**
```bash
node ./node_modules/tsx/dist/cli.mjs app/engine/main.ts --server
```
The engine server will start on `http://127.0.0.1:8765`.

## Repository Structure

```
.
├── app/
│   ├── engine/          # Native TypeScript backend engine (Server, Router, Tools)
│   ├── ui/              # React frontend application
│   └── backend/         # Rust core (rust_core) & native modules
├── electron/            # Electron main process, IPC handlers, tray & windows
├── scripts/             # Build and development orchestration scripts
├── package.json         # Root workspace scripts & dependencies
└── run-ovolve.bat       # Windows launcher script
```

## Building for Production

```bash
# Build Vite frontend and Electron main/preload bundles
npm run build:electron
```

## License

This project is licensed under the [Apache-2.0 License](LICENSE).

/**
 * main.ts - Ovolve Native TypeScript Entry Point.
 *
 * Provides CLI, single-command, and server modes without any Python dependency.
 *
 * Usage:
 *   node --experimental-strip-types app/engine/main.ts --server
 *   node --experimental-strip-types app/engine/main.ts --config path --server
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run_server } from "./server/http_server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, "..");

export function loadConfig(configPath?: string): Record<string, unknown> {
  const p = configPath || path.join(appDir, "config.json");
  if (!fs.existsSync(p)) {
    console.log(`[config] Config not found at ${p}, using defaults.`);
    return {
      permissions: { mode: "auto" },
      workspace: { root: process.cwd() },
      server: { host: "127.0.0.1", port: 8765 },
    };
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    const cfg = JSON.parse(raw);
    const ws = (cfg.workspace as any)?.root;
    if (ws) {
      const absWs = path.isAbsolute(ws) ? ws : path.resolve(path.dirname(p), ws);
      fs.mkdirSync(absWs, { recursive: true });
    }
    return cfg;
  } catch (e: any) {
    console.warn(`[config] Failed to load config: ${e?.message}, using defaults.`);
    return {
      permissions: { mode: "auto" },
      workspace: { root: process.cwd() },
      server: { host: "127.0.0.1", port: 8765 },
    };
  }
}

export function loadSystemPrompt(): string {
  const spPath = path.join(appDir, "system_prompt.md");
  if (fs.existsSync(spPath)) {
    try {
      return fs.readFileSync(spPath, "utf8");
    } catch (_) {}
  }
  return "";
}

async function main() {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let isServer = false;
  let command: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === "--server") {
      isServer = true;
    } else if (arg === "--command" && i + 1 < args.length) {
      command = args[++i];
    }
  }

  const config = loadConfig(configPath);
  const cfgResolvedPath = configPath || path.join(appDir, "config.json");
  const systemPrompt = loadSystemPrompt();

  if (command) {
    console.log("[cli] Running single command:", command);
    const { Router } = await import("./router.js");
    const ws = String((config.workspace as any)?.root || process.cwd());
    const router = new Router({ workspace: ws, system_prompt: systemPrompt });
    const res = await router.handle(command, {});
    if (res.ok) {
      console.log(res.value);
    } else {
      console.error("Error:", res.error);
      process.exit(1);
    }
    return;
  }

  // Default to server mode if --server or started without command
  if (isServer || args.length === 0) {
    await run_server(config, systemPrompt, cfgResolvedPath);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("main.js"))) {
  main().catch((e) => {
    console.error("[main] Fatal error:", e);
    process.exit(1);
  });
}

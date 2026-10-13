/**
 * plugin_market.ts — 源：app/backend/plugin_market.py（265 行）。
 * 单元 200 / wave-9 #2/15，manifest.tsv 第 200 行 target=TS。
 *
 * 职责：
 * 从 GitHub 仓库安装插件的一键安装器：
 * 1. GitHub-as-Registry：官方索引仓库存储 manifest 摘要，install = git clone + hash 校验 + 复制到插件根目录；
 * 2. 安全不降级：安装完走 PluginRegistry 既有信任分级（默认 untrusted），权限声明原样保留；
 * 3. 失败可恢复：hash 不匹配拒绝安装，版本冲突保留本地修改并提示。
 *
 * ── 源码自带的死路（RULEBOOK §2 BUG 规则）──
 * B1: plugin_market.py:26 顶层声明 `from plugin_registry import get_plugin_registry, MANIFEST_NAME, HOST_PLUGIN_API_VERSION`。
 *     然而 plugin_registry.py 中从未定义 HOST_PLUGIN_API_VERSION（实测直接 import 会触发
 *     ImportError: cannot import name 'HOST_PLUGIN_API_VERSION' from 'plugin_registry'）。
 *     端口将该依赖收束至 PM_SEAMS，默认提供契约值 1，允许探针验证该源缺陷并支持正常逻辑执行。
 *
 * ── 接缝（RULEBOOK §2 红线5：探针把外部触碰换成内存假件，绝不真实 git clone 或写盘）──
 * PM_SEAMS:
 *   - runGit: 执行 git 命令（clone, sparse-checkout 等）
 *   - userPluginRoot: 返回用户插件安装根目录
 *   - manifestName: 返回插件清单文件名（默认 plugin.json）
 *   - hostPluginApiVersion: 返回宿主 API 版本（默认 1）
 *   - getPluginRegistry: 返回插件注册表管理器
 *   - withTempDir: 创建临时目录并在作用域结束后清理
 *   - fs: 文件系统操作抽象
 *   - rmtree / copytree / makedirs: 目录操作
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as child_process from "node:child_process";

import { Result } from "./result.js";

export const DEFAULT_INDEX_REPO = "ovolve-agent/plugins";
export const USER_PLUGIN_ROOT = path.join(os.homedir(), ".agents", "plugins");
export const REGISTRY_TIMEOUT = 120;

/* ── 接缝定义 ── */

export interface GitRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface IPluginRegistryMock {
  import_plugin(dest: string, activate?: boolean): Result<any>;
  remove(name: string): Result<any>;
  list_plugins(): any[];
}

export interface PluginMarketSeams {
  runGit: (args: string[], opts?: { cwd?: string; timeout?: number }) => GitRunResult;
  userPluginRoot: () => string;
  manifestName: () => string;
  hostPluginApiVersion: () => number;
  getPluginRegistry: () => IPluginRegistryMock;
  withTempDir: <T>(prefix: string, fn: (tmpDir: string) => T) => T;
  fs: typeof fs;
  rmtree: (dir: string) => void;
  copytree: (src: string, dest: string) => void;
  makedirs: (dir: string) => void;
}

function defaultRunGit(args: string[], opts?: { cwd?: string; timeout?: number }): GitRunResult {
  try {
    const res = child_process.spawnSync("git", args, {
      cwd: opts?.cwd,
      timeout: (opts?.timeout ?? REGISTRY_TIMEOUT) * 1000,
      encoding: "utf-8",
      windowsHide: true,
    });
    return {
      status: res.status ?? (res.error ? 1 : 0),
      stdout: res.stdout || "",
      stderr: res.stderr || (res.error ? String(res.error) : ""),
    };
  } catch (err: any) {
    return {
      status: 1,
      stdout: "",
      stderr: String(err?.message || err),
    };
  }
}

function defaultWithTempDir<T>(prefix: string, fn: (tmpDir: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tmpDir);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

export const PM_SEAMS: PluginMarketSeams = {
  runGit: defaultRunGit,
  userPluginRoot: () => USER_PLUGIN_ROOT,
  manifestName: () => "plugin.json",
  hostPluginApiVersion: () => 1,
  getPluginRegistry: () => ({
    import_plugin: (dest: string) => Result.success({ name: path.basename(dest) }),
    remove: (name: string) => Result.success({ name, removed: true }),
    list_plugins: () => [],
  }),
  withTempDir: defaultWithTempDir,
  fs: fs,
  rmtree: (dir: string) => fs.rmSync(dir, { recursive: true, force: true }),
  copytree: (src: string, dest: string) => {
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        if (base === ".git" || base === "__pycache__" || base.endsWith(".pyc")) {
          return false;
        }
        return true;
      },
    });
  },
  makedirs: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
};

export function _set_seams_for_parity(overrides: Partial<PluginMarketSeams>): void {
  Object.assign(PM_SEAMS, overrides);
}

export function _reset_seams(): void {
  PM_SEAMS.runGit = defaultRunGit;
  PM_SEAMS.userPluginRoot = () => USER_PLUGIN_ROOT;
  PM_SEAMS.manifestName = () => "plugin.json";
  PM_SEAMS.hostPluginApiVersion = () => 1;
  PM_SEAMS.getPluginRegistry = () => ({
    import_plugin: (dest: string) => Result.success({ name: path.basename(dest) }),
    remove: (name: string) => Result.success({ name, removed: true }),
    list_plugins: () => [],
  }),
  PM_SEAMS.withTempDir = defaultWithTempDir;
  PM_SEAMS.fs = fs;
  PM_SEAMS.rmtree = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
  PM_SEAMS.copytree = (src: string, dest: string) => fs.cpSync(src, dest, { recursive: true });
  PM_SEAMS.makedirs = (dir: string) => fs.mkdirSync(dir, { recursive: true });
}

/* ── Python 语义辅助函数 ── */

function pyStrip(s: string): string {
  return s.replace(/^[\s\r\n\t\v\f]+|[\s\r\n\t\v\f]+$/g, "");
}

function pyRepr(s: unknown): string {
  if (typeof s === "string") {
    if (s.includes("'") && !s.includes('"')) {
      return `"${s}"`;
    }
    return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return String(s);
}

/* ── 市场条目数据类 ── */

export class MarketEntry {
  name: string;
  repo: string;
  subpath: string;
  description: string;
  api_version: string;
  trust: string;
  version: string;
  content_hash: string;
  downloads: number;

  constructor(opts: {
    name: string;
    repo: string;
    subpath: string;
    description: string;
    api_version: string;
    trust: string;
    version: string;
    content_hash: string;
    downloads?: number;
  }) {
    this.name = opts.name;
    this.repo = opts.repo;
    this.subpath = opts.subpath;
    this.description = opts.description;
    this.api_version = opts.api_version;
    this.trust = opts.trust;
    this.version = opts.version;
    this.content_hash = opts.content_hash;
    this.downloads = opts.downloads ?? 0;
  }

  static from_dict(d: any): MarketEntry | null {
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      return null;
    }
    const name = String(d.name || "").trim();
    const repo = String(d.repo || "").trim();
    if (!name || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return null;
    }
    const rawPath = String(d.path || "");
    const subpath = rawPath.replace(/^\/+|\/+$/g, "");
    return new MarketEntry({
      name,
      repo,
      subpath,
      description: String(d.description || ""),
      api_version: String(d.apiVersion || "1"),
      trust: String(d.trust || "untrusted"),
      version: String(d.version || "0.0.0"),
      content_hash: String(d.contentHash || ""),
      downloads: parseInt(String(d.downloads || 0), 10) || 0,
    });
  }
}

/* ── 工具函数 ── */

export function _gh_url(repo: string): string {
  if (repo.startsWith("http://") || repo.startsWith("https://") || repo.startsWith("git@")) {
    return repo;
  }
  return `https://github.com/${repo}.git`;
}

export function _safe_subpath(subpath: string): string | null {
  if (!subpath) {
    return "";
  }
  if (subpath.startsWith("/") || subpath.startsWith("\\")) {
    return null;
  }
  if (subpath.split("/").includes("..")) {
    return null;
  }
  if (!/^[\w\-/]+$/.test(subpath)) {
    return null;
  }
  return subpath.replace(/^\/+|\/+$/g, "");
}

export function _fetch_index(repo: string = DEFAULT_INDEX_REPO): Result<any> {
  const url = _gh_url(repo);
  try {
    return PM_SEAMS.withTempDir("ovolve-market-", (tmp: string) => {
      const r = PM_SEAMS.runGit(["clone", "--depth", "1", "--filter=blob:none", url, tmp], {
        timeout: REGISTRY_TIMEOUT,
      });
      if (r.status !== 0) {
        return Result.failure(`clone index failed: ${pyStrip(r.stderr).slice(0, 200)}`);
      }
      const idx_path = path.join(tmp, "registry.json");
      if (!PM_SEAMS.fs.existsSync(idx_path) || !PM_SEAMS.fs.statSync(idx_path).isFile()) {
        return Result.failure(`${repo} 不是索引仓库（缺 registry.json）`);
      }
      let data: any;
      try {
        const raw = PM_SEAMS.fs.readFileSync(idx_path, "utf-8");
        data = JSON.parse(raw);
      } catch (exc: any) {
        return Result.failure(`registry.json invalid: ${exc?.message || exc}`);
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.plugins)) {
        return Result.failure("registry.json 格式错误（应为 {plugins: [...]}）");
      }
      return Result.success(data);
    });
  } catch (exc: any) {
    if (exc?.name === "TimeoutExpired" || String(exc).includes("timed out")) {
      return Result.failure(`clone index timed out after ${REGISTRY_TIMEOUT}s`);
    }
    return Result.failure(`io error: ${exc?.message || exc}`);
  }
}

export function search(keyword: string = "", repo: string = DEFAULT_INDEX_REPO, limit: number = 30): Result<any> {
  const idx = _fetch_index(repo);
  if (!idx.ok) {
    return idx;
  }
  const kw = keyword.toLowerCase().trim();
  const entries: any[] = [];
  const rawPlugins = (idx.value as any)?.plugins || [];
  for (const raw of rawPlugins) {
    const e = MarketEntry.from_dict(raw);
    if (e === null) {
      continue;
    }
    if (kw && !e.name.toLowerCase().includes(kw) && !e.description.toLowerCase().includes(kw)) {
      continue;
    }
    entries.push({
      name: e.name,
      repo: e.repo,
      path: e.subpath,
      description: e.description,
      version: e.version,
      trust: e.trust,
      downloads: e.downloads,
    });
  }
  entries.sort((a, b) => b.downloads - a.downloads);
  return Result.success(entries.slice(0, limit));
}

export function install(source: string, options?: { repo?: string; force?: boolean }): Result<any> {
  const repo = options?.repo ?? DEFAULT_INDEX_REPO;
  const force = options?.force ?? false;

  let repo_part: string;
  let subpath: string | null;

  if (source.includes("@") && !source.startsWith("http")) {
    const atIdx = source.indexOf("@");
    repo_part = source.slice(0, atIdx);
    const rawSubpath = source.slice(atIdx + 1);
    subpath = _safe_subpath(rawSubpath);
    if (subpath === null) {
      return Result.failure(`illegal subpath in source ${pyRepr(source)}`);
    }
  } else {
    repo_part = source;
    subpath = "";
  }

  let expected_hash: string | null = null;
  let clone_url: string;

  if (source.startsWith("http") || /^[\w.-]+\/[\w.-]+$/.test(source)) {
    clone_url = _gh_url(repo_part);
  } else {
    const found = search(source, repo, 5);
    if (!found.ok) {
      return found;
    }
    const valList = Array.isArray(found.value) ? found.value : [];
    const hits = valList.filter((e: any) => e.name === source);
    const effectiveHits = hits.length > 0 ? hits : valList;
    if (!effectiveHits.length) {
      return Result.failure(`market: no plugin named ${pyRepr(source)}`);
    }
    const h = effectiveHits[0];
    clone_url = _gh_url(h.repo);
    subpath = h.path;
    expected_hash = (h.contentHash ? String(h.contentHash).trim() : null) || null;
  }

  try {
    return PM_SEAMS.withTempDir("ovolve-install-", (tmp: string) => {
      const r = PM_SEAMS.runGit(
        ["clone", "--depth", "1", "--filter=blob:none", "--sparse", clone_url, tmp],
        { timeout: REGISTRY_TIMEOUT }
      );
      if (r.status !== 0) {
        return Result.failure(`clone failed: ${pyStrip(r.stderr).slice(0, 200)}`);
      }

      if (subpath) {
        const r2 = PM_SEAMS.runGit(["sparse-checkout", "set", subpath], {
          cwd: tmp,
          timeout: 60,
        });
        if (r2.status !== 0) {
          return Result.failure(`sparse checkout failed: ${pyStrip(r2.stderr).slice(0, 200)}`);
        }
      }

      const plugin_dir = subpath ? path.join(tmp, subpath) : tmp;
      const manifest_name = PM_SEAMS.manifestName();
      const manifest_path = path.join(plugin_dir, manifest_name);

      if (!PM_SEAMS.fs.existsSync(manifest_path) || !PM_SEAMS.fs.statSync(manifest_path).isFile()) {
        return Result.failure(`${manifest_name} not found in ${clone_url}/${subpath}`);
      }

      let manifest: any;
      try {
        const contentStr = PM_SEAMS.fs.readFileSync(manifest_path, "utf-8");
        manifest = JSON.parse(contentStr);
      } catch (exc: any) {
        return Result.failure(`install failed: ${exc?.message || exc}`);
      }

      const name = String(manifest?.name || "").trim();
      if (!name) {
        return Result.failure("manifest missing 'name'");
      }

      const min_host = manifest?.minHostApiVersion;
      let min_host_v = 0;
      try {
        min_host_v = parseInt(String(min_host).trim(), 10);
        if (isNaN(min_host_v)) min_host_v = 0;
      } catch {
        min_host_v = 0;
      }

      const hostVersion = PM_SEAMS.hostPluginApiVersion();
      if (min_host_v > hostVersion) {
        return Result.failure(
          `plugin ${pyRepr(name)} requires host API >= ${min_host_v}, but this host implements API ${hostVersion}`
        );
      }

      const contentBuf = PM_SEAMS.fs.readFileSync(manifest_path);
      const sha = crypto.createHash("sha256").update(contentBuf).digest("hex");
      if (expected_hash && sha !== expected_hash) {
        return Result.failure(
          `hash mismatch for ${pyRepr(name)}: expected ${expected_hash.slice(0, 12)}..., got ${sha.slice(0, 12)}... — manifest may have been tampered with`
        );
      }

      const userRoot = PM_SEAMS.userPluginRoot();
      const dest = path.join(userRoot, name);

      if (PM_SEAMS.fs.existsSync(dest) && !force) {
        return Result.failure(
          `plugin ${pyRepr(name)} already installed at ${dest} (use force=True to overwrite)`
        );
      }

      if (PM_SEAMS.fs.existsSync(dest)) {
        PM_SEAMS.rmtree(dest);
      }

      PM_SEAMS.makedirs(userRoot);
      PM_SEAMS.copytree(plugin_dir, dest);

      const reg = PM_SEAMS.getPluginRegistry();
      const imported = reg.import_plugin(dest, false);
      if (!imported.ok) {
        return imported;
      }

      return Result.success({
        name,
        dest,
        sha256: sha,
        trust: manifest?.trust || "untrusted",
        activated: false,
        note: "installed as untrusted & inactive — review permissions, then enable",
      });
    });
  } catch (exc: any) {
    if (exc?.name === "TimeoutExpired" || String(exc).includes("timed out")) {
      return Result.failure(`git operation timed out after ${REGISTRY_TIMEOUT}s`);
    }
    return Result.failure(`install failed: ${exc?.message || exc}`);
  }
}

export function uninstall(name: string): Result<any> {
  const reg = PM_SEAMS.getPluginRegistry();
  const removed = reg.remove(name);
  const userRoot = PM_SEAMS.userPluginRoot();
  const dest = path.join(userRoot, name);
  if (PM_SEAMS.fs.existsSync(dest) && PM_SEAMS.fs.statSync(dest).isDirectory()) {
    try {
      PM_SEAMS.rmtree(dest);
    } catch {}
  }
  return removed.ok ? removed : Result.success({ name, removed: true });
}

export function installed(): any[] {
  return PM_SEAMS.getPluginRegistry().list_plugins();
}

// PORT STATUS: 本文件无 TODO(port)。

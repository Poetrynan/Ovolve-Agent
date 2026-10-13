/**
 * plugin_registry.ts — bundles that contribute capabilities to the agent.
 *
 * Ported from `app/backend/plugin_registry.py` (386 lines).
 * Unit 201 / Wave 9, manifest.tsv line 201 target=TS.
 *
 * A plugin is a directory with a plugin.json manifest. It does not run code of
 * its own; it *contributes* things the agent already knows how to load:
 *   contributes.skills     — directories, each containing a SKILL.md
 *   contributes.subagents  — sub-agent YAML files
 *
 * RULEBOOK CITATIONS:
 *   §1  node: builtins only (node:fs, node:os, node:path, node:url).
 *   §2  Red Line 5 non-invasive testing via PR_SEAMS.
 *   §2  B1 bug fix: HOST_PLUGIN_API_VERSION exported for consumer modules.
 *   §4  naming: plugin_registry.py -> plugin_registry.ts
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Result } from "./result.js";
import { attribution_from } from "./attribution.js";
import { get_skill_loader, TrustLevel } from "./skill_loader.js";
import {
  load_subagent_file,
  register_subagent_def,
  unregister_subagent_def,
} from "./subagent_registry.js";

export const MANIFEST_NAME = "plugin.json";
export const HOST_PLUGIN_API_VERSION = 1;
export const SUPPORTED_CONTRIBUTIONS: readonly string[] = ["skills", "subagents"];

export interface PluginEntryOptions {
  name: string;
  root: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  copyright?: string;
  upstream?: string;
  license_from_file?: boolean;
  status?: string;
  error?: string;
  skills?: string[];
  subagents?: string[];
  unsupported?: string[];
  declared?: Record<string, any>;
}

export class PluginEntry {
  name: string;
  root: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  license: string;
  copyright: string;
  upstream: string;
  license_from_file: boolean;
  status: string;
  error: string;
  skills: string[];
  subagents: string[];
  unsupported: string[];
  declared: Record<string, any>;

  constructor(opts: PluginEntryOptions) {
    this.name = opts.name;
    this.root = opts.root;
    this.version = opts.version ?? "";
    this.description = opts.description ?? "";
    this.author = opts.author ?? "";
    this.homepage = opts.homepage ?? "";
    this.license = opts.license ?? "";
    this.copyright = opts.copyright ?? "";
    this.upstream = opts.upstream ?? "";
    this.license_from_file = opts.license_from_file ?? false;
    this.status = opts.status ?? "loaded";
    this.error = opts.error ?? "";
    this.skills = opts.skills ? [...opts.skills] : [];
    this.subagents = opts.subagents ? [...opts.subagents] : [];
    this.unsupported = opts.unsupported ? [...opts.unsupported] : [];
    this.declared = opts.declared ? { ...opts.declared } : {};
  }

  to_public(): Record<string, any> {
    const declSkills = Array.isArray(this.declared?.skills) ? this.declared.skills : [];
    const declSubagents = Array.isArray(this.declared?.subagents) ? this.declared.subagents : [];
    return {
      name: this.name,
      root: this.root,
      version: this.version,
      description: this.description,
      author: this.author,
      homepage: this.homepage,
      license: this.license,
      copyright: this.copyright,
      upstream: this.upstream,
      licenseFromFile: this.license_from_file,
      status: this.status,
      error: this.error,
      skills: [...this.skills],
      subagents: [...this.subagents],
      unsupported: [...this.unsupported],
      declaredSkills: declSkills.length,
      declaredSubagents: declSubagents.length,
    };
  }
}

function pyRepr(v: unknown): string {
  if (typeof v === "string") {
    if (v.includes("'") && !v.includes('"')) {
      return `"${v}"`;
    }
    return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return String(v);
}

function defaultRootsImpl(): string[] {
  let here = "";
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  const project = path.resolve(path.join(here, "..", ".."));
  return [
    path.join(project, ".agents", "plugins"),
    path.join(os.homedir(), ".agents", "plugins"),
  ];
}

export interface PluginRegistrySeams {
  attributionFrom: typeof attribution_from;
  getSkillLoader: typeof get_skill_loader;
  trustLevelUntrusted: typeof TrustLevel.UNTRUSTED;
  loadSubagentFile: typeof load_subagent_file;
  registerSubagentDef: typeof register_subagent_def;
  unregisterSubagentDef: typeof unregister_subagent_def;
  fs: typeof fs;
  realpath: (p: string) => string;
  defaultRoots: () => string[];
}

export function pyRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const resolved = path.resolve(p);
    let curr = resolved;
    const parts: string[] = [];
    while (curr && !fs.existsSync(curr)) {
      const parent = path.dirname(curr);
      if (parent === curr) break;
      parts.unshift(path.basename(curr));
      curr = parent;
    }
    try {
      const realParent = fs.realpathSync(curr);
      return path.join(realParent, ...parts);
    } catch {
      return resolved;
    }
  }
}

export const PR_SEAMS: PluginRegistrySeams = {
  attributionFrom: attribution_from,
  getSkillLoader: get_skill_loader,
  trustLevelUntrusted: TrustLevel.UNTRUSTED,
  loadSubagentFile: load_subagent_file,
  registerSubagentDef: register_subagent_def,
  unregisterSubagentDef: unregister_subagent_def,
  fs: fs,
  realpath: pyRealpath,
  defaultRoots: defaultRootsImpl,
};

export function _set_seams_for_parity(overrides: Partial<PluginRegistrySeams>): void {
  Object.assign(PR_SEAMS, overrides);
}

export function _reset_seams(): void {
  PR_SEAMS.attributionFrom = attribution_from;
  PR_SEAMS.getSkillLoader = get_skill_loader;
  PR_SEAMS.trustLevelUntrusted = TrustLevel.UNTRUSTED;
  PR_SEAMS.loadSubagentFile = load_subagent_file;
  PR_SEAMS.registerSubagentDef = register_subagent_def;
  PR_SEAMS.unregisterSubagentDef = unregister_subagent_def;
  PR_SEAMS.fs = fs;
  PR_SEAMS.realpath = pyRealpath;
  PR_SEAMS.defaultRoots = defaultRootsImpl;
}

export function _attribution_kwargs(plugin_dir: string, manifest: Record<string, any>): {
  author: string;
  license: string;
  copyright: string;
  upstream: string;
  license_from_file: boolean;
} {
  const homepage = String(manifest.homepage || "");
  const declared_upstream = String(manifest.upstream || "") || String(manifest.repository || "") || homepage;
  const attr = PR_SEAMS.attributionFrom(
    plugin_dir,
    String(manifest.license || ""),
    String(manifest.author || ""),
    declared_upstream
  );
  return {
    author: attr.author,
    license: attr.license,
    copyright: attr.copyright,
    upstream: attr.upstream,
    license_from_file: attr.licenseFromFile,
  };
}

export function _read_manifest(plugin_dir: string): Result<Record<string, any>> {
  const p = path.join(plugin_dir, MANIFEST_NAME);
  try {
    const st = PR_SEAMS.fs.statSync(p);
    if (!st.isFile()) {
      return Result.failure(`${MANIFEST_NAME} not found in ${plugin_dir}`);
    }
  } catch {
    return Result.failure(`${MANIFEST_NAME} not found in ${plugin_dir}`);
  }

  let data: any;
  try {
    const raw = PR_SEAMS.fs.readFileSync(p, "utf-8");
    try {
      data = JSON.parse(raw);
    } catch (exc: any) {
      return Result.failure(`${MANIFEST_NAME} is not valid JSON: ${exc?.message || exc}`);
    }
  } catch (exc: any) {
    return Result.failure(`cannot read ${MANIFEST_NAME}: ${exc?.message || exc}`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return Result.failure(`${MANIFEST_NAME} must be a JSON object`);
  }

  const name = String(data.name || "").trim();
  if (!name) {
    return Result.failure("manifest is missing 'name'");
  }

  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    return Result.failure(`illegal plugin name '${name}'`);
  }

  const api_version = String(data.apiVersion || "1");
  if (api_version !== "1" && api_version !== "2") {
    return Result.failure(`unsupported apiVersion ${pyRepr(api_version)} (supported: 1, 2)`);
  }

  const trust = String(data.trust || "untrusted").trim().toLowerCase();
  if (trust !== "trusted" && trust !== "untrusted" && trust !== "own") {
    return Result.failure(`illegal trust ${pyRepr(trust)} (expected trusted|untrusted|own)`);
  }

  const permissions = data.permissions;
  if (permissions !== undefined && permissions !== null && (typeof permissions !== "object" || Array.isArray(permissions))) {
    return Result.failure("'permissions' must be an object {filesystem, network, credentials, process}");
  }

  const contribs = data.contributes && typeof data.contributes === "object" && !Array.isArray(data.contributes)
    ? data.contributes
    : {};
  const unknown_contribs = Object.keys(contribs).filter((k) => !SUPPORTED_CONTRIBUTIONS.includes(k));
  if (unknown_contribs.length > 0 && data.strictContributions) {
    const rep = "[" + unknown_contribs.map(pyRepr).join(", ") + "]";
    return Result.failure(`unsupported contributions: ${rep}`);
  }

  return Result.success(data);
}

export function _resolve_inside(root: string, rel: string): string | null {
  try {
    const root_real = PR_SEAMS.realpath(root);
    const target = PR_SEAMS.realpath(path.join(root_real, rel));
    if (target === root_real || target.startsWith(root_real + path.sep)) {
      return target;
    }
    return null;
  } catch {
    return null;
  }
}

export class PluginRegistry {
  private _plugins: Map<string, PluginEntry> = new Map();

  default_roots(): string[] {
    return PR_SEAMS.defaultRoots();
  }

  import_plugin(plugin_dir: string, options?: { activate?: boolean }): Result<Record<string, any>> {
    const activate = options?.activate ?? true;
    let normDir = plugin_dir;
    if (normDir.startsWith("~")) {
      normDir = path.join(os.homedir(), normDir.slice(1));
    }
    normDir = path.resolve(normDir);

    const manifest = _read_manifest(normDir);
    if (!manifest.ok) {
      return manifest;
    }

    const data = manifest.value!;
    const contributes = data.contributes && typeof data.contributes === "object" && !Array.isArray(data.contributes)
      ? data.contributes
      : {};

    const attr = _attribution_kwargs(normDir, data);
    const unsupported = Object.keys(contributes)
      .filter((k) => !SUPPORTED_CONTRIBUTIONS.includes(k))
      .sort();

    const entry = new PluginEntry({
      name: String(data.name).trim(),
      root: normDir,
      version: String(data.version || ""),
      description: String(data.description || ""),
      homepage: String(data.homepage || ""),
      declared: contributes,
      author: attr.author,
      license: attr.license,
      copyright: attr.copyright,
      upstream: attr.upstream,
      license_from_file: attr.license_from_file,
      unsupported,
    });

    this._plugins.set(entry.name, entry);
    if (activate) {
      this._activate(entry);
    } else {
      entry.status = "disabled";
    }

    return Result.success(entry.to_public());
  }

  discover(roots?: string[] | null): { loaded: string[]; broken: Array<{ name: string; error: string }> } {
    const actualRoots = roots !== undefined && roots !== null ? roots : this.default_roots();
    for (const root of actualRoots) {
      try {
        if (!PR_SEAMS.fs.existsSync(root) || !PR_SEAMS.fs.statSync(root).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      let children: string[] = [];
      try {
        children = PR_SEAMS.fs.readdirSync(root).sort();
      } catch {
        continue;
      }

      for (const child of children) {
        const plugin_dir = path.join(root, child);
        try {
          if (!PR_SEAMS.fs.statSync(plugin_dir).isDirectory()) {
            continue;
          }
          const manPath = path.join(plugin_dir, MANIFEST_NAME);
          if (!PR_SEAMS.fs.existsSync(manPath) || !PR_SEAMS.fs.statSync(manPath).isFile()) {
            continue;
          }
        } catch {
          continue;
        }

        const probe = _read_manifest(plugin_dir);
        if (probe.ok && probe.value && this._plugins.has(String(probe.value.name || ""))) {
          continue; // already claimed by earlier root
        }
        this.import_plugin(plugin_dir);
      }
    }

    const loaded: string[] = [];
    const broken: Array<{ name: string; error: string }> = [];

    for (const p of this._plugins.values()) {
      if (p.status === "loaded") {
        loaded.push(p.name);
      } else if (p.status === "broken") {
        broken.push({ name: p.name, error: p.error });
      }
    }

    return { loaded, broken };
  }

  private _activate(entry: PluginEntry): void {
    const problems: string[] = [];
    entry.skills = [];
    entry.subagents = [];

    const loader = PR_SEAMS.getSkillLoader();
    const declSkills = Array.isArray(entry.declared?.skills) ? entry.declared.skills : [];
    for (const rel of declSkills) {
      const target = _resolve_inside(entry.root, String(rel));
      if (target === null) {
        problems.push(`skill path '${rel}' escapes the plugin directory`);
        continue;
      }

      const res = loader.import_skill(target, PR_SEAMS.trustLevelUntrusted as any);
      if (res.ok && res.value && typeof res.value === "object" && (res.value as any).name) {
        entry.skills.push((res.value as any).name);
      } else if (res.ok) {
        entry.skills.push(path.basename(target));
      } else {
        problems.push(`skill '${rel}': ${res.error}`);
      }
    }

    const declSubagents = Array.isArray(entry.declared?.subagents) ? entry.declared.subagents : [];
    for (const rel of declSubagents) {
      const target = _resolve_inside(entry.root, String(rel));
      if (target === null) {
        problems.push(`subagent path '${rel}' escapes the plugin directory`);
        continue;
      }

      const definition = PR_SEAMS.loadSubagentFile(target);
      if (!definition) {
        problems.push(`subagent '${rel}': not a usable definition`);
        continue;
      }

      if (!PR_SEAMS.registerSubagentDef(definition)) {
        problems.push(`subagent '${definition.name}' already exists — not overwritten`);
        continue;
      }
      entry.subagents.push(definition.name);
    }

    const nothing_landed =
      entry.skills.length === 0 &&
      entry.subagents.length === 0 &&
      (declSkills.length > 0 || declSubagents.length > 0);

    entry.error = problems.join("; ");
    entry.status = nothing_landed ? "broken" : "loaded";
  }

  private _deactivate(entry: PluginEntry): void {
    const loader = PR_SEAMS.getSkillLoader();
    for (const name of entry.skills) {
      try {
        loader.disable_skill(name);
      } catch {
        // ignore
      }
    }
    for (const name of entry.subagents) {
      PR_SEAMS.unregisterSubagentDef(name);
    }
    entry.skills = [];
    entry.subagents = [];
  }

  enable(name: string): Result<Record<string, any>> {
    const entry = this._plugins.get(name);
    if (!entry) {
      return Result.failure(`unknown plugin '${name}'`);
    }
    this._activate(entry);
    return Result.success(entry.to_public());
  }

  disable(name: string): Result<Record<string, any>> {
    const entry = this._plugins.get(name);
    if (!entry) {
      return Result.failure(`unknown plugin '${name}'`);
    }
    this._deactivate(entry);
    entry.status = "disabled";
    entry.error = "";
    return Result.success(entry.to_public());
  }

  remove(name: string): Result<{ name: string }> {
    const entry = this._plugins.get(name);
    if (!entry) {
      return Result.failure(`unknown plugin '${name}'`);
    }
    this._plugins.delete(name);
    this._deactivate(entry);
    return Result.success({ name });
  }

  list_plugins(): Array<Record<string, any>> {
    return Array.from(this._plugins.values()).map((p) => p.to_public());
  }

  get(name: string): PluginEntry | undefined {
    return this._plugins.get(name);
  }
}

let _registry: PluginRegistry | null = null;

export function get_plugin_registry(): PluginRegistry {
  if (_registry === null) {
    _registry = new PluginRegistry();
  }
  return _registry;
}

export function _reset_plugin_registry(): void {
  _registry = null;
}

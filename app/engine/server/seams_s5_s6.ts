/**
 * seams_s5_s6.ts — binds the S5/S6 handler seams to the native engine.
 *
 * The S5 and S6 segments model every function-level import as a seam key and
 * ship a fail-closed default (ModuleNotFoundError / NameError). This module
 * substitutes the real modules at boot; keys left out here keep failing closed.
 *
 * Two families of adapter live below:
 *   · shims for Python-shaped call sites — the segments call `Enum(x)`,
 *     `Class(**kwargs)` and `obj.to_dict()`, none of which exist natively;
 *   · per-key getters for the plain module faces, which are pass-through.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { PyExcP } from "./http_server_keys.js";
import { register_s5_seam, type HttpS5SeamKey } from "./http_server_s5.js";
import { register_s6_seam, type HttpS6SeamKey } from "./http_server_s6.js";

/** The registries hold arm *getters*; a seam whose value is itself a function binds through here. */
function arm5(key: HttpS5SeamKey, fn: (...args: any[]) => any): void {
  register_s5_seam(key, () => fn);
}

function arm6(key: HttpS6SeamKey, fn: (...args: any[]) => any): void {
  register_s6_seam(key, () => fn);
}

/** `ValueError` with the CPython message shape the segments' `except` filters expect. */
class ValueErrorP extends PyExcP {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** `Enum(value)` construction: members are string values, unknown input raises ValueError. */
function enum_member(members: Record<string, string>, raw: unknown, label: string): string {
  const v = String(raw);
  for (const member of Object.values(members)) {
    if (member === v) return member;
  }
  throw new ValueErrorP(`'${v}' is not a valid ${label}`);
}

/**
 * `skill_loader` — the loader takes `list_skills(include_disabled)` positionally
 * while the segment passes a keyword bag.
 */
function skill_loader_face(loader: any): Record<string, unknown> {
  return {
    discover: () => void loader.discover(),
    list_skills: (opts?: { include_disabled?: unknown }) =>
      loader.list_skills(Boolean(opts?.include_disabled)),
    import_skill: (skillDir: unknown, trust: unknown) =>
      loader.import_skill(String(skillDir), trust),
    uninstall_skill: (name: string) => loader.uninstall_skill(name),
    get_skill_detail: (name: string) => loader.get_skill_detail(name),
    enable_skill: (name: string) => loader.enable_skill(name),
    disable_skill: (name: string) => loader.disable_skill(name),
  };
}

/**
 * `skill_registry` — free functions; `install_marketplace_skill` takes the
 * loader fourth rather than second, and the catalog reads a keyword bag.
 */
function skill_registry_face(sr: any): Record<string, unknown> {
  return {
    marketplace_catalog: (opts: {
      category?: unknown;
      query?: unknown;
      type_filter?: unknown;
    } = {}) => sr.get_marketplace_catalog(opts.category ?? null, opts.query ?? null, opts.type_filter ?? null),
    install_marketplace_skill: (skillId: string, loader: unknown) =>
      sr.install_marketplace_skill(skillId, null, null, loader),
    sync_lockfile: (loader: unknown) => sr.sync_lockfile(loader),
    install_from_github: (source: string, skillPath: string, loader: unknown, name: unknown) =>
      sr.install_from_github(source, skillPath, loader, name),
    agentskills_info: () => sr.agentskills_info(),
  };
}

/**
 * `storage` — a transparent view of the singleton that swaps in an event-store
 * face the segment can call `read_stream(...)` and `_db.execute(...)` on.
 */
function storage_face(st: any): any {
  return new Proxy(st, {
    get(target, prop) {
      if (prop === "get_event_store") return () => event_store_face(target.get_event_store());
      const v = target[prop as keyof typeof target];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** `event_store` — events carry `toDict()`, and the segment's fallback query names the `events` table. */
function event_store_face(es: any): Record<string, unknown> {
  const conn = es["_conn"];
  return {
    read_stream: (sessionId: string) =>
      (es.read_stream(sessionId) as any[]).map((e) => ({ to_dict: () => e.toDict() })),
    _db: {
      execute: (sql: string, params: readonly unknown[] = []) => ({
        fetchall: () =>
          conn
            .execute(sql.replace(/\bFROM\s+events\b/i, "FROM agent_events"), params)
            .fetchall(),
      }),
    },
  };
}

/**
 * `permission_rules` — `RuleBehavior(x)` / `RuleScope(x)` are enum constructors
 * and `PermissionRule(**kwargs)` is a plain call in the source; the store's
 * `list` reads a keyword bag and hands back enum members the segment dereferences
 * with `.value`.
 */
function permission_rules_face(pr: any): Record<string, unknown> {
  return {
    get_permission_rules: () => ({
      list: (opts: { workspace_root?: string; session_id?: string } = {}) =>
        pr
          .get_permission_rules()
          .list(opts.workspace_root ?? "", opts.session_id ?? "")
          .map((r: any) => ({
            ...r,
            behavior: { value: r.behavior },
            scope: { value: r.scope },
          })),
      add: (rule: any) => {
        pr.get_permission_rules().add(rule);
        return rule;
      },
      remove: (ruleId: string) => pr.get_permission_rules().remove(ruleId),
    }),
    PermissionRule: (opts: unknown) => new pr.PermissionRule(opts),
    RuleBehavior: (v: unknown) => enum_member(pr.RuleBehavior, v, "RuleBehavior"),
    RuleScope: (v: unknown) => enum_member(pr.RuleScope, v, "RuleScope"),
  };
}

/** `risk_controller` — the segment reads `mode.value` and `classify_risk(...).value`. */
function risk_controller_face(controller: any): any {
  return new Proxy(controller, {
    get(target, prop) {
      if (prop === "mode") return { value: target.mode };
      if (prop === "classify_risk") {
        return (name: string, args: Record<string, any> | null = null) => ({
          value: target.classify_risk(name, args),
        });
      }
      const v = target[prop as keyof typeof target];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Import one module and apply its bindings; a failure here must not take the rest down. */async function bindModule(load: () => Promise<unknown>, apply: (mod: any) => void): Promise<void> {
  let mod: unknown;
  try {
    mod = await load();
  } catch (err) {
    console.warn("[server] Notice: a seam module failed to load:", err);
    return;
  }
  try {
    apply(mod);
  } catch (err) {
    console.warn("[server] Notice: a seam module failed to bind:", err);
  }
}

function status_file(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Bind every S5/S6 seam that has a native implementation. Endpoints whose
 * backing module does not exist yet keep the segment's fail-closed default.
 */
export async function wireS5S6Seams(): Promise<void> {
  // ── S5 ────────────────────────────────────────────────────────────────
  await bindModule(() => import("../skill_loader.js"), (m) => {
    arm5("skill_loader_get", () => skill_loader_face(m.get_skill_loader()));
    arm5("skill_trust_level_from_str", (trustStr: string) =>
      enum_member(m.TrustLevel, trustStr, "TrustLevel"),
    );
    arm5("skill_trust_untrusted", () => m.TrustLevel.UNTRUSTED);
  });

  await bindModule(() => import("../storage.js"), (m) => {
    arm5("storage_get", () => storage_face(m.get_storage()));
    arm6("storage_module", () => ({
      get_storage: () => storage_face(m.get_storage()),
    }));
  });

  await bindModule(() => import("../approvals_projection.js"), (m) => {
    arm5("pending_approvals", (st: unknown) => m.pending_approvals(st));
  });

  await bindModule(() => import("../memory_domain.js"), (m) => {
    arm5("memory_domain_ctor", (st: unknown) => new m.MemoryDomain(st));
  });

  await bindModule(() => import("../learning_service.js"), (m) => {
    arm5("learning_service_get", (st: unknown) => m.get_learning_service(st));
  });

  await bindModule(() => import("../scope_guard.js"), (m) => {
    arm5(
      "scope_validate_scope",
      (opts: {
        expected_session: string;
        expected_branch: string;
        actual_session: string;
        actual_branch: string;
      }) =>
        m.validate_scope(
          opts.expected_session,
          opts.expected_branch,
          opts.actual_session,
          opts.actual_branch,
        ),
    );
  });

  await bindModule(() => import("../episode_manager.js"), (m) => {
    arm5("episode_manager_get", (st: unknown) => m.get_episode_manager(st));
  });

  await bindModule(() => import("../skill_lifecycle.js"), (m) => {
    arm5("skill_lifecycle_get", () => m);
  });

  await bindModule(() => import("../event_bus.js"), (m) => {
    arm5("event_bus_emit", async (topic: string, payload: Record<string, unknown>) => {
      await m.getEventBus().emit(topic, payload);
    });
  });

  await bindModule(() => import("../skill_registry.js"), (m) => {
    arm5("skill_registry", () => skill_registry_face(m));
  });

  await bindModule(() => import("../skill_vetter.js"), (m) => {
    arm5("skill_vetter_vet", (content: unknown) => ({
      to_dict: () => m.vetResultToDict(m.vet_skill(String(content))),
    }));
  });

  await bindModule(() => import("../plugin_registry.js"), (m) => {
    arm5("plugin_registry_get", () => m.get_plugin_registry());
    arm5("plugin_supported_contributions", () => m.SUPPORTED_CONTRIBUTIONS);
  });

  await bindModule(() => import("../event_types.js"), (m) => {
    arm5("event_types_from_row", (row: unknown) => ({
      to_dict: () => m.AgentEvent.fromRow(row).toDict(),
    }));
  });

  arm5("os_getcwd", () => process.cwd());
  arm5("fs_isfile", (p: string) => status_file(p));
  arm5("fs_read_text", (p: string) => fs.readFileSync(p, "utf8"));
  arm5("log_exception", (message: string) => console.error(`[server] ${message}`));
  arm5("print_sink", (line: string) => console.log(line));

  // ── S6 ────────────────────────────────────────────────────────────────
  // The segments and this file share a directory, so a module path here
  // resolves the project root exactly the way the segments expect.
  const moduleFile = fileURLToPath(import.meta.url);
  arm6("abspath_module_file", () => moduleFile);
  arm6("fs_write_text", (p: string, content: string) => {
    fs.writeFileSync(p, content, { encoding: "utf8" });
  });
  arm6("os_replace", (src: string, dst: string) => {
    fs.renameSync(src, dst);
  });
  arm6("fs_makedirs", (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
  });
  arm6("os_path_abspath", (p: string) => path.resolve(p));
  arm6("mkstemp", (dir: string, suffix: string) => {
    const tmp = path.join(dir, `.${crypto.randomBytes(8).toString("hex")}${suffix}`);
    const fd = fs.openSync(tmp, "wx");
    return [fd, tmp] as const;
  });
  arm6("fd_write_text", (fd: number, text: string) => {
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
  });
  arm6("os_unlink", (p: string) => {
    fs.unlinkSync(p);
  });
  arm6("uuid4", () => crypto.randomUUID());

  await bindModule(() => import("../permission_rules.js"), (m) => {
    arm6("permission_rules_module", () => permission_rules_face(m));
  });

  await bindModule(() => import("../tool_policy.js"), (m) => {
    arm6("tool_policy_module", () => ({ sandbox_layer_status: m.sandbox_layer_status }));
  });

  await bindModule(() => import("../sandbox.js"), (m) => {
    arm6("sandbox_module", () => ({ confinement_status: m.confinement_status }));
  });

  await bindModule(
    async () => ({
      ...(await import("../model_registry.js")),
      ...(await import("../model_registry_impl.js")),
    }),
    (m) => {
      arm6("model_registry_module", () => m);
    },
  );

  await bindModule(() => import("../llm_client.js"), (m) => {
    arm6("llm_client_module", () => m);
  });

  await bindModule(() => import("../memory_layer.js"), (m) => {
    arm6("memory_layer_module", () => m);
  });

  await bindModule(() => import("../goal_manager.js"), (m) => {
    arm6("goal_manager_module", () => m);
  });

  await bindModule(() => import("../git_trust.js"), (m) => {
    arm6("git_trust_module", () => m);
  });

  await bindModule(() => import("../risk_control.js"), (m) => {
    arm6("risk_control_module", () => ({
      ...m,
      get_risk_controller: () => risk_controller_face(m.get_risk_controller()),
    }));
  });

  await bindModule(() => import("../context_compactor.js"), (m) => {
    arm6("context_compactor_module", () => m);
  });

  await bindModule(() => import("../telemetry.js"), (m) => {
    arm6("telemetry_module", () => m);
  });

  await bindModule(() => import("../shadow_config.js"), (m) => {
    arm6("shadow_config_module", () => m);
  });

  await bindModule(() => import("../tools.js"), (m) => {
    arm6("tools_module", () => m);
  });

  await bindModule(() => import("../subagent_runtime.js"), (m) => {
    arm6("subagent_runtime_module", () => m);
  });

  await bindModule(() => import("../subagent_registry.js"), (m) => {
    arm6("subagent_registry_module", () => m);
  });

  await bindModule(() => import("../snapshot_store.js"), (m) => {
    arm6("snapshot_store_module", () => m);
  });

  await bindModule(() => import("../artifact_index.js"), (m) => {
    arm6("artifact_index_module", () => m);
  });

  await bindModule(() => import("../token_analytics.js"), (m) => {
    arm6("token_analytics_module", () => m);
  });

  await bindModule(() => import("./http_server_s8.js"), (m) => {
    arm6("router_for_request", (request: unknown) => m._git_router(request as any));
  });

  await bindModule(() => import("./http_server_s9.js"), (m) => {
    arm6("wire_scene_callbacks", (llm: unknown) => m._wire_scene_callbacks(llm));
  });
}

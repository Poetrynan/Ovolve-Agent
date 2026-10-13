/**
 * capabilities.ts — Capability Seam（Phase 6 首切片）。
 *
 * Ported from `app/backend/capabilities.py` (172 lines).
 *
 * 总指令 §11：不为插件化把代码拆成空接口，而是给既有 registries 一层边界
 * 清晰的 Protocol。本模块只做三件事：
 * 1. 八类 Provider 的最小协议（结构化鸭子类型）；
 * 2. ProviderRegistry：注册 / 查询 / **卸载撤销**，每个条目带 permissions 元数据；
 * 3. 加载隔离：单个 provider 注册失败不影响其它，失败原因如实上报。
 *
 * 插件、MCP、内置模块都走同一个 seam——绕过 seam 的能力注册在 review 里
 * 视为安全回归。
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖（result 已移植 → 静态 import）。
 *   §2  Python Protocol + runtime_checkable → TS interface + 运行时方法
 *       存在性检查（hasattr 语义）；`__protocol_attrs__` 反射在 JS 无等价，
 *       注册检查直接用源里已列出的方法名清单（源代码里硬编码的同一清单）。
 *   §2  Dict[tuple, ...] 复合键 → `${kind}\u0000${name}` 字符串键。
 *   §4  naming: capabilities.py → capabilities.ts
 *   §M  CPython 镜像单一来源：真值脸/repr/str/getattr 一律
 *       `import { py_truth, py_or, py_repr, py_str, py_getattr_or } from
 *       "./server/http_server_keys.js"`，本文件无私有镜像副本。
 *
 * PORT FIXES (backfill capab wave, bug-for-bug evidence:
 * tmp/capab_oracle_facts.json, pinned CPython 3.13.12 oracle run; pre-fix port
 * sha256_16 c987182c0ecadec7):
 *   (1) repr 文案（unknown kind / pname / missing 列表）按 CPython repr 引号规则，
 *       JSON.stringify 直出双引号是错的 → py_repr；`cannot override builtin` 走
 *       str() → py_str。
 *   (2) `getattr(...) or name`、`permissions or {}` 是 CPython 真值脸（[]/0/""/
 *       False 为假）→ py_getattr_or/py_or；`if not pname` → py_truth（JS ![] 与
 *       Python not [] 相反）。
 *   (3) PROTOCOLS.get(kind) 对继承键（"constructor"）恒 None → hasOwnProperty+
 *       typeof 护栏。
 *   (4) 元组键 (kind, pname) → kind + NUL + py_repr(pname) 拼成的字符串键（repr
 *       在探针值域内单射；5 与 5.0 同键 = CPython 5==5.0）。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { Result } from "./result.js";
import { py_getattr_or, py_or, py_repr, py_str, py_truth } from "./server/http_server_keys.js";

// ── 八类 Provider 协议（最小面：能被现有 registries 直接满足）────────────

export interface ToolProvider {
  name: string;
  tools(): unknown[];
  dispatch(name: string, args: Record<string, unknown>, ctx: Record<string, unknown>): unknown;
}

export interface ModelProvider {
  name: string;
  complete(messages: unknown[], kw?: Record<string, unknown>): unknown;
}

export interface MemoryProvider {
  name: string;
  retrieve(query: string, limit?: number): unknown[];
}

export interface ExecutionProvider {
  name: string;
  prepare(ctx: Record<string, unknown>): unknown;
  teardown(handle: unknown): void;
}

export interface SandboxProvider {
  name: string;
  confine(cmd: string[]): string[];
}

export interface ValidatorProvider {
  name: string;
  validators(): Record<string, unknown>;
}

export interface HookProvider {
  name: string;
  hooks(): Record<string, unknown>; // {"pre_tool_use": [fn, ...], ...}
}

export interface ChannelProvider {
  name: string;
  send(text: string, target: string): Result<unknown>;
}

/** 协议名 → 该协议要求的方法清单（源 __protocol_attrs__/dir(proto) 检查的
 * 硬编码等价物）。 */
const _PROTOCOL_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tool: ["tools", "dispatch"],
  model: ["complete"],
  memory: ["retrieve"],
  execution: ["prepare", "teardown"],
  sandbox: ["confine"],
  validator: ["validators"],
  hook: ["hooks"],
  channel: ["send"],
});

export const PROTOCOL_KINDS = Object.keys(_PROTOCOL_METHODS);

export class ProviderEntry {
  kind: string;
  // 源 self.name = pname 是 getattr-or 的原值（可以是 int 等），public() 直出
  name: unknown;
  provider: unknown;
  permissions: Record<string, unknown>;
  source: string; // builtin | plugin:<name> | mcp
  registered_at: number;

  constructor(
    kind: string,
    name: unknown,
    provider: unknown,
    permissions: unknown,
    source: string
  ) {
    this.kind = kind;
    this.name = name;
    this.provider = provider;
    // 源 `self.permissions = permissions or {}`（CPython 真值：[]/0/""/False 为假）
    this.permissions = py_or(permissions, {}) as Record<string, unknown>;
    this.source = source;
    this.registered_at = Date.now() / 1000;
  }

  public(): Record<string, unknown> {
    return {
      kind: this.kind,
      name: this.name,
      source: this.source,
      permissions: this.permissions,
      registeredAt: this.registered_at,
      // 卸载撤销的依据：来源不是 builtin 的才能被 unregister
      revocable: this.source !== "builtin",
    };
  }
}

/** 一个进程一张注册表。卸载即撤销——disable 插件时必须调 unregister，
 * 否则视为绕过 seam 的残留能力。 */
export class ProviderRegistry {
  _entries: Map<string, ProviderEntry>;

  constructor() {
    this._entries = new Map();
  }

  register(
    kind: string,
    provider: unknown,
    opts?: { name?: unknown; permissions?: unknown; source?: unknown }
  ): Result<Record<string, unknown>> {
    const { name = "", permissions = null, source = "builtin" } = opts ?? {};
    const methods =
      typeof kind === "string" && Object.prototype.hasOwnProperty.call(_PROTOCOL_METHODS, kind)
        ? _PROTOCOL_METHODS[kind]
        : undefined;
    if (methods === undefined) {
      return Result.failure(`unknown capability kind ${py_repr(kind)}`);
    }
    // 源 `pname = getattr(provider, "name", "") or name`（CPython 真值脸，原值直通，
    // 不 str() 化）；`if not pname` = py_truth（JS `![]` 与 Python `not []` 相反）。
    const pname = py_or(py_getattr_or(provider, "name", ""), name);
    if (!py_truth(pname)) {
      return Result.failure("provider needs a name (attr or argument)");
    }
    // 结构化鸭子检查：缺方法的 provider 在注册时就被拦下，而不是运行期炸
    // （源：`isinstance(proto, type) and not isinstance(provider, proto)` 之后
    //  dir(proto) ∩ 硬编码方法名清单；name 缺席只让 isinstance 为假、不进消息）。
    const missing = methods.filter((m) => {
      if (provider === null || provider === undefined) return true;
      if (typeof provider !== "object" && typeof provider !== "function") return true;
      return !(m in (provider as object));
    });
    if (missing.length > 0) {
      return Result.failure(
        `${kind} provider ${py_repr(pname)} does not satisfy the protocol: ` +
          `missing ${py_repr(missing)}`
      );
    }
    const key = `${kind}\u0000${py_repr(pname)}`;
    const prev = this._entries.get(key);
    if (prev !== undefined) {
      if (prev.source === "builtin") {
        return Result.failure(`cannot override builtin ${kind}:${py_str(pname)}`);
      }
      // 同名非内置：先撤销旧的（插件重载语义；dict 删后再插 = 键移到末尾）
      this._entries.delete(key);
    }
    const entry = new ProviderEntry(kind, pname, provider, permissions, source as string);
    this._entries.set(key, entry);
    return Result.success(entry.public());
  }

  /** 卸载撤销。builtin 能力不可撤销——那等于拔掉 Agent 的器官。 */
  unregister(kind: string, name: unknown, opts?: { actor?: unknown }): boolean {
    void opts;
    const key = `${kind}\u0000${py_repr(name)}`;
    const entry = this._entries.get(key);
    if (entry === undefined) {
      return false;
    }
    if (entry.source === "builtin") {
      return false;
    }
    this._entries.delete(key);
    return true;
  }

  get(kind: string, name: unknown): unknown {
    const e = this._entries.get(`${kind}\u0000${py_repr(name)}`);
    return e ? e.provider : null;
  }

  list(kind?: string | null): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const e of this._entries.values()) {
      if (kind === null || kind === undefined || e.kind === kind) {
        out.push(e.public());
      }
    }
    return out;
  }

  /** 插件禁用/移除时一次性撤销其全部贡献。返回撤销数量。 */
  revoke_source(source: string): number {
    const keys: string[] = [];
    for (const [k, e] of this._entries) {
      if (e.source === source) {
        keys.push(k);
      }
    }
    for (const k of keys) {
      this._entries.delete(k);
    }
    return keys.length;
  }
}

let _registry: ProviderRegistry | null = null;

export function get_provider_registry(): ProviderRegistry {
  if (_registry === null) {
    _registry = new ProviderRegistry();
  }
  return _registry;
}

export function reset_provider_registry(): void {
  _registry = null;
}

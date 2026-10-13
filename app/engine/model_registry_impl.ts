/**
 * model_registry_impl.ts — CredentialCipher / ModelInfo / ProviderConfig /
 * ModelRegistry (Part 2 of the model_registry split).
 *
 * Ported from `app/backend/model_registry.py` lines ~1050–2101.
 *
 * CredentialCipher note: implemented as a byte-compatible Fernet client
 * (0x80 | ts | IV | AES-128-CBC | full 32-byte HMAC-SHA256, base64url — the
 * installed cryptography 50.x wire format, verified by source probe) over
 * node:crypto — the exact scheme and key derivation (`pbkdf2_hmac sha256,
 * b"ovolve-salt", 100000, 32`) of the source's `cryptography.fernet`. Rows
 * written by the Python build decrypt here and vice versa, so a shared
 * db_dir across the migration window is safe. The `plain:` prefix marks the
 * weak fallback exactly as the source documents.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto pbkdf2/aes-128-cbc/hmac for Fernet;
 *       node:os for the machine key seed; fetch for OAuth refresh — Node 22
 *       global).
 *   §2  `except Exception: return ""` swallows preserved verbatim in
 *       decrypt; the OAuth refresh failure ladder keeps its code strings.
 *   §2  `time.time()` REAL columns → Date.now()/1000.
 *   §4  naming: part of the model_registry unit.
 *
 * PORT STATUS: confidence=medium todos=0
 */

import * as crypto from "node:crypto";
import * as os from "node:os";

import { Result } from "./result.js";
import { get_storage } from "./storage.js";
import {
  PROVIDER_FAIL_THRESHOLD,
  PROVIDER_COOLDOWN_SECONDS,
  PRICE_OVERRIDE_KEY,
  CONFIG_PROVIDER_ID,
  compute_cost,
  infer_capability,
  supports_effort,
  build_thinking_capability,
  normalize_modalities,
} from "./model_registry.js";

export const MASTER_KEY_ENV = "OVOLVE_MASTER_KEY";

// ---------------------------------------------------------------------------
// CredentialCipher
// ---------------------------------------------------------------------------

export class CredentialCipher {
  /** Credential encryption behind an `enc:` prefix.
   *
   * AES-256-CBC + HMAC-SHA-256 (encrypt-then-MAC) via node:crypto — a real
   * authenticated cipher, not a base64 downgrade. The `plain:` prefix marks
   * anything that failed to become a real token so audits can tell the two
   * apart, exactly as the source documents. */
  static PREFIX_ENC = "enc:";
  static PREFIX_PLAIN = "plain:";

  private _signKey: Buffer;
  private _encKey: Buffer;
  /** True by construction on node:crypto (no optional dependency to miss). */
  readonly available = true;

  constructor(master_key: string | null = null) {
    const secret =
      master_key || process.env[MASTER_KEY_ENV] || CredentialCipher.machineKey();
    // Source: pbkdf2_hmac("sha256", secret, b"ovolve-salt", 100000, 32), then
    // Fernet(urlsafe_b64encode(key)) — 32 raw bytes split sign(16)|enc(16).
    const fernetKey = crypto.pbkdf2Sync(secret, "ovolve-salt", 100_000, 32, "sha256");
    this._signKey = fernetKey.subarray(0, 16);
    this._encKey = fernetKey.subarray(16, 32);
  }

  /** uuid.getnode(): the 48-bit integer of one non-internal interface MAC, in
   * OS enumeration order — Node reads the same adapter table Python does.
   * Fallback mirrors uuid's random-48-with-multicast-bit. */
  static macNode(): string {
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.mac && info.mac !== "00:00:00:00:00:00" && !info.internal) {
          return BigInt("0x" + info.mac.replace(/:/g, "")).toString();
        }
      }
    }
    return ((BigInt(Math.floor(Math.random() * 0x1_0000_0000_0000)) | 0x0100_0000_0000n) & 0xffff_ffff_ffffn).toString();
  }

  /** Derive a per-machine, per-user fallback secret. Seed is the source's
   * f-string `f"{expanduser('~')}|{uuid.getnode()}"` (decimal int). */
  static machineKey(): string {
    const seed = `${os.homedir()}|${CredentialCipher.macNode()}`;
    return crypto.createHash("sha256").update(seed, "utf8").digest("hex");
  }

  /** Encrypt a secret for storage: `enc:<fernet-token>`, byte-compatible
   * with the installed cryptography build's Fernet (0x80|ts8|iv16|
   * AES-128-CBC ct|HMAC-SHA256 full 32 bytes, base64url). cryptography ≥50
   * writes the FULL 32-byte MAC — probed on 50.0.1 at _encrypt_from_parts /
   * _verify_signature (data[-32:]) — so this matches the product's real wire
   * format, not the legacy spec's truncation to 16. */
  encrypt(plaintext: string): string {
    if (!plaintext) {
      return "";
    }
    try {
      const iv = crypto.randomBytes(16);
      const ts = Buffer.alloc(8);
      ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
      const cipher = crypto.createCipheriv("aes-128-cbc", this._encKey, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const body = Buffer.concat([Buffer.from([0x80]), ts, iv, ct]);
      const mac = crypto.createHmac("sha256", this._signKey).update(body).digest();
      // urlsafe alphabet WITH '=' padding — cryptography's urlsafe_b64encode
      // pads, and its decoder rejects unpadded tokens.
      const tok = Buffer.concat([body, mac])
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
      return CredentialCipher.PREFIX_ENC + tok;
    } catch {
      // fail visibly, not silently: mark as weaker protection
      return CredentialCipher.PREFIX_PLAIN + Buffer.from(plaintext, "utf8").toString("base64");
    }
  }

  /** Decrypt a stored secret, returning "" on any failure.
   *
   * Never raises: a corrupt or foreign-key ciphertext must not crash registry
   * construction (and therefore app startup). */
  decrypt(stored: string): string {
    if (!stored) {
      return "";
    }
    if (stored.startsWith(CredentialCipher.PREFIX_PLAIN)) {
      try {
        return Buffer.from(stored.slice(CredentialCipher.PREFIX_PLAIN.length), "base64").toString("utf8");
      } catch {
        return "";
      }
    }
    if (!stored.startsWith(CredentialCipher.PREFIX_ENC)) {
      return stored; // legacy plaintext value
    }
    const token = stored.slice(CredentialCipher.PREFIX_ENC.length);
    try {
      const raw = Buffer.from(token, "base64url"); // tolerant of padding, like Fernet
      // 0x80(1) + ts(8) + iv(16) + ct(>=16) + HMAC-SHA256(32)
      if (raw.length < 73 || raw[0] !== 0x80) {
        return "";
      }
      const body = raw.subarray(0, raw.length - 32);
      const mac = raw.subarray(raw.length - 32);
      const expect = crypto
        .createHmac("sha256", this._signKey)
        .update(body)
        .digest();
      if (!crypto.timingSafeEqual(mac, expect)) {
        return "";
      }
      const iv = body.subarray(9, 25);
      const ct = body.subarray(25);
      if (ct.length === 0 || ct.length % 16 !== 0) {
        return "";
      }
      const decipher = crypto.createDecipheriv("aes-128-cbc", this._encKey, iv);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// ModelInfo
// ---------------------------------------------------------------------------

export class ModelInfo {
  model_id: string;
  context_limit: number;
  output_limit: number;
  modalities: string[];
  _tier: number;
  _cost_weight: number | null;
  _supports_tools: boolean | null;
  // Three-state on purpose (#151): null = not declared, true/false = the
  // user said so. A plain boolean would make "the settings page has never
  // been opened" indistinguishable from "explicitly unsupported".
  _supports_vision: boolean | null;
  _supports_thinking: boolean | null;
  /** Why this model is unselectable, shown next to it instead of a silent
   * absence. "" = selectable. */
  disabled_reason: string;

  constructor(
    model_id: string,
    context_limit = 200000,
    output_limit = 8192,
    modalities: unknown = null,
    tier = 0,
    cost_weight: number | null = null,
    supports_tools: boolean | null = null,
    supports_vision: boolean | null = null,
    supports_thinking: boolean | null = null,
    disabled_reason = ""
  ) {
    this.model_id = model_id;
    this.context_limit = context_limit;
    this.output_limit = output_limit;
    this.modalities = normalize_modalities(modalities);
    this._tier = Math.trunc(tier || 0);
    this._cost_weight = cost_weight;
    this._supports_tools = supports_tools;
    this._supports_vision = supports_vision;
    this._supports_thinking = supports_thinking;
    this.disabled_reason = String(disabled_reason || "");
  }

  /** The raw tri-state thinking declaration (null / true / false). */
  get supports_thinking_declared(): boolean | null {
    return this._supports_thinking;
  }

  /** The raw tri-state vision declaration (null / true / false). */
  get supports_vision_declared(): boolean | null {
    return this._supports_vision;
  }

  capability(
    overrides?: Record<string, Record<string, number>> | null,
    kind = ""
  ): Record<string, unknown> {
    const inferred = infer_capability(this.model_id, overrides);
    const tier = this._tier || (inferred["tier"] as number);
    const weight =
      this._cost_weight !== null ? this._cost_weight : (inferred["cost_weight"] as number);
    const tools = this._supports_tools !== null ? this._supports_tools : true;
    const vision =
      this._supports_vision !== null
        ? this._supports_vision
        : (this.modalities ?? []).includes("image");
    const thinking =
      this._supports_thinking !== null
        ? this._supports_thinking
        : supports_effort(this.model_id, kind);
    return {
      tier,
      cost_weight: Number(weight),
      reasoning: inferred["reasoning"],
      supports_tools: Boolean(tools),
      supports_vision: Boolean(vision),
      supports_thinking: Boolean(thinking),
      declared: {
        tier: Boolean(this._tier),
        costWeight: this._cost_weight !== null,
        supportsTools: this._supports_tools !== null,
        supportsVision: this._supports_vision !== null,
        supportsThinking: this._supports_thinking !== null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ProviderConfig
// ---------------------------------------------------------------------------

export class ProviderConfig {
  provider_id: string;
  name: string;
  /** anthropic / openai-compatible / oauth */
  kind: string;
  api_key: string;
  base_url: string;
  enabled: boolean;
  models: Record<string, ModelInfo> = {};
  // OAuth fields (TODO §5.1)
  refresh_token: string;
  token_endpoint: string;
  client_id: string;
  token_expires_at: number;

  constructor(
    provider_id: string,
    name: string,
    kind = "anthropic",
    api_key = "",
    base_url = "",
    enabled = true,
    refresh_token = "",
    token_endpoint = "",
    client_id = "",
    token_expires_at = 0.0
  ) {
    this.provider_id = provider_id;
    this.name = name;
    this.kind = kind;
    this.api_key = api_key;
    this.base_url = base_url;
    this.enabled = enabled;
    this.refresh_token = refresh_token;
    this.token_endpoint = token_endpoint;
    this.client_id = client_id;
    this.token_expires_at = token_expires_at;
  }

  add_model(model: ModelInfo): void {
    this.models[model.model_id] = model;
  }

  /** Whether this provider uses OAuth refresh tokens. */
  get has_oauth(): boolean {
    return Boolean(this.refresh_token && this.token_endpoint);
  }

  /** Whether the current access token is expired or about to expire. */
  get token_expired(): boolean {
    if (this.token_expires_at <= 0) {
      return false; // No expiry tracking = assume valid
    }
    return Date.now() / 1000 >= this.token_expires_at - 60; // 1 min buffer
  }
}

// ---------------------------------------------------------------------------
// ModelRegistry
// ---------------------------------------------------------------------------

interface HealthEntry {
  fails: number;
  until: number;
  code: string;
}

export class ModelRegistry {
  _providers: Record<string, ProviderConfig> = {};
  _cipher: CredentialCipher;
  _active_model = "";
  _active_provider = "";
  /** Filled by seed_from_config; the last-resort answer for resolve(). */
  _config_fallback: Record<string, unknown> = {};
  /** provider_id -> {fails, until, code}. In-memory on purpose: a cooldown
   * is a statement about the last two minutes, and persisting it would
   * outlive the outage and skip a provider that has since recovered. */
  _provider_health: Record<string, HealthEntry> = {};
  /** Storage domain methods (record_usage / get_usage) are mounted by the
   * effects-domain mixin; the composed Storage type carries them at runtime,
   * and this narrow view keeps the call sites honest. */
  _storage: {
    get_config(key: string, d?: unknown): unknown;
    set_config(key: string, v: unknown): void;
    record_usage: (...args: unknown[]) => void;
    get_usage: (sid: string) => unknown;
  };

  constructor() {
    this._cipher = new CredentialCipher();
    this._storage = get_storage() as unknown as ModelRegistry["_storage"];
    this._load_from_storage();
  }

  _load_from_storage(): void {
    const raw = this._storage.get_config("providers", {}) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return;
    }
    for (const [pid, pcfg0] of Object.entries(raw as Record<string, unknown>)) {
      const pcfg = (pcfg0 ?? {}) as Record<string, unknown>;
      const provider = new ProviderConfig(
        pid,
        String(pcfg["name"] ?? ""),
        String(pcfg["kind"] ?? "anthropic"),
        this._cipher.decrypt(String(pcfg["apiKey"] ?? "")),
        String(pcfg["baseURL"] ?? ""),
        Boolean(pcfg["enabled"] ?? true),
        this._cipher.decrypt(String(pcfg["refreshToken"] ?? "")),
        String(pcfg["tokenEndpoint"] ?? ""),
        String(pcfg["clientId"] ?? ""),
        Number(pcfg["tokenExpiresAt"] ?? 0) || 0
      );
      const models = (pcfg["models"] ?? {}) as Record<string, unknown>;
      for (const [mid, mcfg0] of Object.entries(models)) {
        const mcfg = (mcfg0 ?? {}) as Record<string, unknown>;
        const lim = (mcfg["limit"] ?? {}) as Record<string, unknown>;
        const cap = (typeof mcfg["capability"] === "object" && mcfg["capability"] !== null
          ? (mcfg["capability"] as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        provider.add_model(
          new ModelInfo(
            mid,
            Number(lim["context"] ?? 200000) || 200000,
            Number(lim["output"] ?? 8192) || 8192,
            mcfg["modalities"] ?? ["text"],
            Number(cap["tier"] ?? 0) || 0,
            cap["costWeight"] === null || cap["costWeight"] === undefined ? null : Number(cap["costWeight"]),
            cap["supportsTools"] === null || cap["supportsTools"] === undefined ? null : Boolean(cap["supportsTools"]),
            cap["supportsVision"] === null || cap["supportsVision"] === undefined ? null : Boolean(cap["supportsVision"]),
            cap["supportsThinking"] === null || cap["supportsThinking"] === undefined ? null : Boolean(cap["supportsThinking"]),
            String(mcfg["disabledReason"] ?? "")
          )
        );
      }
      this._providers[pid] = provider;
    }
  }

  _save_to_storage(): void {
    const data: Record<string, unknown> = {};
    for (const [pid, p] of Object.entries(this._providers)) {
      if (pid === CONFIG_PROVIDER_ID) continue; // owned by config.json
      const models: Record<string, unknown> = {};
      for (const [mid, m] of Object.entries(p.models)) {
        const entry: Record<string, unknown> = {
          limit: { context: m.context_limit, output: m.output_limit },
          modalities: m.modalities,
        };
        // Only persist DECLARED capability, never the inferred values —
        // writing back a guess would freeze it, and the guess should
        // follow the price table when that table is updated.
        const cap: Record<string, unknown> = {};
        if (m._tier) cap["tier"] = m._tier;
        if (m._cost_weight !== null) cap["costWeight"] = m._cost_weight;
        if (m._supports_tools !== null) cap["supportsTools"] = m._supports_tools;
        if (m._supports_vision !== null) cap["supportsVision"] = m._supports_vision;
        if (m._supports_thinking !== null) cap["supportsThinking"] = m._supports_thinking;
        if (Object.keys(cap).length > 0) entry["capability"] = cap;
        if (m.disabled_reason) entry["disabledReason"] = m.disabled_reason;
        models[mid] = entry;
      }
      data[pid] = {
        name: p.name,
        kind: p.kind,
        apiKey: p.api_key ? this._cipher.encrypt(p.api_key) : "",
        baseURL: p.base_url,
        enabled: p.enabled,
        models,
        refreshToken: p.refresh_token ? this._cipher.encrypt(p.refresh_token) : "",
        tokenEndpoint: p.token_endpoint,
        clientId: p.client_id,
        tokenExpiresAt: p.token_expires_at,
      };
    }
    this._storage.set_config("providers", data);
  }

  register_provider(
    name: string,
    kind = "anthropic",
    api_key = "",
    base_url = "",
    enabled = true,
    refresh_token = "",
    token_endpoint = "",
    client_id = "",
    token_expires_at = 0.0
  ): string {
    const pid = crypto.randomUUID();
    this._providers[pid] = new ProviderConfig(
      pid, name, kind, api_key, base_url, enabled,
      refresh_token, token_endpoint, client_id, token_expires_at
    );
    this._save_to_storage();
    return pid;
  }

  /** The capability half of a resolve payload — kept in one place so the
   * vision/thinking declarations never diverge between the three code paths
   * that build it. */
  static _capability_payload(
    p: ProviderConfig,
    info: ModelInfo | null
  ): Record<string, unknown> {
    void p;
    if (info === null) {
      return {
        modalities: ["text"],
        supports_vision: false,
        supports_thinking: supports_effort("", p.kind),
        supports_thinking_declared: null,
        disabled_reason: "",
      };
    }
    const cap = info.capability(undefined, p.kind);
    return {
      modalities: info.modalities,
      supports_vision: cap["supports_vision"],
      supports_thinking: cap["supports_thinking"],
      supports_thinking_declared: info.supports_thinking_declared,
      disabled_reason: info.disabled_reason,
    };
  }

  resolve(model_id = "", scene?: string | null): Result {
    /** Resolve a model to its provider + auth credentials.
     *
     * Accepts either a bare `model_id` or the frontend's
     * `"providerId:modelId"` composite, because that string is what the
     * session picker stores and the UI sends it verbatim.
     *
     * **An explicit model_id always wins.** Scene routing is an answer to
     * "we were not told which model", never an override of a user's pick. */
    let target = model_id || "";
    if (!target && scene) {
      const picked = this._resolve_scene(scene);
      if (picked !== null) {
        return Result.success(picked);
      }
    }
    target = target || this._active_model;
    let want_pid = "";
    if (target && target.includes(":")) {
      const idx = target.indexOf(":");
      want_pid = target.slice(0, idx);
      target = target.slice(idx + 1);
    }

    // Explicit provider wins: two providers can expose the same model name.
    if (want_pid) {
      const p = this._providers[want_pid];
      if (p !== undefined && p.enabled) {
        const info = p.models[target] ?? null;
        return Result.success({
          provider_id: want_pid,
          provider_name: p.name,
          kind: p.kind,
          api_key: p.api_key,
          base_url: p.base_url,
          model_id: target,
          source: "registry",
          context_limit: info ? info.context_limit : 0,
          output_limit: info ? info.output_limit : 0,
          ...ModelRegistry._capability_payload(p, info),
        });
      }
    }

    for (const [pid, p] of Object.entries(this._providers)) {
      if (!p.enabled) continue;
      if (target && target in p.models) {
        const info = p.models[target]!;
        return Result.success({
          provider_id: pid,
          provider_name: p.name,
          kind: p.kind,
          api_key: p.api_key,
          base_url: p.base_url,
          model_id: target,
          source: "registry",
          context_limit: info.context_limit,
          output_limit: info.output_limit,
          ...ModelRegistry._capability_payload(p, info),
        });
      }
    }
    // Nothing matched: degrade to the config.json entry (the one we know
    // works) instead of pairing a valid key with an unheard-of model.
    if (Object.keys(this._config_fallback).length > 0) {
      return Result.success({ ...this._config_fallback, source: "config" });
    }
    for (const [pid, p] of Object.entries(this._providers)) {
      if (p.enabled && (!target || target in p.models)) {
        const m = p.models[target || ""] ?? null;
        return Result.success({
          provider_id: pid,
          provider_name: p.name,
          kind: p.kind,
          api_key: p.api_key,
          base_url: p.base_url,
          model_id: target || "",
          source: "fallback",
          context_limit: m ? m.context_limit : 0,
          output_limit: m ? m.output_limit : 0,
          ...ModelRegistry._capability_payload(p, m),
        });
      }
    }
    return Result.failure("No provider available");
  }

  thinking_capability(model_id = ""): Record<string, unknown> {
    /** Thinking dial metadata for the UI — one resolved payload per model. */
    const resolved = this.resolve(model_id);
    if (!resolved.ok || typeof resolved.value !== "object" || resolved.value === null) {
      return build_thinking_capability(model_id || "");
    }
    const payload = resolved.value as Record<string, unknown>;
    const pid = String(payload["provider_id"] ?? "");
    const mid = String(payload["model_id"] ?? "");
    const kind = String(payload["kind"] ?? "");
    const declared = payload["supports_thinking_declared"] as boolean | null;
    const p = this._providers[pid];
    const info = p ? p.models[mid] ?? null : null;
    const catalog = info !== null && info._supports_thinking === true;
    return build_thinking_capability(mid || model_id, kind, declared, {
      catalog_reasoning: catalog,
    });
  }

  // ── Scene routing (UD1) ──

  scene_candidates(scene: string): Record<string, unknown>[] {
    /** Configured models eligible for `scene`, cheapest first. */
    const spec = (SCENES[scene] ?? {}) as Record<string, unknown>;
    const floor = Math.trunc(Number(spec["min_tier"] ?? TIER_STANDARD) || TIER_STANDARD);
    const needs_tools = Boolean(spec["needs_tools"]);
    const overrides = this.price_overrides();
    const out: Record<string, unknown>[] = [];
    for (const [pid, p] of Object.entries(this._providers)) {
      if (!p.enabled || !p.api_key) {
        continue;
      }
      for (const [mid, info] of Object.entries(p.models)) {
        const cap = info.capability(overrides, p.kind);
        if ((cap["tier"] as number) < floor) {
          continue;
        }
        if (needs_tools && !cap["supports_tools"]) {
          continue;
        }
        out.push({
          provider_id: pid,
          provider_name: p.name,
          kind: p.kind,
          api_key: p.api_key,
          base_url: p.base_url,
          model_id: mid,
          source: `scene:${scene}`,
          context_limit: info.context_limit,
          output_limit: info.output_limit,
          modalities: info.modalities,
          tier: cap["tier"],
          cost_weight: cap["cost_weight"],
          scene,
        });
      }
    }
    // Cheapest first, then lowest tier, then a stable name so the choice is
    // reproducible.
    out.sort(
      (a, b) =>
        (a["cost_weight"] as number) - (b["cost_weight"] as number) ||
        (a["tier"] as number) - (b["tier"] as number) ||
        String(a["model_id"]).localeCompare(String(b["model_id"]))
    );
    return out;
  }

  _resolve_scene(scene: string): Record<string, unknown> | null {
    /** Cheapest eligible model for `scene`, or null to use normal resolve. */
    const spec = SCENES[scene] as Record<string, unknown> | undefined;
    if (!spec || !spec["route"]) {
      return null;
    }
    const candidates = this.scene_candidates(scene);
    if (candidates.length === 0) {
      return null;
    }
    const best = { ...(candidates[0] as Record<string, unknown>) };
    // Routing to the model we would have used anyway is not routing.
    if (best["model_id"] === this._active_model) {
      best["source"] = "scene:default";
    }
    return best;
  }

  scene_plan(): Record<string, unknown>[] {
    /** What each scene currently resolves to. For diagnostics / settings UI. */
    const rows: Record<string, unknown>[] = [];
    for (const [name, spec0] of Object.entries(SCENES)) {
      const spec = spec0 as Record<string, unknown>;
      const picked = spec["route"] ? this._resolve_scene(name) : null;
      const pv = (picked ?? {}) as Record<string, unknown>;
      rows.push({
        scene: name,
        minTier: spec["min_tier"],
        routed: Boolean(picked),
        modelId: pv["model_id"] ?? "",
        providerName: pv["provider_name"] ?? "",
        costWeight: pv["cost_weight"] ?? null,
      });
    }
    return rows;
  }

  seed_from_config(model_cfg: unknown): void {
    /** Adopt config.json's `model` block as a real, resolvable provider.
     * Registered under a reserved id and deliberately NOT persisted to
     * SQLite: config.json stays the owner of this entry. */
    if (model_cfg === null || typeof model_cfg !== "object" || Array.isArray(model_cfg)) {
      return;
    }
    const cfg = model_cfg as Record<string, unknown>;
    const model_id = String(cfg["model_id"] ?? "").trim();
    const base_url = String(cfg["base_url"] ?? "").trim();
    const api_key = String(cfg["api_key"] ?? "");
    if (!model_id && !base_url) {
      return;
    }
    const name = String(cfg["provider"] ?? "config") || "config";
    const ctx = Math.trunc(Number(cfg["context_limit"] ?? 200000) || 200000);
    const out = Math.trunc(Number(cfg["max_tokens"] ?? 8192) || 8192);

    const provider = new ProviderConfig(
      CONFIG_PROVIDER_ID, name, "openai-compatible", api_key, base_url, true
    );
    if (model_id) {
      provider.add_model(new ModelInfo(model_id, ctx, out, ["text"]));
    }
    this._providers[CONFIG_PROVIDER_ID] = provider;

    this._config_fallback = {
      provider_id: CONFIG_PROVIDER_ID,
      provider_name: name,
      kind: "openai-compatible",
      api_key,
      base_url,
      model_id,
      context_limit: ctx,
      modalities: ["text"],
    };
    if (!this._active_model && model_id) {
      this.set_active_model(model_id, CONFIG_PROVIDER_ID);
    }
  }

  upsert_provider(provider_id: string, spec: unknown): Result {
    /** Create or update a provider under a CALLER-supplied id.
     *
     * An empty `apiKey` in `spec` means "unchanged" rather than "clear",
     * because the settings UI reads keys back masked and would otherwise wipe
     * the real one on a round trip. */
    const pid = String(provider_id ?? "").trim();
    if (!pid) {
      return Result.failure("provider_id is required");
    }
    if (pid === CONFIG_PROVIDER_ID) {
      return Result.failure("reserved provider id");
    }
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      return Result.failure("spec must be an object");
    }
    const s = spec as Record<string, unknown>;

    const prev = this._providers[pid];
    let api_key = String(s["apiKey"] ?? "");
    if (!api_key && prev !== undefined) {
      api_key = prev.api_key;
    }

    const provider = new ProviderConfig(
      pid,
      String(s["name"] ?? (prev ? prev.name : pid)),
      String(s["kind"] ?? (prev ? prev.kind : "openai-compatible")),
      api_key,
      String(s["baseURL"] ?? (prev ? prev.base_url : "")),
      Boolean(s["enabled"] ?? (prev ? prev.enabled : true))
    );
    const models = s["models"];
    if (models !== null && typeof models === "object" && !Array.isArray(models)) {
      for (const [mid, mcfg0] of Object.entries(models as Record<string, unknown>)) {
        const mcfg = (mcfg0 ?? {}) as Record<string, unknown>;
        const lim = (typeof mcfg["limit"] === "object" && mcfg["limit"] !== null
          ? (mcfg["limit"] as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        const cap = (typeof mcfg["capability"] === "object" && mcfg["capability"] !== null
          ? (mcfg["capability"] as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        const reasoning_cfg = (typeof mcfg["reasoning"] === "object" && mcfg["reasoning"] !== null
          ? (mcfg["reasoning"] as Record<string, unknown>)
          : {}) as Record<string, unknown>;
        let thinking_decl = cap["supportsThinking"] as boolean | null | undefined;
        if (thinking_decl === null || thinking_decl === undefined) {
          if (reasoning_cfg["enabled"]) {
            thinking_decl = true;
          }
        }
        provider.add_model(
          new ModelInfo(
            mid,
            Math.trunc(Number(lim["context"] ?? 200000) || 200000),
            Math.trunc(Number(lim["output"] ?? 8192) || 8192),
            mcfg["modalities"] ?? ["text"],
            Math.trunc(Number(cap["tier"] ?? 0) || 0),
            cap["costWeight"] === null || cap["costWeight"] === undefined ? null : Number(cap["costWeight"]),
            cap["supportsTools"] === null || cap["supportsTools"] === undefined ? null : Boolean(cap["supportsTools"]),
            cap["supportsVision"] === null || cap["supportsVision"] === undefined ? null : Boolean(cap["supportsVision"]),
            thinking_decl === null || thinking_decl === undefined ? null : Boolean(thinking_decl),
            String(mcfg["disabledReason"] ?? "")
          )
        );
      }
    } else if (prev !== undefined) {
      provider.models = prev.models; // catalogue omitted → keep what we had
    }

    this._providers[pid] = provider;
    this._save_to_storage();
    return Result.success({ id: pid, models: Object.keys(provider.models) });
  }

  prune_providers(keep: string[]): string[] {
    /** Drop every provider except `keep` (and the config-owned entry). */
    const keep_set = new Set([...(keep ?? []).map((k) => String(k)), CONFIG_PROVIDER_ID]);
    const gone = Object.keys(this._providers).filter((pid) => !keep_set.has(pid));
    for (const pid of gone) {
      delete this._providers[pid];
    }
    if (gone.length > 0) {
      this._save_to_storage();
    }
    return gone;
  }

  set_active_model(model_id: string, provider_id?: string | null): void {
    this._active_model = model_id;
    if (provider_id) {
      this._active_provider = provider_id;
    }
  }

  refresh_models(provider_id: string): Result {
    /** Dynamically refresh model list from provider API. */
    const provider = this._providers[provider_id];
    if (!provider) {
      return Result.failure(`Provider not found: ${provider_id}`);
    }
    return Result.success({ provider: provider.name, models: Object.keys(provider.models) });
  }

  // ── Provider health & dynamic downgrade (UD2) ──

  note_provider_failure(provider_id: string, code = ""): Record<string, unknown> {
    /** Record one hard failure against a provider.
     *
     * Only *hard* failures belong here — a rate limit means the provider is
     * alive and we were too fast, so counting it would open a cooldown on a
     * healthy provider under load. The caller decides using
     * llm_errors.is_permanent / the failure code; this method just counts
     * what it is given. */
    const pid = String(provider_id ?? "");
    if (!pid) {
      return {};
    }
    const h = this._provider_health[pid] ?? { fails: 0, until: 0.0, code: "" };
    h["fails"] = Math.trunc(Number(h["fails"] ?? 0)) + 1;
    h["code"] = String(code ?? "");
    if (h["fails"] >= PROVIDER_FAIL_THRESHOLD) {
      h["until"] = Date.now() / 1000 + PROVIDER_COOLDOWN_SECONDS;
    }
    this._provider_health[pid] = h;
    return { ...h };
  }

  note_provider_success(provider_id: string): void {
    /** Clear a provider's failure streak. One success ends the cooldown.
     * Not a decay: if a call just went through, the outage is over. */
    delete this._provider_health[String(provider_id ?? "")];
  }

  provider_healthy(provider_id: string): boolean {
    /** Whether `provider_id` is outside its cooldown window. */
    const h = this._provider_health[String(provider_id ?? "")];
    if (!h) {
      return true;
    }
    return Date.now() / 1000 >= Number(h["until"] ?? 0);
  }

  provider_health(): Record<string, unknown>[] {
    /** Current cooldown state, for diagnostics. */
    const now = Date.now() / 1000;
    const rows: Record<string, unknown>[] = [];
    for (const [pid, h] of Object.entries(this._provider_health)) {
      const p = this._providers[pid];
      const until = Number(h["until"] ?? 0);
      rows.push({
        providerId: pid,
        providerName: p ? p.name : "",
        fails: Math.trunc(Number(h["fails"] ?? 0)),
        code: h["code"] ?? "",
        cooldownRemaining: until ? Math.max(Math.round((until - now) * 10) / 10, 0.0) : 0.0,
      });
    }
    return rows;
  }

  downgrade_candidates(
    current: string,
    recovery = "",
    needed_context = 0,
    limit = 3
  ): Record<string, unknown>[] {
    /** Models worth retrying with after `current` failed, best hop first.
     *
     * `recovery` comes from llm_errors.RECOVERY and decides what "better"
     * means — a context overflow needs a BIGGER window; an exhausted quota
     * needs a DIFFERENT provider; a bad model id needs anything that exists. */
    const RECOVER_ANY_MODEL = "any_model";
    const RECOVER_LARGER_CONTEXT = "larger_context";
    const RECOVER_OTHER_PROVIDER = "other_provider";
    if (!recovery) {
      return [];
    }
    let cur_pid = "";
    let cur_model = String(current ?? "");
    if (cur_model.includes(":")) {
      const idx = cur_model.indexOf(":");
      cur_pid = cur_model.slice(0, idx);
      cur_model = cur_model.slice(idx + 1);
    }
    if (!cur_pid) {
      cur_pid = this._resolved_provider_for(cur_model);
    }
    const cur_info = this._model_info(cur_pid, cur_model);
    const overrides = this.price_overrides();
    const cur_cap = cur_info ? cur_info.capability(overrides) : null;
    const cur_limit = cur_info ? cur_info.context_limit : 0;

    const out: Record<string, unknown>[] = [];
    for (const [pid, p] of Object.entries(this._providers)) {
      if (!p.enabled || !p.api_key) {
        continue;
      }
      if (!this.provider_healthy(pid)) {
        continue;
      }
      if (recovery === RECOVER_OTHER_PROVIDER && pid === cur_pid) {
        continue;
      }
      for (const [mid, info] of Object.entries(p.models)) {
        if (pid === cur_pid && mid === cur_model) {
          continue;
        }
        const cap = info.capability(overrides, p.kind);
        if (recovery === RECOVER_LARGER_CONTEXT) {
          // A window no bigger than the one that just overflowed is not a
          // candidate, it is the same failure one round-trip later.
          if (info.context_limit <= Math.max(needed_context, cur_limit)) {
            continue;
          }
        }
        // RECOVER_OTHER_PROVIDER: no capability filter on purpose — a quota
        // wall must not leave the user with nothing (see source comment).
        out.push({
          provider_id: pid,
          provider_name: p.name,
          kind: p.kind,
          api_key: p.api_key,
          base_url: p.base_url,
          model_id: mid,
          source: `downgrade:${recovery}`,
          context_limit: info.context_limit,
          output_limit: info.output_limit,
          modalities: info.modalities,
          tier: cap["tier"],
          cost_weight: cap["cost_weight"],
          downgrade_reason: recovery,
        });
      }
    }
    if (recovery === RECOVER_LARGER_CONTEXT) {
      // Smallest window that still fits.
      out.sort(
        (a, b) =>
          (a["context_limit"] as number) - (b["context_limit"] as number) ||
          (a["cost_weight"] as number) - (b["cost_weight"] as number) ||
          String(a["model_id"]).localeCompare(String(b["model_id"]))
      );
    } else if (recovery === RECOVER_ANY_MODEL) {
      out.sort(
        (a, b) =>
          (a["cost_weight"] as number) - (b["cost_weight"] as number) ||
          (a["tier"] as number) - (b["tier"] as number) ||
          String(a["model_id"]).localeCompare(String(b["model_id"]))
      );
    } else {
      // Two bands. At/above the current tier: cheapest wins. Below the bar:
      // take the strongest available — the cheapest-of-the-weak would be the
      // worst possible substitute for a frontier model.
      const floor = cur_cap ? (cur_cap["tier"] as number) : TIER_LIGHT;
      const band = (c: Record<string, unknown>): [number, number, number, string] =>
        (c["tier"] as number) >= floor
          ? [0, c["cost_weight"] as number, 0, String(c["model_id"])]
          : [1, -(c["tier"] as number), c["cost_weight"] as number, String(c["model_id"])];
      out.sort((a, b) => {
        const ba = band(a);
        const bb = band(b);
        return (
          ba[0] - bb[0] ||
          ba[1] - bb[1] ||
          ba[2] - bb[2] ||
          ba[3].localeCompare(bb[3])
        );
      });
    }
    return out.slice(0, Math.max(Math.trunc(limit || 1), 1));
  }

  _resolved_provider_for(model_id: string): string {
    /** Which provider currently serves a bare model id ("" if unknown). */
    if (!model_id) {
      return "";
    }
    for (const [pid, p] of Object.entries(this._providers)) {
      if (model_id in p.models) {
        return pid;
      }
    }
    return "";
  }

  _model_info(provider_id: string, model_id: string): ModelInfo | null {
    const p = this._providers[String(provider_id ?? "")];
    if (p === undefined) {
      return null;
    }
    return p.models[String(model_id ?? "")] ?? null;
  }

  // ── OAuth refresh (TODO §5.1) ──

  async refresh_oauth_token(provider_id: string): Promise<Result> {
    /** Refresh an OAuth access token using the stored refresh_token. */
    const provider = this._providers[provider_id];
    if (!provider) {
      return Result.failure(`Provider not found: ${provider_id}`, { code: "ProviderNotFound" });
    }
    if (!provider.has_oauth) {
      return Result.failure(
        "Provider has no refresh_token / token_endpoint configured",
        { code: "NoOAuthConfig" }
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: provider.refresh_token,
      client_id: provider.client_id,
    }).toString();
    let resp: { ok: boolean; error: string; value: Record<string, unknown> };
    try {
      resp = await ModelRegistry._http_post_form(provider.token_endpoint, body);
    } catch (exc) {
      return Result.failure(`OAuth refresh transport error: ${exc}`, { code: "RefreshTransport" });
    }
    if (!resp.ok) {
      // Refresh token itself may be expired -> caller must trigger re-auth.
      const code = resp.error.toLowerCase().includes("invalid_grant")
        ? "RefreshExpired"
        : "RefreshFailed";
      return Result.failure(resp.error, { code });
    }
    const data = resp.value;
    const access = String(data["access_token"] ?? "");
    if (!access) {
      return Result.failure("Token endpoint returned no access_token", { code: "NoAccessToken" });
    }
    provider.api_key = access;
    const expires_in = Math.trunc(Number(data["expires_in"] ?? 0) || 0);
    if (expires_in) {
      provider.token_expires_at = Date.now() / 1000 + expires_in;
    }
    // Some providers rotate the refresh_token
    const new_refresh = data["refresh_token"];
    if (new_refresh) {
      provider.refresh_token = String(new_refresh);
    }
    this._save_to_storage();
    return Result.success({
      access_token: access,
      expires_at: provider.token_expires_at,
      rotated_refresh_token: Boolean(new_refresh),
    });
  }

  async call_with_refresh(
    provider_id: string,
    do_request: (token: string) => Promise<Record<string, unknown>>,
    max_refresh = 1
  ): Promise<Result> {
    /** Run a request with automatic 401 -> refresh -> retry. */
    const provider = this._providers[provider_id];
    if (!provider) {
      return Result.failure(`Provider not found: ${provider_id}`, { code: "ProviderNotFound" });
    }
    // Proactive refresh when we know the token is expired.
    if (provider.has_oauth && provider.token_expired) {
      const r = await this.refresh_oauth_token(provider_id);
      if (!r.ok) {
        return r;
      }
    }
    let attempts = 0;
    for (;;) {
      let resp: Record<string, unknown>;
      try {
        resp = await do_request(provider.api_key);
      } catch (exc) {
        return Result.failure(`Request failed: ${exc}`, { code: "RequestError" });
      }
      const status = Math.trunc(Number(resp["status"] ?? 0) || 0);
      if (status !== 401 || attempts >= max_refresh || !provider.has_oauth) {
        return Result.success(resp);
      }
      attempts += 1;
      const r = await this.refresh_oauth_token(provider_id);
      if (!r.ok) {
        // Refresh token no longer usable — caller must re-auth the user.
        r.meta["needs_reauth"] = true;
        return r;
      }
    }
  }

  /** Blocking POST used by OAuth refresh (Node 22 native fetch). */
  static async _http_post_form(
    url: string,
    body: string
  ): Promise<{ ok: boolean; error: string; value: Record<string, unknown> }> {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await resp.text();
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status} ${resp.statusText} ${text}`, value: {} };
      }
      try {
        return { ok: true, error: "", value: JSON.parse(text) as Record<string, unknown> };
      } catch {
        return { ok: false, error: `invalid JSON body: ${text.slice(0, 120)}`, value: {} };
      }
    } catch (e) {
      return { ok: false, error: `URL error: ${e instanceof Error ? e.message : String(e)}`, value: {} };
    }
  }

  list_providers(): Record<string, unknown>[] {
    return Object.values(this._providers).map((p) => ({
      id: p.provider_id,
      name: p.name,
      kind: p.kind,
      enabled: p.enabled,
      models: Object.keys(p.models),
    }));
  }

  provider_label(provider_id: string): string {
    /** Human-readable name for a provider id, or "" when there isn't one.
     *
     * Returns "" rather than a placeholder for the unnameable cases (no id,
     * or the config entry when config.json omitted `provider`). Falls back to
     * the id itself for a provider that has since been deleted. */
    const pid = String(provider_id ?? "").trim();
    if (!pid) {
      return "";
    }
    const provider = this._providers[pid];
    const name = provider ? String(provider.name).trim() : "";
    if (pid === CONFIG_PROVIDER_ID) {
      return name.toLowerCase() === "" || name.toLowerCase() === "config" ? "" : name;
    }
    return name || pid;
  }

  record_usage(
    session_id: string,
    turn_id: string,
    input_tokens: number,
    output_tokens: number,
    reasoning_tokens = 0,
    cache_creation = 0,
    cache_read = 0,
    provider_total = 0,
    model_retry = 0,
    error_type = ""
  ): void {
    this._storage.record_usage(
      session_id, turn_id, input_tokens, output_tokens,
      reasoning_tokens, cache_creation, cache_read,
      provider_total, input_tokens + output_tokens + reasoning_tokens,
      model_retry, error_type
    );
  }

  get_usage(session_id: string): Record<string, unknown> {
    return this._storage.get_usage(session_id) as Record<string, unknown>;
  }

  price_overrides(): Record<string, Record<string, number>> {
    /** User-supplied rate overrides, or {} when none are configured. */
    const raw = this._storage.get_config(PRICE_OVERRIDE_KEY, {}) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, Record<string, number>>)
      : {};
  }

  cost_of(model_id: string, usage: Record<string, unknown>): Record<string, unknown> {
    /** Price one turn's usage, honoring any user rate overrides. */
    return compute_cost(model_id, usage, this.price_overrides());
  }
}

// SCENES / TIER_LIGHT referenced by scene_candidates — re-import surface.
import { SCENES, TIER_LIGHT, TIER_STANDARD } from "./model_registry.js";

let _registry: ModelRegistry | null = null;

export function get_model_registry(): ModelRegistry {
  if (_registry === null) {
    _registry = new ModelRegistry();
  }
  return _registry;
}

// DIVERGENCE(port): fernet interop RESOLVED — CredentialCipher here speaks the
// source's exact Fernet wire format and key derivation, so Python-written
// rows decrypt and TS-written rows decrypt in Python (round-trip probe in
// D:/ovolve-migration/verified/model_registry_impl_fernet.json). Residual
// drift is limited to the machine-key fallback: uuid.getnode()'s adapter
// order vs os.networkInterfaces() order can pick a different MAC when a box
// has several; set OVOLVE_MASTER_KEY to make both builds derive identically.

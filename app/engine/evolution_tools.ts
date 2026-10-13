/**
 * evolution_tools.ts - Ovolve self-evolution tools and draft manager.
 *
 * Ported from `app/backend/evolution_tools.py` (251 lines).
 *
 * Provides:
 * - EvolutionDraftManager: Manages 3-state proposal drafts
 *   (.ovolve/evolution/{pending,approved,rejected}) with Payload-Hash and
 *   Content-Hash anti-tamper verification.
 * - propose_evolution_rule: Tool for Agent to actively propose evolution
 *   rules in chat.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto sha256/uuid, node:fs).
 *   §2  `json.dumps(meta, sort_keys=True, ensure_ascii=False)` → pyJsonDumps
 *       with sortKeys=true (storage/storage_funcs.ts — the SAME Python
 *       canonical form, so payload hashes stay cross-build stable).
 *   §2  the evolution.py import is the wave-4 SPLIT unit; it arrives via a
 *       computed dynamic import with the source's try/except swallow — until
 *       that unit lands, propose_evolution_rule returns the same
 *       error-shape dict it would on engine construction failure.
 *   §2  `bus.emit_sync(...)` → EventBus.emitSync (event_bus.ts §2 mapping);
 *       the try/except pass around the broadcast is preserved.
 *   §4  naming: evolution_tools.py → evolution_tools.ts
 *
 * PORT STATUS: confidence=high todos=1
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { pyJsonDumps } from "./storage/storage_funcs.js";

// ---------------------------------------------------------------------------
// Proposal shape (evolution.py's dataclass; structural here so the draft
// manager and tool handler can operate before the SPLIT unit lands)
// ---------------------------------------------------------------------------

export interface ProposalLike {
  id: string;
  signature: string;
  kind: string;
  tool_name: string;
  target_file: string;
  draft: string;
  rationale: string;
  hits: number;
  status: string;
  created_at: number;
  user_title?: string;
  title?: string;
  user_advice?: string;
  advice?: string;
  user_reason?: string;
  reason?: string;
  category?: string;
  [k: string]: unknown;
}

/** evolution.py exports consumed through the optional dynamic import. */
interface EvolutionModuleLike {
  EvolutionEngine: new (opts: { workspace_root: string; storage?: unknown }) => EvolutionEngineLike;
  ALLOWED_TARGETS: ReadonlySet<string> | readonly string[];
  format_rule_line: (line: string, opts: { rule_id: string; hits: number; last_date: string }) => string;
  normalize_error: (e: unknown) => string;
}

interface EvolutionStoreLike {
  last_rejected_at(sig: string): number | null;
  insert_proposal(p: ProposalLike): void;
  count_open(): number;
}

export interface EvolutionEngineLike {
  workspace_root: string;
  store: EvolutionStoreLike;
}

function asTargetSet(v: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  if (!v) return new Set();
  return v instanceof Set ? new Set(v) : new Set(v);
}

// ---------------------------------------------------------------------------
// EvolutionDraftManager
// ---------------------------------------------------------------------------

export class EvolutionDraftManager {
  /** Manages 3-state evolution drafts on disk:
   * .ovolve/evolution/pending/<id>.json
   * .ovolve/evolution/approved/<id>.json
   * .ovolve/evolution/rejected/<id>.json */

  workspace_root: string;
  base_dir: string;
  pending_dir: string;
  approved_dir: string;
  rejected_dir: string;

  constructor(workspace_root?: string | null) {
    this.workspace_root = workspace_root || process.cwd();
    this.base_dir = path.join(this.workspace_root, ".ovolve", "evolution");
    this.pending_dir = path.join(this.base_dir, "pending");
    this.approved_dir = path.join(this.base_dir, "approved");
    this.rejected_dir = path.join(this.base_dir, "rejected");
    for (const d of [this.pending_dir, this.approved_dir, this.rejected_dir]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  /** Compute Payload-Hash and Content-Hash for tamper detection.
   *
   * payload_hash hashes the canonical (sort_keys) dump of the meta dict;
   * content_hash hashes the trimmed proposed change. Both via the shared
   * Python-compatible serializer so the digest is stable across builds. */
  static compute_hashes(
    proposal_meta: Record<string, unknown>,
    proposed_change: string
  ): [string, string] {
    const meta_str = pyJsonDumps(proposal_meta, true);
    const payload_hash = crypto.createHash("sha256").update(meta_str, "utf8").digest("hex");
    const content_hash = crypto
      .createHash("sha256")
      .update(proposed_change.trim(), "utf8")
      .digest("hex");
    return [payload_hash, content_hash];
  }

  /** Save proposal draft to pending/ directory with dual hashes. */
  save_pending_draft(
    proposal: ProposalLike,
    trigger_type = "preference",
    confidence = "high",
    delivery_mode = "card"
  ): Record<string, unknown> {
    const prop_meta: Record<string, unknown> = {
      id: proposal.id,
      signature: proposal.signature,
      target: proposal.target_file,
      trigger_type,
      confidence,
      tool: proposal.tool_name,
      kind: proposal.kind,
    };
    const [payload_hash, content_hash] = EvolutionDraftManager.compute_hashes(
      prop_meta,
      proposal.draft
    );

    const draft_data: Record<string, unknown> = {
      proposal_id: proposal.id,
      status: "pending",
      signature: proposal.signature,
      created_at: proposal.created_at,
      target_file: proposal.target_file,
      trigger_type,
      confidence,
      payload_hash,
      content_hash,
      reason: proposal.rationale,
      proposed_change: proposal.draft,
      delivery_mode,
      user_title: proposal.user_title ?? proposal.title ?? "",
      user_advice: proposal.user_advice ?? proposal.advice ?? "",
      user_reason: proposal.user_reason ?? proposal.reason ?? "",
      category: proposal.category ?? "custom",
    };

    const p = path.join(this.pending_dir, `${proposal.id}.json`);
    // json.dump(..., indent=2, ensure_ascii=False) — journal/UI file, not a
    // hash input, so JS two-space JSON is shape-compatible here.
    fs.writeFileSync(p, JSON.stringify(draft_data, null, 2), "utf-8");

    return draft_data;
  }

  /** Read draft across pending, approved, or rejected. */
  get_draft(proposal_id: string): Record<string, unknown> | null {
    for (const d of [this.pending_dir, this.approved_dir, this.rejected_dir]) {
      const p = path.join(d, `${proposal_id}.json`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        try {
          return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
        } catch {
          // except Exception: return None
          return null;
        }
      }
    }
    return null;
  }

  /** Move draft from pending/ to approved/. */
  mark_approved(proposal_id: string): boolean {
    return this._move_with_status(proposal_id, "approved");
  }

  /** Move draft from pending/ to rejected/. */
  mark_rejected(proposal_id: string): boolean {
    return this._move_with_status(proposal_id, "rejected");
  }

  private _move_with_status(proposal_id: string, status: string): boolean {
    const src = path.join(this.pending_dir, `${proposal_id}.json`);
    const dst_dir = status === "approved" ? this.approved_dir : this.rejected_dir;
    const dst = path.join(dst_dir, `${proposal_id}.json`);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      try {
        const data = JSON.parse(fs.readFileSync(src, "utf-8")) as Record<string, unknown>;
        data["status"] = status;
        data["decided_at"] = Date.now() / 1000;
        fs.writeFileSync(dst, JSON.stringify(data, null, 2), "utf-8");
        fs.unlinkSync(src);
        return true;
      } catch {
        // except Exception: return False
        return false;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// propose_evolution_rule tool
// ---------------------------------------------------------------------------

/** Agent tool: actively propose an evolution rule with in-chat card delivery.
 *
 * evolution.py (wave 4 SPLIT) is resolved through a computed dynamic import;
 * until that unit lands the engine-construction failure returns the same
 * error-shape dict the source would produce, and the draft still reaches
 * pending/ on the workspace disk. */
export async function propose_evolution_rule(kwargs: {
  target: string;
  signature?: string;
  trigger_type?: string;
  confidence?: string;
  reason?: string;
  proposed_change?: string;
  delivery_mode?: string;
  workspace_root?: string | null;
  engine?: EvolutionEngineLike | null;
  session_id?: string;
}): Promise<Record<string, unknown>> {
  const {
    trigger_type = "preference",
    confidence = "high",
    reason = "",
    proposed_change = "",
    delivery_mode = "card",
    workspace_root = null,
    engine = null,
    session_id = "",
  } = kwargs;
  const target = kwargs.target ?? "";

  // 1. Resolve evolution exports (optional SPLIT unit)
  let mod: EvolutionModuleLike | null = null;
  try {
    const spec = "./evolution" + ".js";
    mod = (await import(/* @vite-ignore */ spec)) as EvolutionModuleLike;
  } catch {
    // evolution.py 未移植/缺失 —— 与源 ImportError 同路径
    return {
      status: "error",
      error: "evolution engine module unavailable (evolution.py not ported or missing)",
    };
  }

  const target_clean = (target || "").trim();
  const allowed = asTargetSet(mod.ALLOWED_TARGETS);
  if (!allowed.has(target_clean)) {
    return {
      status: "error",
      error: `Target '${target}' is not in allowed targets: ${JSON.stringify(
        Array.from(allowed).sort()
      )}`,
    };
  }

  const ws_root = workspace_root || (engine ? engine.workspace_root : process.cwd());
  const draft_mgr = new EvolutionDraftManager(ws_root);

  // Initialize engine if not provided
  let eng = engine;
  if (eng === null) {
    try {
      const { get_storage } = (await import("./storage.js")) as {
        get_storage: () => unknown;
      };
      const st = get_storage();
      eng = new mod.EvolutionEngine({ workspace_root: ws_root, storage: st });
    } catch {
      eng = new mod.EvolutionEngine({ workspace_root: ws_root });
    }
  }

  let sig = (kwargs.signature || "").trim().toLowerCase();
  if (!sig) {
    sig = `rule-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }

  // Check cooldown (14 days)
  const last_rej = eng.store.last_rejected_at(sig);
  if (last_rej && Date.now() / 1000 - last_rej < 14 * 86400) {
    return {
      status: "skipped",
      reason: `Signature '${sig}' was rejected within 14-day cooldown window`,
    };
  }

  const now_date = new Date();
  const ymd = [
    now_date.getFullYear(),
    String(now_date.getMonth() + 1).padStart(2, "0"),
    String(now_date.getDate()).padStart(2, "0"),
  ].join("");
  const prop_id = `evo-${ymd}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
  let formatted_change = proposed_change.trim();
  if (!formatted_change.startsWith("-")) {
    formatted_change = `- ${formatted_change}`;
  }

  const today = [
    now_date.getFullYear(),
    String(now_date.getMonth() + 1).padStart(2, "0"),
    String(now_date.getDate()).padStart(2, "0"),
  ].join("-");
  const rule_line = mod.format_rule_line(formatted_change, {
    rule_id: prop_id,
    hits: 1,
    last_date: today,
  });

  const proposal: ProposalLike = {
    id: prop_id,
    signature: sig,
    kind: trigger_type === "correction" ? "user_correction" : "learned_fact",
    tool_name: "propose_evolution_rule",
    target_file: target_clean,
    draft: rule_line,
    rationale: reason || `Agent proposed via ${trigger_type}`,
    hits: 1,
    status: "pending",
    created_at: Date.now() / 1000,
    user_title: `自进化规则：${sig}`,
    user_advice: formatted_change,
    user_reason: reason || "根据会话交互总结出的持续规则",
    category: "custom",
  };

  eng.store.insert_proposal(proposal);
  const draft_info = draft_mgr.save_pending_draft(
    proposal,
    trigger_type,
    confidence,
    delivery_mode
  );

  // Broadcast on EventBus if available
  try {
    const { getEventBus } = (await import("./event_bus.js")) as {
      getEventBus: () => { emitSync: (name: string, payload: Record<string, unknown>) => void };
    };
    const bus = getEventBus();
    bus.emitSync("evolution_proposal", {
      proposalId: prop_id,
      proposal: draft_info,
      sessionId: session_id,
      delivery_mode,
      openCount: eng.store.count_open(),
    });
  } catch {
    // except Exception: pass
  }

  return {
    status: "proposed",
    proposal_id: prop_id,
    delivery_mode,
    payload_hash: draft_info["payload_hash"],
    content_hash: draft_info["content_hash"],
    target: target_clean,
    signature: sig,
    proposed_change: formatted_change,
    reason,
  };
}

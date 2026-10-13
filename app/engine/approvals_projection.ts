/**
 * approvals_projection.ts — 演化裁决页的只读投影。
 *
 * Ported from `app/backend/approvals_projection.py` (66 lines).
 *
 * 聚合两类"自进化环在等人工拍板"的事项：
 *
 * - skillCandidates     —— staged 状态的技能候选（学习环等待批准）
 * - evolutionProposals  —— pending 状态的演化提案（记忆/指导文件待批准）
 *
 * ask_user 问题卡**不在**这里：它是会话进行中的临时交互，归属聊天流——卡片
 * 本来就在对话里渲染与回答，进裁决列表只会弄混页面身份（产品决定，2026-08）。
 * 投影是只读聚合，真相仍在各自的账本里。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only.
 *   §2  `except Exception: return []` swallows preserved verbatim — the
 *       projection is read-only aggregation and must never be the thing that
 *       fails a page render. The lazy `import evolution` becomes a dynamic
 *       import() with the same "engine may not exist yet" semantics.
 *   §2  不主动建引擎：只读投影不该成为"第一次建演化库"的那个调用者。
 *   §4  naming: approvals_projection.py → approvals_projection.ts
 *
 * PORT STATUS: confidence=high todos=1
 */

// ---------------------------------------------------------------------------
// Evolution engine lazy accessor
// ---------------------------------------------------------------------------

/** Evolution 引擎模块面的最小形状（evolution.ts 移植后由其模块级 `_engine` 提供）。 */
interface EvolutionEngineLike {
  enabled(): boolean;
  list_open(): Record<string, unknown>[];
}

interface EvolutionModuleLike {
  _engine: EvolutionEngineLike | null | undefined;
}

/**
 * pending 提案列表。取不到就返回空——投影的其余部分不该被它拖垮。
 *
 * off 档一行不查：引擎关着的时候读库既无意义，也违反"没开就零 IO"。
 * 也不主动建引擎——只读投影不该成为"第一次建演化库"的那个调用者；服务启动时
 * `configure_from_config` 已经建过，没建过就说明这个进程压根没在演化。
 */
async function _open_evolution_proposals(
  engine?: EvolutionEngineLike | null
): Promise<Record<string, unknown>[]> {
  if (engine === undefined || engine === null) {
    try {
      // Python `import evolution; getattr(evolution, "_engine", None)` —
      // the computed specifier keeps the import lazy at TYPE level too:
      // evolution.py (wave 4 SPLIT) may not be ported yet, and tsc must not
      // fail the whole projection for a module that is optional by design.
      const spec = "./evolution" + ".js";
      const mod = (await import(/* @vite-ignore */ spec)) as EvolutionModuleLike;
      engine = mod._engine ?? null;
    } catch {
      return [];
    }
  }
  if (engine === null || engine === undefined) {
    return [];
  }
  try {
    if (!engine.enabled()) {
      return [];
    }
    return engine.list_open();
  } catch {
    // except Exception: return []
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface PendingApprovals {
  skillCandidates: Record<string, unknown>[];
  evolutionProposals: Record<string, unknown>[];
  counts: {
    skillCandidates: number;
    evolutionProposals: number;
    total: number;
  };
}

/** 聚合演化环的全部待人工处理事项。 */
export async function pending_approvals(
  storage: {
    list_skill_candidates: (opts: { status: string; limit: number }) => Record<string, unknown>[];
  },
  opts: { evolution_engine?: EvolutionEngineLike | null } = {}
): Promise<PendingApprovals> {
  let staged: Record<string, unknown>[] = [];
  try {
    staged = storage.list_skill_candidates({ status: "staged", limit: 50 });
  } catch {
    // except Exception: staged = []
    staged = [];
  }

  const proposals = await _open_evolution_proposals(opts.evolution_engine);

  return {
    skillCandidates: staged,
    evolutionProposals: proposals,
    counts: {
      skillCandidates: staged.length,
      evolutionProposals: proposals.length,
      total: staged.length + proposals.length,
    },
  };
}

// (The dynamic import above resolves at runtime once evolution.py (wave 4
// SPLIT, 149KB) is ported; until then the catch path returns [] — identical
// to "engine never configured" in the source.)

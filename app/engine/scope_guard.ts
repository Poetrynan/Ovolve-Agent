/**
 * scope_guard.ts — Session & Branch 作用域上下文与硬隔离守卫。
 *
 * Ported from `app/backend/scope_guard.py` (72 lines).
 *
 * §13.4 & §13.5:
 * 1. 建立唯一的 ScopeContext 结构，杜绝各 handler 自行拼接过滤条件；
 * 2. 所有消息、轮次、工具结果、记忆提取、技能经验、Episode、LearningItem、
 *    EventStore 事件都必须携带并在读写时校验 session_id 与 branch_id；
 * 3. 本地单用户环境也必须保证对象归属校验，跨会话/分支操作返回
 *    409 scope_mismatch。
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖（frozen dataclass → readonly interface + Object.freeze）。
 *   §4  naming: scope_guard.py → scope_guard.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

/** 标准的作用域上下文。 */
export interface ScopeContext {
  readonly session_id: string;
  readonly branch_id: string;
  readonly workspace_root: string;
  readonly user_id: string;
  readonly current_goal_id: string;
  readonly current_run_id: string;
  readonly current_turn_id: string;
  readonly current_episode_id: string;
}

export function make_scope_context(kwargs: {
  session_id: string;
  branch_id?: string;
  workspace_root?: string;
  user_id?: string;
  current_goal_id?: string;
  current_run_id?: string;
  current_turn_id?: string;
  current_episode_id?: string;
}): ScopeContext {
  return Object.freeze({
    session_id: kwargs.session_id,
    branch_id: kwargs.branch_id ?? "",
    workspace_root: kwargs.workspace_root ?? "",
    user_id: kwargs.user_id ?? "local_user",
    current_goal_id: kwargs.current_goal_id ?? "",
    current_run_id: kwargs.current_run_id ?? "",
    current_turn_id: kwargs.current_turn_id ?? "",
    current_episode_id: kwargs.current_episode_id ?? "",
  });
}

/** 校验目标对象是否处于当前作用域内（严格 exact match）。 */
export function scope_matches(
  ctx: ScopeContext,
  target_session_id: string,
  target_branch_id = ""
): boolean {
  if (!ctx.session_id || !target_session_id) {
    return false;
  }
  if (ctx.session_id.trim() !== target_session_id.trim()) {
    return false;
  }
  // 严格校验分支：双方规范化后必须完全一致
  const cur_b = (ctx.branch_id || "").trim();
  const tgt_b = (target_branch_id || "").trim();
  if (cur_b !== tgt_b) {
    return false;
  }
  return true;
}

export function scope_to_dict(ctx: ScopeContext): Record<string, string> {
  return {
    sessionId: ctx.session_id,
    branchId: ctx.branch_id,
    workspaceRoot: ctx.workspace_root,
    userId: ctx.user_id,
    goalId: ctx.current_goal_id,
    runId: ctx.current_run_id,
    turnId: ctx.current_turn_id,
    episodeId: ctx.current_episode_id,
  };
}

/** 严格校验 session 与 branch 是否匹配（exact match）。
 * Returns (is_valid, error_message). */
export function validate_scope(
  expected_session: string,
  expected_branch: string,
  actual_session: string,
  actual_branch = ""
): [boolean, string] {
  const exp_s = (expected_session || "").trim();
  const act_s = (actual_session || "").trim();
  if (!exp_s || !act_s) {
    return [false, "missing_session_id"];
  }
  if (exp_s !== act_s) {
    return [false, `session_mismatch: expected '${exp_s}' but got '${act_s}'`];
  }

  const exp_b = (expected_branch || "").trim();
  const act_b = (actual_branch || "").trim();
  if (exp_b !== act_b) {
    return [false, `branch_mismatch: expected '${exp_b}' but got '${act_b}'`];
  }
  return [true, ""];
}

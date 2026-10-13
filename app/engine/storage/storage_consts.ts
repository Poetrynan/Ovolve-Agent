import { randomUUID } from "node:crypto";

/**
 * storage_consts.ts 鈥?module-level constants of storage.py, verbatim.
 *
 * RULEBOOK CITATIONS
 *   搂2  module-level mutable state keeps the same initialisation order; these
 *       are all immutable, so const exports preserve behaviour.
 *
 * PORT STATUS: n/a (support module of the storage unit, not a translated unit)
 */

/** A new value on every process start; used by reap_orphan_subagent_runs. */
export const PROCESS_GENERATION: string = randomHex12();

/**
 * Statuses a sub-agent run can never leave (mirrors
 * subagent_runtime.TERMINAL_STATUSES by value; deliberately duplicated as
 * plain strings so storage does not import the runtime).
 */
export const SUBAGENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "error",
  "killed",
  "timeout",
  "stale",
]);

/** Sidecar next to the databases recording migration progress. */
export const MIGRATION_JOURNAL_NAME = "migration_journal.json";

/**
 * Provider ids older builds wrote when they had no real provider entry.
 * Mapped to "" upstream so no non-existent vendor is shown.
 */
export const PLACEHOLDER_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "custom",
  "default",
  "",
]);

function randomHex12(): string {
  // uuid.uuid4().hex[:12] equivalent: first 12 hex chars of a UUIDv4.
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * The ordered migration registry. Each entry is [id, description, methodName].
 * ids are ordered and NEVER renumbered; a step runs at most once per database,
 * in list order.
 */
export const MIGRATIONS: ReadonlyArray<
  readonly [string, string, string]
> = [
  ["0001_subagent_runs", "sub-agent run ledger + parent/generation indexes", "_mig_0001_subagent_runs"],
  ["0002_tool_side_effects", "side-effect ledger for write-class tool calls", "_mig_0002_tool_side_effects"],
  ["0003_skill_experiences", "skill experience ledger for the learning loop", "_mig_0003_skill_experiences"],
  ["0004_memory_skill_relations", "explicit memory/skill/goal/run relation graph", "_mig_0004_memory_skill_relations"],
  ["0005_skill_candidates", "skill candidate lifecycle ledger (Step E)", "_mig_0005_skill_candidates"],
  ["0006_candidate_verify_command", "deterministic verification command for skill candidates", "_mig_0006_candidate_verify_command"],
  ["0007_goal_contract", "versioned acceptance contract on goals (Phase 3)", "_mig_0007_goal_contract"],
  ["0008_cron_lease_and_team", "cron execution lease/team task leases (Phase 7 & 10)", "_mig_0008_cron_lease_and_team"],
  ["0009_mailbox", "persistent mailboxes for subagent/system messages (Phase 7)", "_mig_0009_mailbox"],
  ["0010_side_effect_generation", "stamp the writing process on side effects + replay lookup index", "_mig_0010_side_effect_generation"],
  ["0011_goal_claim_lease", "owner-conditioned goal claim lease with heartbeat renew", "_mig_0011_goal_claim_lease"],
  ["0012_typed_effects", "typed side effects: operation identity + pre/planned/post state", "_mig_0012_typed_effects"],
  ["0013_memory_lifecycle", "memory lifecycle: status/confidence/provenance/validity as columns", "_mig_0013_memory_lifecycle"],
  ["0014_memory_provenance", "memory provenance: sensitivity/source goal/source events/valid_from", "_mig_0014_memory_provenance"],
  ["0015_memory_conflict_set", "memory conflict_set: which live memories contradict this one", "_mig_0015_memory_conflict_set"],
  ["0016_memory_supersedes", "memory supersedes: which rows a pending merge would replace", "_mig_0016_memory_supersedes"],
  ["0017_dream_runs", "dream run ledger: job id / lease / heartbeat / budget / journal", "_mig_0017_dream_runs"],
  ["0018_learning_items_and_episodes", "conversation episodes and granular learning items ledger", "_mig_0018_learning_items_and_episodes"],
  ["0019_episode_learning_item_provenance_and_indexes", "episode and learning item provenance, idempotency key and branch indexes", "_mig_0019_episode_learning_item_provenance_and_indexes"],
  ["0020_learning_item_operations", "persistent learning item mutation operation ledger", "_mig_0020_learning_item_operations"],
  ["0021_capability_probes", "capability probe ledger: what was probed, when, and how it answered", "_mig_0021_capability_probes"],
  ["0022_memory_hygiene", "memory hygiene batches: what was archived/pruned and why", "_mig_0022_memory_hygiene"],
  ["0023_workflow_patterns", "recurring workflow patterns distilled from run history", "_mig_0023_workflow_patterns"],
  ["0024_caller_call_id", "subagent runs remember the parent tool call that dispatched them", "_mig_0024_caller_call_id"],
];

/** The eight databases, one responsibility each. */
export const DB_NAMES: readonly string[] = [
  "configs",
  "kv",
  "sessions",
  "goals",
  "cron",
  "memory",
  "usage",
  "bot",
];

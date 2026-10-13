/**
 * migrations.ts — storage domain mixin: the 24 registered migration steps.
 *
 * Ported from `app/backend/storage.py` lines 998–1814 (_mig_0001 … _mig_0024).
 *
 * Each step is written defensively: the first run on a pre-existing database
 * may find the change already present. Steps execute at most once per
 * database in registry order (see StorageBase._run_migrations); a step's DDL
 * must therefore be safe to re-run.
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins only.
 * - §2 SQL is reproduced verbatim; `_safe_add_column` carries the source's
 *   duplicate-column silence and the loud print for every other failure.
 * - §4 naming: part of the storage unit (storage.py → storage/domains/).
 *
 * PORT STATUS: confidence=high todos=0
 */

import type { Row } from "../storage_types.js";
import { StorageBase } from "../../storage.js";

export interface MigrationsDomainI {
  _mig_0001_subagent_runs(): void;
  _mig_0002_tool_side_effects(): void;
  _mig_0003_skill_experiences(): void;
  _mig_0004_memory_skill_relations(): void;
  _mig_0005_skill_candidates(): void;
  _mig_0006_candidate_verify_command(): void;
  _mig_0007_goal_contract(): void;
  _mig_0008_cron_lease_and_team(): void;
  _mig_0009_mailbox(): void;
  _mig_0010_side_effect_generation(): void;
  _mig_0011_goal_claim_lease(): void;
  _mig_0012_typed_effects(): void;
  _mig_0013_memory_lifecycle(): void;
  _mig_0014_memory_provenance(): void;
  _mig_0015_memory_conflict_set(): void;
  _mig_0016_memory_supersedes(): void;
  _mig_0017_dream_runs(): void;
  _mig_0018_learning_items_and_episodes(): void;
  _mig_0019_episode_learning_item_provenance_and_indexes(): void;
  _mig_0020_learning_item_operations(): void;
  _mig_0021_capability_probes(): void;
  _mig_0022_memory_hygiene(): void;
  _mig_0023_workflow_patterns(): void;
  _mig_0024_caller_call_id(): void;
}

export function applyMigrationsDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as Record<string, unknown>;

  proto._mig_0001_subagent_runs = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Sub-agent run ledger (see source docstring re: generation + crash
    // detection). Lives in the sessions db, session-scoped.
    const s = self._db("sessions");
    s.execute(
      "CREATE TABLE IF NOT EXISTS subagent_runs (" +
        "subagent_id TEXT PRIMARY KEY, generation TEXT," +
        " parent_session_id TEXT, child_session_id TEXT," +
        " subagent_type TEXT, label TEXT, status TEXT," +
        " created_at REAL, started_at REAL DEFAULT 0, finished_at REAL DEFAULT 0," +
        " result_chars INTEGER DEFAULT 0, error TEXT DEFAULT '')"
    );
    s.execute(
      "CREATE INDEX IF NOT EXISTS idx_subrun_parent ON subagent_runs(parent_session_id, created_at)"
    );
    s.execute("CREATE INDEX IF NOT EXISTS idx_subrun_gen ON subagent_runs(generation, status)");
    s.commit();
  };

  proto._mig_0002_tool_side_effects = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Side-effect ledger for write-class tool calls; INSERT OR IGNORE makes a
    // replayed record a no-op.
    const s = self._db("sessions");
    s.execute(
      "CREATE TABLE IF NOT EXISTS tool_side_effects (" +
        "call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL," +
        " goal_id TEXT DEFAULT '', tool_name TEXT NOT NULL, args_hash TEXT NOT NULL," +
        " status TEXT NOT NULL DEFAULT 'pending'," +
        " ok INTEGER NOT NULL DEFAULT 0, result_preview TEXT DEFAULT ''," +
        " created_at INTEGER NOT NULL, settled_at INTEGER)"
    );
    s.execute(
      "CREATE INDEX IF NOT EXISTS idx_side_effects_goal ON tool_side_effects(goal_id, status)"
    );
    s.commit();
  };

  proto._mig_0003_skill_experiences = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Skill experience ledger — the memory of how a skill actually went.
    // Idempotency structural: UNIQUE(run_id, skill_id, turn_id).
    const s = self._db("sessions");
    s.execute(
      "CREATE TABLE IF NOT EXISTS skill_experiences (" +
        "experience_id TEXT PRIMARY KEY," +
        " skill_id TEXT NOT NULL, skill_version TEXT DEFAULT ''," +
        " run_id TEXT DEFAULT '', turn_id TEXT DEFAULT ''," +
        " goal_id TEXT DEFAULT '', session_id TEXT DEFAULT ''," +
        " memory_snapshot_id TEXT DEFAULT ''," +
        " selection_reason TEXT DEFAULT ''," +
        " preconditions_met INTEGER DEFAULT 0," +
        " steps_attempted INTEGER DEFAULT 0, steps_succeeded INTEGER DEFAULT 0," +
        " validator_status TEXT DEFAULT 'none'," +
        " user_feedback TEXT DEFAULT ''," +
        " outcome TEXT DEFAULT 'unknown', failure_class TEXT DEFAULT ''," +
        " repair_applied TEXT DEFAULT ''," +
        " cost REAL DEFAULT 0, latency_ms REAL DEFAULT 0," +
        " source_event_ids TEXT DEFAULT '[]', evidence_event_ids TEXT DEFAULT '[]'," +
        " created_at INTEGER NOT NULL)"
    );
    s.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_exp_dedupe ON skill_experiences(run_id, skill_id, turn_id)"
    );
    s.execute(
      "CREATE INDEX IF NOT EXISTS idx_exp_skill ON skill_experiences(skill_id, created_at)"
    );
    s.commit();
  };

  proto._mig_0004_memory_skill_relations = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Memory–Skill 显式关系图（Step D）。统一成三元组边表；id 由五元组确定性派生。
    const s = self._db("sessions");
    s.execute(
      "CREATE TABLE IF NOT EXISTS memory_skill_relations (" +
        "id TEXT PRIMARY KEY," +
        " subject_type TEXT NOT NULL, subject_id TEXT NOT NULL," +
        " relation TEXT NOT NULL," +
        " object_type TEXT NOT NULL, object_id TEXT NOT NULL," +
        " evidence TEXT DEFAULT ''," +
        " stale INTEGER NOT NULL DEFAULT 0," +
        " created_at INTEGER NOT NULL," +
        " UNIQUE(subject_type, subject_id, relation, object_type, object_id))"
    );
    s.execute(
      "CREATE INDEX IF NOT EXISTS idx_rel_sub ON memory_skill_relations(subject_type, subject_id, relation)"
    );
    s.execute(
      "CREATE INDEX IF NOT EXISTS idx_rel_obj ON memory_skill_relations(object_type, object_id, relation)"
    );
    s.commit();
  };

  proto._mig_0005_skill_candidates = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Skill 候选生命周期台账（Step E）。status 单向主链 candidate→staged→active。
    const s = self._db("sessions");
    s.execute(
      "CREATE TABLE IF NOT EXISTS skill_candidates (" +
        "id TEXT PRIMARY KEY," +
        " name TEXT NOT NULL," +
        " description TEXT DEFAULT '', when_to_use TEXT DEFAULT ''," +
        " scope TEXT DEFAULT '', preconditions TEXT DEFAULT ''," +
        " inputs TEXT DEFAULT '', outputs TEXT DEFAULT ''," +
        " steps TEXT DEFAULT '[]', required_tools TEXT DEFAULT '[]'," +
        " risk_level TEXT DEFAULT 'medium'," +
        " verification TEXT DEFAULT '', known_failures TEXT DEFAULT ''," +
        " memory_refs TEXT DEFAULT '[]'," +
        " experience_ref TEXT DEFAULT ''," +
        " source_event_ids TEXT DEFAULT '[]'," +
        " version TEXT DEFAULT ''," +
        " status TEXT NOT NULL DEFAULT 'candidate'," +
        " gate_report TEXT DEFAULT '{}'," +
        " superseded_skill TEXT DEFAULT ''," +
        " snapshot_path TEXT DEFAULT ''," +
        " created_at INTEGER NOT NULL, updated_at INTEGER DEFAULT 0)"
    );
    s.execute(
      "CREATE INDEX IF NOT EXISTS idx_cand_status ON skill_candidates(status, created_at)"
    );
    s.commit();
  };

  proto._mig_0006_candidate_verify_command = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // 候选的确定性验证命令（approve 时人工点击后执行一次）。
    self._safe_add_column("sessions", "skill_candidates", "verify_command", "TEXT DEFAULT ''");
  };

  proto._mig_0007_goal_contract = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // 版本化验收合同（Phase 3）。旧目标无合同，首次读取时从 GoalBrief 派生回填。
    self._safe_add_column("goals", "goals", "contract_json", "TEXT DEFAULT ''");
  };

  proto._mig_0008_cron_lease_and_team = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // §14 后台任务账本语义 + §13 TaskLease（Phase 7/10）。
    self._safe_add_column("cron", "cron_jobs", "running_since", "INTEGER DEFAULT 0");
    self._safe_add_column("cron", "cron_jobs", "last_error", "TEXT DEFAULT ''");
    const c = self._db("sessions");
    c.execute(
      "CREATE TABLE IF NOT EXISTS team_leases (" +
        "task_id TEXT PRIMARY KEY," +
        " owner TEXT NOT NULL," +
        " acquired_at INTEGER NOT NULL," +
        " expires_at INTEGER NOT NULL)"
    );
  };

  proto._mig_0009_mailbox = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // §13 Mailbox：子代理/系统通知的持久信箱（Phase 7 收口）。消费即标记。
    const c = self._db("sessions");
    c.execute(
      "CREATE TABLE IF NOT EXISTS mailbox_messages (" +
        "id TEXT PRIMARY KEY," +
        " box_id TEXT NOT NULL," +
        " sender TEXT NOT NULL," +
        " kind TEXT NOT NULL DEFAULT 'info'," +
        " payload TEXT NOT NULL DEFAULT '{}'," +
        " consumed INTEGER NOT NULL DEFAULT 0," +
        " created_at INTEGER NOT NULL)"
    );
    c.execute(
      "CREATE INDEX IF NOT EXISTS idx_mbox_box ON mailbox_messages(box_id, consumed, created_at)"
    );
  };

  proto._mig_0010_side_effect_generation = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Which process wrote this side effect + the replay lookup index.
    self._safe_add_column("sessions", "tool_side_effects", "generation", "TEXT DEFAULT ''");
    const c = self._db("sessions");
    c.execute(
      "CREATE INDEX IF NOT EXISTS idx_side_effects_replay ON tool_side_effects(goal_id, tool_name, args_hash)"
    );
  };

  proto._mig_0011_goal_claim_lease = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Goal claim becomes a heartbeat lease instead of a static timestamp.
    self._safe_add_column("goals", "goals", "claim_owner", "TEXT DEFAULT ''");
    self._safe_add_column("goals", "goals", "lease_until", "INTEGER DEFAULT 0");
    self._safe_add_column("goals", "goals", "last_heartbeat", "INTEGER DEFAULT 0");
    self._safe_add_column("goals", "goals", "claim_epoch", "INTEGER DEFAULT 0");
  };

  proto._mig_0012_typed_effects = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Side effects get an identity and a before/after, not just an args hash.
    const cols: [string, string][] = [
      ["effect_kind", "TEXT DEFAULT ''"],
      ["target", "TEXT DEFAULT ''"],
      ["operation_id", "TEXT DEFAULT ''"],
      ["pre_hash", "TEXT DEFAULT ''"],
      ["planned_hash", "TEXT DEFAULT ''"],
      ["post_hash", "TEXT DEFAULT ''"],
    ];
    for (const [col, decl] of cols) {
      self._safe_add_column("sessions", "tool_side_effects", col, decl);
    }
    const c = self._db("sessions");
    c.execute(
      "CREATE INDEX IF NOT EXISTS idx_side_effects_operation ON tool_side_effects(operation_id, status)"
    );
  };

  proto._mig_0013_memory_lifecycle = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // 记忆有了生命周期：状态、置信度、来源、有效期，都是列而不是 JSON。
    const cols: [string, string][] = [
      ["status", "TEXT DEFAULT 'active'"],
      ["confidence", "REAL DEFAULT 0.5"],
      ["created_by", "TEXT DEFAULT ''"],
      ["version", "INTEGER DEFAULT 1"],
      ["superseded_by", "TEXT DEFAULT ''"],
      ["valid_until", "INTEGER DEFAULT 0"],
      ["last_confirmed_at", "INTEGER DEFAULT 0"],
      ["status_reason", "TEXT DEFAULT ''"],
    ];
    for (const [col, decl] of cols) {
      self._safe_add_column("memory", "memory_entries", col, decl);
    }
    const c = self._db("memory");
    // 老行的状态从 archived 推导出来，一次性；之后两边一起写。
    c.execute(
      "UPDATE memory_entries SET status='archived' WHERE archived=1 AND COALESCE(status,'') IN ('', 'active')"
    );
    c.execute("UPDATE memory_entries SET status='active' WHERE archived=0 AND COALESCE(status,'')=''");
    // 老行没有"最后确认时间"，用创建时间兜底。
    c.execute(
      "UPDATE memory_entries SET last_confirmed_at=created_at WHERE COALESCE(last_confirmed_at,0)=0"
    );
    c.execute("CREATE INDEX IF NOT EXISTS idx_mem_status ON memory_entries(root_dir, status)");
    c.commit();
  };

  proto._mig_0014_memory_provenance = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // 一条记忆现在能回答"你凭什么这么说"和"这话能不能给别人看"。
    const cols: [string, string][] = [
      ["sensitivity", "TEXT DEFAULT 'public'"],
      ["source_goal_id", "TEXT DEFAULT ''"],
      ["source_event_ids", "TEXT DEFAULT '[]'"],
      ["valid_from", "INTEGER DEFAULT 0"],
    ];
    for (const [col, decl] of cols) {
      self._safe_add_column("memory", "memory_entries", col, decl);
    }
    const c = self._db("memory");
    // 老行没有 valid_from，用创建时间兜底（0 会被读路径当成"未设置"）。
    c.execute("UPDATE memory_entries SET valid_from=created_at WHERE COALESCE(valid_from,0)=0");
    c.execute("UPDATE memory_entries SET sensitivity='public' WHERE COALESCE(sensitivity,'')=''");
    c.commit();
  };

  proto._mig_0015_memory_conflict_set = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // 一条记忆现在能指出"谁和我打架"。
    self._safe_add_column("memory", "memory_entries", "conflict_set", "TEXT DEFAULT '[]'");
    const c = self._db("memory");
    c.execute("UPDATE memory_entries SET conflict_set='[]' WHERE COALESCE(conflict_set,'')=''");
    c.commit();
  };

  proto._mig_0016_memory_supersedes = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // 一条待批的合并现在能说出"我要替换掉哪几条"。
    self._safe_add_column("memory", "memory_entries", "supersedes", "TEXT DEFAULT '[]'");
    const c = self._db("memory");
    c.execute("UPDATE memory_entries SET supersedes='[]' WHERE COALESCE(supersedes,'')=''");
    c.commit();
  };

  proto._mig_0017_dream_runs = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // §10.3：Dream 从"一个没人看得见的后台协作"变成一个有账本的 job。
    const c = self._db("memory");
    c.execute(`CREATE TABLE IF NOT EXISTS dream_runs (
            job_id TEXT PRIMARY KEY,
            root_dir TEXT NOT NULL DEFAULT '',
            idem_key TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            owner TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL DEFAULT 0,
            heartbeat_at INTEGER NOT NULL DEFAULT 0,
            lease_until INTEGER NOT NULL DEFAULT 0,
            finished_at INTEGER NOT NULL DEFAULT 0,
            outcome TEXT NOT NULL DEFAULT '',
            proposal_id TEXT NOT NULL DEFAULT '',
            input_count INTEGER NOT NULL DEFAULT 0,
            tokens_used INTEGER NOT NULL DEFAULT 0,
            wall_ms INTEGER NOT NULL DEFAULT 0
        )`);
    c.execute("CREATE INDEX IF NOT EXISTS idx_dream_root ON dream_runs(root_dir, started_at DESC)");
    c.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_idem ON dream_runs(idem_key) WHERE idem_key<>''"
    );
    c.commit();
  };

  proto._mig_0018_learning_items_and_episodes = function (
    this: StorageBase & MigrationsDomainI
  ): void {
    const self = this;
    // §13.4/13.5/16.1：Episode 与 LearningItem 一等账本。
    const cs = self._db("sessions");
    cs.execute(`CREATE TABLE IF NOT EXISTS episodes (
            episode_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            branch_id TEXT NOT NULL DEFAULT '',
            topic TEXT NOT NULL DEFAULT '',
            goal_id TEXT NOT NULL DEFAULT '',
            turn_ids TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'active',
            started_at REAL NOT NULL DEFAULT 0,
            sealed_at REAL NOT NULL DEFAULT 0,
            metadata TEXT NOT NULL DEFAULT '{}'
        )`);
    cs.execute(
      "CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, started_at DESC)"
    );
    cs.execute("CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status, session_id)");
    cs.commit();

    const cm = self._db("memory");
    cm.execute(`CREATE TABLE IF NOT EXISTS learning_items (
            learning_item_id TEXT PRIMARY KEY,
            bundle_id TEXT NOT NULL DEFAULT '',
            episode_id TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL DEFAULT '',
            branch_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'memory_fact',
            scope TEXT NOT NULL DEFAULT 'session',
            content TEXT NOT NULL DEFAULT '',
            preconditions TEXT NOT NULL DEFAULT '',
            applicability TEXT NOT NULL DEFAULT '',
            source_event_ids TEXT NOT NULL DEFAULT '[]',
            source_session_id TEXT NOT NULL DEFAULT '',
            source_goal_id TEXT NOT NULL DEFAULT '',
            source_run_id TEXT NOT NULL DEFAULT '',
            source_turn_id TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 1.0,
            evidence_strength REAL NOT NULL DEFAULT 1.0,
            priority INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'discovered',
            notification_policy TEXT NOT NULL DEFAULT 'receipt',
            why TEXT NOT NULL DEFAULT '',
            evidence_summary TEXT NOT NULL DEFAULT '',
            future_effect TEXT NOT NULL DEFAULT '',
            target_ref TEXT NOT NULL DEFAULT '',
            deferred_reason TEXT NOT NULL DEFAULT '',
            user_verdict TEXT NOT NULL DEFAULT 'pending',
            created_at REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT 0
        )`);
    cm.execute(
      "CREATE INDEX IF NOT EXISTS idx_li_session ON learning_items(session_id, created_at DESC)"
    );
    cm.execute(
      "CREATE INDEX IF NOT EXISTS idx_li_episode ON learning_items(episode_id, created_at DESC)"
    );
    cm.execute("CREATE INDEX IF NOT EXISTS idx_li_bundle ON learning_items(bundle_id)");
    cm.execute("CREATE INDEX IF NOT EXISTS idx_li_status ON learning_items(status, session_id)");
    cm.commit();
  };

  proto._mig_0019_episode_learning_item_provenance_and_indexes = function (
    this: StorageBase & MigrationsDomainI
  ): void {
    const self = this;
    // Episode 与 LearningItem 来源索引与幂等支持。
    self._safe_add_column("sessions", "episodes", "last_activity_at", "REAL DEFAULT 0");
    self._safe_add_column("sessions", "episodes", "sealed_by_event_id", "TEXT DEFAULT ''");
    self._safe_add_column("sessions", "episodes", "seal_reason", "TEXT DEFAULT ''");
    self._safe_add_column("sessions", "episodes", "generation", "INTEGER DEFAULT 1");
    const cs = self._db("sessions");
    cs.execute(
      "CREATE INDEX IF NOT EXISTS idx_episodes_active ON episodes(session_id, branch_id, status)"
    );
    cs.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_active_unique ON episodes(session_id, branch_id) WHERE status='active'"
    );
    cs.commit();

    self._safe_add_column("memory", "learning_items", "idempotency_key", "TEXT DEFAULT ''");
    self._safe_add_column("memory", "learning_items", "operation_id", "TEXT DEFAULT ''");
    self._safe_add_column("memory", "learning_items", "version", "INTEGER DEFAULT 1");
    const cm = self._db("memory");
    cm.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_li_idem ON learning_items(idempotency_key) WHERE idempotency_key <> ''"
    );
    cm.commit();
  };

  proto._mig_0020_learning_item_operations = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // P1-2: Persistent LearningItem mutation operation ledger.
    const cm = self._db("memory");
    cm.execute(`CREATE TABLE IF NOT EXISTS learning_item_operations (
            operation_id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            action TEXT NOT NULL,
            idempotency_key TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            result TEXT NOT NULL DEFAULT '{}',
            error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT 0
        )`);
    cm.execute(
      "CREATE INDEX IF NOT EXISTS idx_li_ops_item ON learning_item_operations(item_id, created_at DESC)"
    );
    cm.execute("DROP INDEX IF EXISTS idx_li_ops_idem");
    cm.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_li_ops_idem ON learning_item_operations(idempotency_key) WHERE idempotency_key <> ''"
    );
    cm.commit();
  };

  proto._mig_0021_capability_probes = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Capability probe ledger: persistent, queryable by (capability, time).
    const c = self._db("memory");
    c.execute(`CREATE TABLE IF NOT EXISTS capability_probes (
            probe_key TEXT PRIMARY KEY,
            capability_id TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            outcome TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            probed_at REAL NOT NULL,
            expires_at REAL NOT NULL DEFAULT 0
        )`);
    c.execute(
      "CREATE INDEX IF NOT EXISTS idx_cap_probe_cap ON capability_probes(capability_id, probed_at DESC)"
    );
    c.execute("CREATE INDEX IF NOT EXISTS idx_cap_probe_expiry ON capability_probes(expires_at)");
    c.commit();
  };

  proto._mig_0022_memory_hygiene = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Memory hygiene batches: what was archived/pruned and why.
    const c = self._db("memory");
    c.execute(`CREATE TABLE IF NOT EXISTS memory_hygiene_batches (
            batch_id TEXT PRIMARY KEY,
            scope TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            entries_before INTEGER NOT NULL DEFAULT 0,
            entries_removed INTEGER NOT NULL DEFAULT 0,
            started_at REAL NOT NULL,
            finished_at REAL NOT NULL DEFAULT 0
        )`);
    c.execute(`CREATE TABLE IF NOT EXISTS memory_hygiene_items (
            batch_id TEXT NOT NULL,
            memory_id TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            content_preview TEXT NOT NULL DEFAULT '',
            removed_at REAL NOT NULL
        )`);
    c.execute("CREATE INDEX IF NOT EXISTS idx_hygiene_batch ON memory_hygiene_items(batch_id)");
    c.execute("CREATE INDEX IF NOT EXISTS idx_hygiene_memory ON memory_hygiene_items(memory_id)");
    c.commit();
  };

  proto._mig_0023_workflow_patterns = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Workflow patterns distilled from run history; signature is the identity.
    const c = self._db("memory");
    c.execute(`CREATE TABLE IF NOT EXISTS workflow_patterns (
            signature TEXT PRIMARY KEY,
            label TEXT NOT NULL DEFAULT '',
            hit_count INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0,
            first_seen_at REAL NOT NULL,
            last_seen_at REAL NOT NULL,
            sample_run_id TEXT NOT NULL DEFAULT ''
        )`);
    c.execute(
      "CREATE INDEX IF NOT EXISTS idx_wf_pattern_hits ON workflow_patterns(hit_count DESC, last_seen_at DESC)"
    );
    c.commit();
  };

  proto._mig_0024_caller_call_id = function (this: StorageBase & MigrationsDomainI): void {
    const self = this;
    // Sub-agent runs remember which parent tool call dispatched them.
    // Self-healing first: borrow 0001's idempotent DDL instead of re-deriving.
    this._mig_0001_subagent_runs();
    self._safe_add_column("sessions", "subagent_runs", "caller_call_id", "TEXT DEFAULT ''");
    const s = self._db("sessions");
    s.execute("CREATE INDEX IF NOT EXISTS idx_subrun_caller ON subagent_runs(caller_call_id)");
    s.commit();
  };
}

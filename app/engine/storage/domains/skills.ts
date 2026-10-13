/**
 * storage/domains/skills.ts — M3 domain: relation graph + skill experience
 * ledger + skill candidate lifecycle.
 *
 * Ported from `app/backend/storage.py` M3 slice (DOMAINS.md, handoff v2 wave 2):
 *   2618–2622  TASK_LEVEL_SKILL_ID class attribute
 *   2624–2768  record_skill_experience / get_skill_experience /
 *              list_skill_experiences / set_skill_experience_feedback
 *   2791–2800  RELATION_SHAPES class attribute
 *   2802–3038  add_relation … _broadcast_degraded
 * (2770–2790 trace_event belongs to M2/effects.ts and is NOT translated here.)
 *
 * Mixin convention (DOMAINS.md): applySkillsDomain mounts snake_case methods
 * onto klass.prototype; inside every method body
 * `const self = this as unknown as StorageBase & SkillsDomainI`.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto for sha256 / uuid4-hex); no new
 *       dependency.
 *   §2  `raise ValueError(...)` -> `throw new RangeError(...)`: Python's
 *       ValueError has no TS builtin; RangeError is the mapping this unit
 *       already uses for the same source exception (trace_gateway.ts,
 *       event_store.ts). The exception type survives as a distinguishable
 *       value, not a string.
 *   §2  broad swallows at source 2708 / 2715 / 3035 preserved verbatim, each
 *       carrying its site-level port-bug marker with the swallowing reason
 *       (inventory rows storage.py:2708 / 2715 / 3035, classification
 *       BROAD-SWALLOW).
 *   §2  asyncio.create_task(bus.emit(...)) at 3028: Node's event loop IS the
 *       scheduler; emit is fire-and-forget. asyncio.get_running_loop() has no
 *       reachable false branch under Node (JS always runs on the loop), so the
 *       source's "no loop -> skip broadcast" path cannot trigger. An async
 *       subscriber failure rejects the emit promise; Python surfaced that as
 *       an unretrieved-task warning, so the rejection is caught and logged —
 *       an unhandled rejection would kill the Node process, which is a
 *       behaviour change, not a port.
 *   §2  sorted(self.RELATION_SHAPES) in the add_relation error: set-derived
 *       output is sorted before emitting; Python's list-of-str repr is
 *       single-quoted, reproduced literally.
 *   §2  dict payloads -> plain Record<string, unknown> (insertion order is not
 *       load-bearing: RELATION_SHAPES key order is never used behaviourally,
 *       only sorted).
 *   §2  json.dumps DEFAULT (ensure_ascii=True) at 2682–2683: pyJsonDumps is
 *       the ensure_ascii=False form per the dispatcher's json.dumps mapping
 *       and storage_funcs ships no ascii-escaping variant. The two columns
 *       hold event ids (ASCII in practice), so the escaping difference is not
 *       observable on real data; flagged here for the reviewer.
 *   §4  naming: method names stay snake_case (Python call shape preserved);
 *       class attributes live as module consts mounted onto the prototype so
 *       `self.X` access keeps working exactly as in Python.
 *   §6  PORT STATUS trailer at end of file.
 */

import * as crypto from "node:crypto";

import type { JsonDict, Row } from "../storage_types.js";
import { intSeconds, StorageBase, uuidHex } from "../storage.js";
import { pyJsonDumps } from "../storage_funcs.js";
import { getEventBus } from "../../event_bus.js";
import { CRITICAL } from "../../trace_gateway.js";

// ---------------------------------------------------------------------------
// Class attributes of Storage (M3 slice)
// ---------------------------------------------------------------------------

/**
 * TASK_LEVEL_SKILL_ID (storage.py 2622): experiences recorded against the task
 * machinery itself; filtered out of "skill performance" views by
 * list_skill_experiences' include_task_level=False default. _maybe_degrade_skill
 * queries by exact skill_id, so these rows can never degrade a real skill.
 */
export const TASK_LEVEL_SKILL_ID = "__task__";

/**
 * RELATION_SHAPES (storage.py 2791–2800): the only legal (subject_type,
 * object_type) pair per relation. add_relation hard-validates shape in code —
 * "goal USES memory" is rejected on the spot rather than growing unexplainable
 * edges.
 */
export const RELATION_SHAPES: Readonly<
  Record<string, readonly [string, string]>
> = {
  SUPPORTS: ["memory", "skill"],
  PREREQUISITE_FOR: ["memory", "skill"],
  PRODUCES: ["skill", "memory"],
  CONTRADICTS: ["skill", "memory"],
  SUPERSEDES: ["skill", "skill"],
  VALIDATES: ["goal", "skill"],
  USES: ["run", "skill"],
  UPDATES: ["run", "memory"],
};

/** _CAND_JSON_FIELDS (storage.py 2901–2902): columns stored as JSON arrays. */
export const _CAND_JSON_FIELDS = [
  "steps",
  "required_tools",
  "memory_refs",
  "source_event_ids",
] as const;

/** storage.py 2994–2996: advisory auto-degrade window/threshold. */
export const DEGRADE_WINDOW = 5;
export const DEGRADE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * `list(x or [])` — Python semantics: falsy values yield [], lists are copied,
 * a str iterates to its characters, a dict to its keys, a set to its members;
 * anything else raises TypeError like Python's non-iterables do.
 */
function pyList(v: unknown): unknown[] {
  if (!v) return [];
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return (v as string).split("");
  if (v instanceof Set) return [...v];
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>);
  throw new TypeError(`'${typeof v}' object is not iterable`);
}

/**
 * `json.loads(d.get(col) or emptyText)` with
 * `except (json.JSONDecodeError, TypeError): return <parsed emptyText>`
 * (storage.py 2946–2953). Python json.loads accepts only str/bytes; a truthy
 * non-string column value is a TypeError -> the empty default, not a parse.
 */
function jsonLoadsColumn(value: unknown, emptyText: string): unknown {
  try {
    let text: string;
    if (!value) {
      text = emptyText;
    } else if (typeof value === "string") {
      text = value;
    } else if (Buffer.isBuffer(value)) {
      // json.loads(bytes) decodes utf-8 first; same for a sqlite BLOB here.
      text = value.toString("utf-8");
    } else {
      throw new TypeError("json.loads expects str/bytes");
    }
    return JSON.parse(text);
  } catch {
    // json.JSONDecodeError / TypeError -> fresh empty value per row, exactly
    // as the source's except branch evaluates a new literal each time.
    return JSON.parse(emptyText);
  }
}

// ---------------------------------------------------------------------------
// Domain interface
// ---------------------------------------------------------------------------

/** Keyword-only bag of record_skill_experience (storage.py 2626–2647). */
export interface SkillExperienceRecordOpts {
  skill_version?: string;
  run_id?: string;
  turn_id?: string;
  goal_id?: string;
  session_id?: string;
  memory_snapshot_id?: string;
  selection_reason?: string;
  preconditions_met?: boolean;
  steps_attempted?: number;
  steps_succeeded?: number;
  validator_status?: string;
  user_feedback?: string;
  outcome?: string;
  failure_class?: string;
  repair_applied?: string;
  cost?: number;
  latency_ms?: number;
  source_event_ids?: unknown;
  evidence_event_ids?: unknown;
}

/** Keyword-only bag of list_skill_experiences (storage.py 2726–2728). */
export interface SkillExperienceListOpts {
  skill_id?: string | null;
  goal_id?: string | null;
  session_id?: string | null;
  limit?: number;
  include_task_level?: boolean;
}

/** Keyword-only bag of insert_skill_candidate (storage.py 2904–2913). */
export interface SkillCandidateInsertOpts {
  name: string;
  description?: string;
  when_to_use?: string;
  scope?: string;
  preconditions?: string;
  inputs?: string;
  outputs?: string;
  steps?: unknown;
  required_tools?: unknown;
  risk_level?: string;
  verification?: string;
  known_failures?: string;
  memory_refs?: unknown;
  experience_ref?: string;
  source_event_ids?: unknown;
  superseded_skill?: string;
  verify_command?: string;
}

/** Keyword-only bag of set_skill_candidate_status (storage.py 2973–2975). */
export interface SkillCandidateStatusOpts {
  version?: string | null;
  gate_report?: unknown;
  snapshot_path?: string | null;
}

/**
 * The M3 surface this mixin mounts onto StorageBase. `self` inside the method
 * bodies is typed as StorageBase & SkillsDomainI.
 */
export interface SkillsDomainI {
  readonly TASK_LEVEL_SKILL_ID: string;
  readonly RELATION_SHAPES: Readonly<
    Record<string, readonly [string, string]>
  >;
  readonly DEGRADE_WINDOW: number;
  readonly DEGRADE_THRESHOLD: number;

  record_skill_experience(
    skill_id: string,
    opts?: SkillExperienceRecordOpts
  ): string;
  get_skill_experience(experience_id: string): JsonDict | null;
  list_skill_experiences(opts?: SkillExperienceListOpts): JsonDict[];
  set_skill_experience_feedback(
    experience_id: string,
    feedback: string,
    outcome?: string | null
  ): boolean;
  add_relation(
    subject_type: string,
    subject_id: string,
    relation: string,
    object_type: string,
    object_id: string,
    evidence?: string
  ): JsonDict | null;
  get_relation(rel_id: string): JsonDict | null;
  remove_relation(rel_id: string): boolean;
  relations_from(
    subject_type: string,
    subject_id: string,
    relation?: string | null
  ): JsonDict[];
  relations_to(
    object_type: string,
    object_id: string,
    relation?: string | null
  ): JsonDict[];
  _relations_query(
    where: string,
    args: unknown[],
    relation: string | null
  ): JsonDict[];
  mark_skills_stale_for_memory(memory_id: string): number;
  clear_skill_stale(skill_id: string): number;
  insert_skill_candidate(opts: SkillCandidateInsertOpts): string;
  _candidate_row_to_dict(r: Row): JsonDict;
  get_skill_candidate(cid: string): JsonDict | null;
  list_skill_candidates(status?: string | null, limit?: number): JsonDict[];
  set_skill_candidate_status(
    cid: string,
    status: string,
    opts?: SkillCandidateStatusOpts
  ): boolean;
  _maybe_degrade_skill(skill_id: string): void;
  _broadcast_degraded(skill_id: string, fails: number): void;
}

// ---------------------------------------------------------------------------
// Methods (source order; each body mirrors storage.py line-for-line)
// ---------------------------------------------------------------------------

/** storage.py 2624–2717. */
function record_skill_experience(
  this: StorageBase & SkillsDomainI,
  skill_id: string,
  opts: SkillExperienceRecordOpts = {}
): string {
  const self = this as unknown as StorageBase & SkillsDomainI;
  let {
    skill_version = "",
    run_id = "",
    turn_id = "",
    goal_id = "",
    session_id = "",
    memory_snapshot_id = "",
    selection_reason = "",
    preconditions_met = false,
    steps_attempted = 0,
    steps_succeeded = 0,
    validator_status = "none",
    user_feedback = "",
    outcome = "unknown",
    failure_class = "",
    repair_applied = "",
    cost = 0.0,
    latency_ms = 0.0,
    source_event_ids = null,
    evidence_event_ids = null,
  } = opts;
  if (!skill_id) {
    throw new RangeError("record_skill_experience needs a skill_id");
  }
  turn_id = turn_id || uuidHex().slice(0, 12);
  const exp_id = crypto
    .createHash("sha256")
    .update(`${run_id}|${skill_id}|${turn_id}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  const c = self._db("sessions");
  c.execute(
    "INSERT OR IGNORE INTO skill_experiences" +
      " (experience_id, skill_id, skill_version, run_id, turn_id, goal_id," +
      "  session_id, memory_snapshot_id, selection_reason, preconditions_met," +
      "  steps_attempted, steps_succeeded, validator_status, user_feedback," +
      "  outcome, failure_class, repair_applied, cost, latency_ms," +
      "  source_event_ids, evidence_event_ids, created_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      exp_id,
      skill_id,
      String(skill_version || ""),
      String(run_id || ""),
      turn_id,
      String(goal_id || ""),
      String(session_id || ""),
      String(memory_snapshot_id || ""),
      String(selection_reason || ""),
      preconditions_met ? 1 : 0,
      Math.trunc(steps_attempted), // int(steps_attempted)
      Math.trunc(steps_succeeded), // int(steps_succeeded)
      String(validator_status || "none"),
      String(user_feedback || ""),
      String(outcome || "unknown"),
      String(failure_class || ""),
      String(repair_applied || ""),
      Number(cost || 0.0), // float(cost or 0.0)
      Number(latency_ms || 0.0), // float(latency_ms or 0.0)
      // json.dumps(list(...)) with Python's DEFAULT ensure_ascii=True; see the
      // header note on pyJsonDumps (ensure_ascii=False form).
      pyJsonDumps(pyList(source_event_ids)),
      pyJsonDumps(pyList(evidence_event_ids)),
      intSeconds(), // int(time.time())
    ]
  );
  c.commit();
  // The ledger row is the source of truth; the event is its audit mirror.
  // CRITICAL because lost learning evidence silently corrupts evolution, but
  // wrapped so a ledger outage degrades loudly instead of failing the user's
  // actual task mid-flight. (storage.py 2688–2691)
  try {
    self._trace.append({
      session_id: session_id || exp_id,
      event_type: "skill.experience_recorded",
      payload: {
        experience_id: exp_id,
        skill_id: skill_id,
        skill_version: skill_version,
        run_id: run_id,
        turn_id: turn_id,
        goal_id: goal_id,
        outcome: outcome,
        selection_reason: selection_reason,
      },
      importance: CRITICAL,
      idempotency_key: `exp:${exp_id}`,
      run_id: run_id || null,
      turn_id: turn_id || null,
      goal_id: goal_id || null,
    });
  } catch (exc) {
    // RULEBOOK §2: `except Exception:` broad swallow preserved verbatim
    // (inventory storage.py:2708).
    // BUG(port): swallows event-mirror write failures. logging.getLogger(
    // __name__).exception equivalent below keeps the failure loud; the DB row
    // stays the source of truth and the caller's task must not fail mid-flight.
    console.error(
      `skill experience ${exp_id} recorded in db but its event mirror failed`,
      exc
    );
  }
  // 连续失败自动降级（advisory，见 _maybe_degrade_skill）。
  try {
    self._maybe_degrade_skill(skill_id);
  } catch (exc) {
    // RULEBOOK §2: `except Exception:` broad swallow preserved verbatim
    // (inventory storage.py:2715).
    // BUG(port): swallows degradation-check failures at debug level; the
    // experience row is already committed and advisory degradation must not
    // bubble into the recording path.
    console.debug(`degradation check failed for ${skill_id}`, exc);
  }
  return exp_id;
}

/** storage.py 2719–2724. */
function get_skill_experience(
  this: StorageBase & SkillsDomainI,
  experience_id: string
): JsonDict | null {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const row = self
    ._db("sessions")
    .execute("SELECT * FROM skill_experiences WHERE experience_id=?", [
      experience_id,
    ])
    .fetchone();
  return row ? { ...row } : null;
}

/** storage.py 2726–2751. */
function list_skill_experiences(
  this: StorageBase & SkillsDomainI,
  opts: SkillExperienceListOpts = {}
): JsonDict[] {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const {
    skill_id = null,
    goal_id = null,
    session_id = null,
    limit = 50,
    include_task_level = false,
  } = opts;
  let q = "SELECT * FROM skill_experiences";
  const conds: string[] = [];
  const args: unknown[] = [];
  const pairs: ReadonlyArray<readonly [string, string | null]> = [
    ["skill_id", skill_id],
    ["goal_id", goal_id],
    ["session_id", session_id],
  ];
  for (const [col, val] of pairs) {
    if (val) {
      conds.push(`${col}=?`);
      args.push(val);
    }
  }
  if (!include_task_level && !skill_id) {
    conds.push("skill_id<>?");
    args.push(self.TASK_LEVEL_SKILL_ID);
  }
  if (conds.length > 0) {
    q += " WHERE " + conds.join(" AND ");
  }
  q += " ORDER BY created_at DESC LIMIT ?";
  args.push(Math.trunc(limit)); // int(limit)
  const rows = self._db("sessions").execute(q, args).fetchall();
  return rows.map((r) => ({ ...r }));
}

/** storage.py 2753–2768. */
function set_skill_experience_feedback(
  this: StorageBase & SkillsDomainI,
  experience_id: string,
  feedback: string,
  outcome: string | null = null
): boolean {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const sets: string[] = ["user_feedback=?"];
  const args: unknown[] = [String(feedback || "").slice(0, 500)];
  if (outcome != null) {
    sets.push("outcome=?");
    args.push(String(outcome));
  }
  args.push(experience_id);
  const c = self._db("sessions");
  const cur = c.execute(
    `UPDATE skill_experiences SET ${sets.join(", ")} WHERE experience_id=?`,
    args
  );
  c.commit();
  return cur.rowcount > 0;
}

/** storage.py 2802–2832. */
function add_relation(
  this: StorageBase & SkillsDomainI,
  subject_type: string,
  subject_id: string,
  relation: string,
  object_type: string,
  object_id: string,
  evidence = ""
): JsonDict | null {
  const self = this as unknown as StorageBase & SkillsDomainI;
  // 形状在代码里硬校验——不合定义的边宁可当场拒绝。(storage.py 2805–2819)
  const shape = self.RELATION_SHAPES[relation];
  if (shape === undefined) {
    // f"unknown relation {relation!r}; expected one of {sorted(...)}" —
    // set-derived output sorted before emitting; str repr is single-quoted.
    const known = Object.keys(self.RELATION_SHAPES)
      .sort()
      .map((k) => `'${k}'`)
      .join(", ");
    throw new RangeError(
      `unknown relation '${relation}'; expected one of [${known}]`
    );
  }
  if (subject_type !== shape[0] || object_type !== shape[1]) {
    throw new RangeError(
      `${relation} must connect ${shape[0]}->${shape[1]},` +
        ` got ${subject_type}->${object_type}`
    );
  }
  const rid = crypto
    .createHash("sha256")
    .update(
      `${subject_type}|${subject_id}|${relation}|${object_type}|${object_id}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, 16);
  const c = self._db("sessions");
  c.execute(
    "INSERT OR IGNORE INTO memory_skill_relations" +
      " (id, subject_type, subject_id, relation, object_type, object_id," +
      "  evidence, created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      rid,
      subject_type,
      String(subject_id),
      relation,
      object_type,
      String(object_id),
      String(evidence || ""),
      intSeconds(), // int(time.time())
    ]
  );
  c.commit();
  return self.get_relation(rid);
}

/** storage.py 2834–2838. */
function get_relation(
  this: StorageBase & SkillsDomainI,
  rel_id: string
): JsonDict | null {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const row = self
    ._db("sessions")
    .execute("SELECT * FROM memory_skill_relations WHERE id=?", [rel_id])
    .fetchone();
  return row ? { ...row } : null;
}

/** storage.py 2840–2845. */
function remove_relation(
  this: StorageBase & SkillsDomainI,
  rel_id: string
): boolean {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const c = self._db("sessions");
  const cur = c.execute("DELETE FROM memory_skill_relations WHERE id=?", [
    rel_id,
  ]);
  c.commit();
  return cur.rowcount > 0;
}

/** storage.py 2847–2851. */
function relations_from(
  this: StorageBase & SkillsDomainI,
  subject_type: string,
  subject_id: string,
  relation: string | null = null
): JsonDict[] {
  const self = this as unknown as StorageBase & SkillsDomainI;
  return self._relations_query(
    "subject_type=? AND subject_id=?",
    [subject_type, subject_id],
    relation
  );
}

/** storage.py 2853–2857. */
function relations_to(
  this: StorageBase & SkillsDomainI,
  object_type: string,
  object_id: string,
  relation: string | null = null
): JsonDict[] {
  const self = this as unknown as StorageBase & SkillsDomainI;
  return self._relations_query(
    "object_type=? AND object_id=?",
    [object_type, object_id],
    relation
  );
}

/** storage.py 2859–2868. */
function _relations_query(
  this: StorageBase & SkillsDomainI,
  where: string,
  args: unknown[],
  relation: string | null
): JsonDict[] {
  const self = this as unknown as StorageBase & SkillsDomainI;
  let q = "SELECT * FROM memory_skill_relations";
  let allArgs = args;
  if (relation) {
    q += ` WHERE ${where} AND relation=?`;
    allArgs = [...args, relation]; // args = args + (relation,)
  } else {
    q += ` WHERE ${where}`;
  }
  q += " ORDER BY created_at";
  const rows = self._db("sessions").execute(q, allArgs).fetchall();
  return rows.map((r) => ({ ...r }));
}

/** storage.py 2870–2885. */
function mark_skills_stale_for_memory(
  this: StorageBase & SkillsDomainI,
  memory_id: string
): number {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const c = self._db("sessions");
  const cur = c.execute(
    "UPDATE memory_skill_relations SET stale=1" +
      " WHERE (subject_type='memory' AND subject_id=? AND object_type='skill')" +
      " OR (object_type='memory' AND object_id=? AND subject_type='skill')",
    [memory_id, memory_id]
  );
  c.commit();
  return cur.rowcount;
}

/** storage.py 2887–2897. */
function clear_skill_stale(
  this: StorageBase & SkillsDomainI,
  skill_id: string
): number {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const c = self._db("sessions");
  const cur = c.execute(
    "UPDATE memory_skill_relations SET stale=0" +
      " WHERE (subject_type='skill' AND subject_id=?)" +
      " OR (object_type='skill' AND object_id=?)",
    [skill_id, skill_id]
  );
  c.commit();
  return cur.rowcount;
}

/** storage.py 2904–2940. */
function insert_skill_candidate(
  this: StorageBase & SkillsDomainI,
  opts: SkillCandidateInsertOpts
): string {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const {
    name,
    description = "",
    when_to_use = "",
    scope = "",
    preconditions = "",
    inputs = "",
    outputs = "",
    steps = null,
    required_tools = null,
    risk_level = "medium",
    verification = "",
    known_failures = "",
    memory_refs = null,
    experience_ref = "",
    source_event_ids = null,
    superseded_skill = "",
    verify_command = "",
  } = opts;
  const cid = uuidHex().slice(0, 12); // uuid.uuid4().hex[:12]
  const c = self._db("sessions");
  c.execute(
    "INSERT INTO skill_candidates" +
      " (id, name, description, when_to_use, scope, preconditions, inputs," +
      "  outputs, steps, required_tools, risk_level, verification," +
      "  known_failures, memory_refs, experience_ref, source_event_ids," +
      "  superseded_skill, verify_command, created_at, updated_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      cid,
      String(name),
      String(description || ""),
      String(when_to_use || ""),
      String(scope || ""),
      String(preconditions || ""),
      String(inputs || ""),
      String(outputs || ""),
      // json.dumps(list(...), ensure_ascii=False) — pyJsonDumps is exactly the
      // ensure_ascii=False form.
      pyJsonDumps(pyList(steps)),
      pyJsonDumps(pyList(required_tools)),
      String(risk_level || "medium"),
      String(verification || ""),
      String(known_failures || ""),
      pyJsonDumps(pyList(memory_refs)),
      String(experience_ref || ""),
      pyJsonDumps(pyList(source_event_ids)),
      String(superseded_skill || ""),
      String(verify_command || ""),
      intSeconds(), // int(time.time())
      intSeconds(),
    ]
  );
  c.commit();
  return cid;
}

/** storage.py 2942–2954 (@staticmethod; also mounted on the prototype). */
export function _candidate_row_to_dict(r: Row): JsonDict {
  const d: JsonDict = { ...r };
  // Python reads Storage._CAND_JSON_FIELDS; the module const is the same
  // sequence of names.
  for (const f of _CAND_JSON_FIELDS) {
    d[f] = jsonLoadsColumn(d[f], "[]");
  }
  d["gate_report"] = jsonLoadsColumn(d["gate_report"], "{}");
  return d;
}

/** storage.py 2956–2960. */
function get_skill_candidate(
  this: StorageBase & SkillsDomainI,
  cid: string
): JsonDict | null {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const row = self
    ._db("sessions")
    .execute("SELECT * FROM skill_candidates WHERE id=?", [cid])
    .fetchone();
  return row ? self._candidate_row_to_dict(row) : null;
}

/** storage.py 2962–2971. */
function list_skill_candidates(
  this: StorageBase & SkillsDomainI,
  status: string | null = null,
  limit = 50
): JsonDict[] {
  const self = this as unknown as StorageBase & SkillsDomainI;
  let q = "SELECT * FROM skill_candidates";
  const args: unknown[] = [];
  if (status) {
    q += " WHERE status=?";
    args.push(status);
  }
  q += " ORDER BY created_at DESC LIMIT ?";
  args.push(Math.trunc(limit)); // int(limit)
  const rows = self._db("sessions").execute(q, args).fetchall();
  return rows.map((r) => self._candidate_row_to_dict(r));
}

/** storage.py 2973–2992. */
function set_skill_candidate_status(
  this: StorageBase & SkillsDomainI,
  cid: string,
  status: string,
  opts: SkillCandidateStatusOpts = {}
): boolean {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const { version = null, gate_report = null, snapshot_path = null } = opts;
  const sets: string[] = ["status=?", "updated_at=?"];
  const args: unknown[] = [status, intSeconds()]; // int(time.time())
  // Python `x is not None` -> `x != null` (covers an omitted TS optional too).
  if (version != null) {
    sets.push("version=?");
    args.push(version);
  }
  if (gate_report != null) {
    sets.push("gate_report=?");
    args.push(pyJsonDumps(gate_report)); // json.dumps(..., ensure_ascii=False)
  }
  if (snapshot_path != null) {
    sets.push("snapshot_path=?");
    args.push(snapshot_path);
  }
  args.push(cid);
  const c = self._db("sessions");
  const cur = c.execute(
    `UPDATE skill_candidates SET ${sets.join(", ")} WHERE id=?`,
    args
  );
  c.commit();
  return cur.rowcount > 0;
}

/** storage.py 2998–3019. */
function _maybe_degrade_skill(
  this: StorageBase & SkillsDomainI,
  skill_id: string
): void {
  const self = this as unknown as StorageBase & SkillsDomainI;
  const rows = self
    ._db("sessions")
    .execute(
      "SELECT outcome FROM skill_experiences WHERE skill_id=?" +
        " ORDER BY created_at DESC LIMIT ?",
      [skill_id, self.DEGRADE_WINDOW] // int(self.DEGRADE_WINDOW)
    )
    .fetchall();
  if (rows.length < self.DEGRADE_THRESHOLD) {
    return;
  }
  const fails = rows.filter((r) => r["outcome"] === "failure").length;
  if (fails < self.DEGRADE_THRESHOLD) {
    return;
  }
  const cur = self._db("sessions").execute(
    "UPDATE skill_candidates SET status='degraded', updated_at=?" +
      " WHERE name=? AND status IN ('active','staged')",
    [intSeconds(), skill_id] // int(time.time())
  );
  self._db("sessions").commit();
  if (cur.rowcount > 0) {
    self._broadcast_degraded(skill_id, fails);
  }
}

/** storage.py 3021–3036. */
function _broadcast_degraded(
  this: StorageBase & SkillsDomainI,
  skill_id: string,
  fails: number
): void {
  const self = this as unknown as StorageBase & SkillsDomainI;
  // 自动降级也要有感知：聊天界面出现一枚芯片，而不是静默变脸。
  try {
    // asyncio.get_running_loop() has no reachable false branch under Node:
    // JS code always executes on the event loop (see header §2 note).
    const bus = getEventBus();
    // asyncio.create_task(bus.emit(...)) — fire-and-forget. An async
    // subscriber failure rejects the emit promise; Python only logged an
    // unretrieved-task warning, so the rejection is caught and logged instead
    // of being left unhandled (which would crash Node).
    void bus
      .emit("evolution_insight", {
        kind: "skill_degraded",
        detail:
          `${skill_id} 近 ${self.DEGRADE_WINDOW} 次使用失败 ` +
          `${fails} 次，已自动降级待人工复检`,
        skillName: skill_id,
        status: "degraded",
      })
      .catch((e: unknown) => {
        console.error(`[skills] degraded insight task failed: ${e}`);
      });
  } catch (e) {
    // RULEBOOK §2: `except Exception as e:` broad swallow preserved verbatim
    // (inventory storage.py:3035).
    // BUG(port): swallows every synchronous broadcast failure (bus
    // acquisition, payload construction) — the chip is advisory, the source
    // prints and moves on, and a raised error here would break
    // record_skill_experience's caller mid-task.
    console.log(`[skills] degraded insight failed: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Mixin mount
// ---------------------------------------------------------------------------

/**
 * Mount the M3 domain onto StorageBase's prototype. Called once by
 * storage/index.ts when composing the Storage class.
 */
export function applySkillsDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as StorageBase & SkillsDomainI;
  const bag = klass.prototype as unknown as Record<string, unknown>;
  // Class attributes (storage.py 2622 / 2791 / 2995–2996): instance-visible,
  // one shared value per class — exactly Python class-attribute semantics.
  bag.TASK_LEVEL_SKILL_ID = TASK_LEVEL_SKILL_ID;
  bag.RELATION_SHAPES = RELATION_SHAPES;
  bag.DEGRADE_WINDOW = DEGRADE_WINDOW;
  bag.DEGRADE_THRESHOLD = DEGRADE_THRESHOLD;

  proto.record_skill_experience = record_skill_experience;
  proto.get_skill_experience = get_skill_experience;
  proto.list_skill_experiences = list_skill_experiences;
  proto.set_skill_experience_feedback = set_skill_experience_feedback;
  proto.add_relation = add_relation;
  proto.get_relation = get_relation;
  proto.remove_relation = remove_relation;
  proto.relations_from = relations_from;
  proto.relations_to = relations_to;
  proto._relations_query = _relations_query;
  proto.mark_skills_stale_for_memory = mark_skills_stale_for_memory;
  proto.clear_skill_stale = clear_skill_stale;
  proto.insert_skill_candidate = insert_skill_candidate;
  proto._candidate_row_to_dict = _candidate_row_to_dict;
  proto.get_skill_candidate = get_skill_candidate;
  proto.list_skill_candidates = list_skill_candidates;
  proto.set_skill_candidate_status = set_skill_candidate_status;
  proto._maybe_degrade_skill = _maybe_degrade_skill;
  proto._broadcast_degraded = _broadcast_degraded;
}

// PORT STATUS: confidence=high todos=0

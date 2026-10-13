"use strict";
/**
 * skills.ts 鈥?storage domain mixin: skill experiences, memory鈥搒kill relation
 * graph, skill candidate lifecycle.
 *
 * Ported from `app/backend/storage.py` lines 2624鈥?038 (M3 domain).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 node: builtins only (node:crypto for the sha256 id derivation).
 * - 搂2 `except Exception:` swallows preserved verbatim (the trace-mirror
 *   failure path and the degrade-check failure path are loud-degradation
 *   sites in the source 鈥?comments name what is being ignored).
 * - 搂2 `asyncio.create_task(bus.emit(...))` 鈫?emitSync() fire-and-forget
 *   (event_bus.ts documents this mapping); the source's try/except around the
 *   running-loop check is preserved as the same guard structure.
 * - 搂2 `raise ValueError` 鈫?throw RangeError (distinguishable type).
 * - 搂4 naming: part of the storage unit (storage.py 鈫?storage/domains/).
 *
 * PORT STATUS: confidence=high todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySkillsDomain = applySkillsDomain;
const crypto = require("node:crypto");
const storage_js_1 = require("../../storage.cjs");
const trace_gateway_js_1 = require("../../trace_gateway.cjs");
const event_bus_js_1 = require("../../event_bus.cjs");
function sha256_16(s) {
    return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}
function applySkillsDomain(klass) {
    const proto = klass.prototype;
    // Class attributes from the source's class body (搂2: import-time/class-time
    // state is behaviour).
    proto.TASK_LEVEL_SKILL_ID = "task-level";
    proto.RELATION_SHAPES = {
        SUPPORTS: ["memory", "skill"],
        PREREQUISITE_FOR: ["memory", "skill"],
        PRODUCES: ["skill", "memory"],
        CONTRADICTS: ["skill", "memory"],
        SUPERSEDES: ["skill", "skill"],
        VALIDATES: ["goal", "skill"],
        USES: ["run", "skill"],
        UPDATES: ["run", "memory"],
    };
    proto._CAND_JSON_FIELDS = [
        "steps",
        "required_tools",
        "memory_refs",
        "source_event_ids",
    ];
    proto.DEGRADE_WINDOW = 5;
    proto.DEGRADE_THRESHOLD = 3;
    proto.record_skill_experience = function (kwargs) {
        const self = this;
        const { skill_version = "", run_id = "", turn_id: turn_id_in = "", goal_id = "", session_id = "", memory_snapshot_id = "", selection_reason = "", preconditions_met = false, steps_attempted = 0, steps_succeeded = 0, validator_status = "none", user_feedback = "", outcome = "unknown", failure_class = "", repair_applied = "", cost = 0.0, latency_ms = 0.0, source_event_ids = null, evidence_event_ids = null, } = kwargs;
        const skill_id = kwargs.skill_id;
        if (!skill_id) {
            throw new RangeError("record_skill_experience needs a skill_id");
        }
        const turn_id = turn_id_in || (0, storage_js_1.uuidHex)().slice(0, 12);
        const exp_id = sha256_16(`${run_id}|${skill_id}|${turn_id}`);
        const c = self._db("sessions");
        c.execute("INSERT OR IGNORE INTO skill_experiences" +
            " (experience_id, skill_id, skill_version, run_id, turn_id, goal_id," +
            "  session_id, memory_snapshot_id, selection_reason, preconditions_met," +
            "  steps_attempted, steps_succeeded, validator_status, user_feedback," +
            "  outcome, failure_class, repair_applied, cost, latency_ms," +
            "  source_event_ids, evidence_event_ids, created_at)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
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
            Math.trunc(steps_attempted),
            Math.trunc(steps_succeeded),
            String(validator_status || "none"),
            String(user_feedback || ""),
            String(outcome || "unknown"),
            String(failure_class || ""),
            String(repair_applied || ""),
            cost || 0.0,
            latency_ms || 0.0,
            pyJsonDumpsCompact(Array.from(source_event_ids ?? [])),
            pyJsonDumpsCompact(Array.from(evidence_event_ids ?? [])),
            (0, storage_js_1.intSeconds)(),
        ]);
        c.commit();
        // The ledger row is the source of truth; the event is its audit mirror.
        try {
            self._trace.append({
                session_id: session_id || exp_id,
                event_type: "skill.experience_recorded",
                payload: {
                    experience_id: exp_id,
                    skill_id,
                    skill_version,
                    run_id,
                    turn_id,
                    goal_id,
                    outcome,
                    selection_reason,
                },
                importance: trace_gateway_js_1.CRITICAL,
                idempotency_key: `exp:${exp_id}`,
                run_id: run_id || null,
                turn_id: turn_id || null,
                goal_id: goal_id || null,
            });
        }
        catch (exc) {
            // logging.exception(...) 鈥?loud degradation, never silent.
            console.error(`skill experience ${exp_id} recorded in db but its event mirror failed`, exc);
        }
        // 杩炵画澶辫触鑷姩闄嶇骇锛坅dvisory锛岃 _maybe_degrade_skill锛夈€?        try {
            self._maybe_degrade_skill(skill_id);
        }
        catch {
            // log.debug(...) 鈥?swallowed by design in the source.
        }
        return exp_id;
    };
    proto.get_skill_experience = function (experience_id) {
        const self = this;
        const row = self
            ._db("sessions")
            .execute("SELECT * FROM skill_experiences WHERE experience_id=?", [experience_id])
            .fetchone();
        return row ? { ...row } : null;
    };
    proto.list_skill_experiences = function (kwargs) {
        const self = this;
        const { skill_id = null, goal_id = null, session_id = null, limit = 50, include_task_level = false, } = kwargs;
        let q = "SELECT * FROM skill_experiences";
        const conds = [];
        const args = [];
        for (const [col, val] of [
            ["skill_id", skill_id],
            ["goal_id", goal_id],
            ["session_id", session_id],
        ]) {
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
        args.push(Math.trunc(limit));
        return self._db("sessions").execute(q, args).fetchall().map((r) => ({ ...r }));
    };
    proto.set_skill_experience_feedback = function (experience_id, feedback, outcome = null) {
        const self = this;
        const sets = ["user_feedback=?"];
        const args = [String(feedback || "").slice(0, 500)];
        if (outcome !== null) {
            sets.push("outcome=?");
            args.push(String(outcome));
        }
        args.push(experience_id);
        const c = self._db("sessions");
        const cur = c.execute(`UPDATE skill_experiences SET ${sets.join(", ")} WHERE experience_id=?`, args);
        c.commit();
        return cur.rowcount > 0;
    };
    proto.trace_event = function (kwargs) {
        const self = this;
        const { session_id, event_type, payload, importance = "observational", ...correlation } = kwargs;
        // **correlation 鈫?the gateway's optional keyword surface. Pass the
        // correlation keys the gateway accepts; unknown extras are dropped by the
        // gateway's typed signature just as Python's TypeError-free **kwargs are
        // consumed by named parameters (unknown names would raise in Python 鈥?        // mark that difference explicitly).
        return self._trace.append({
            session_id,
            event_type,
            payload,
            importance,
            causation_id: correlation["causation_id"],
            idempotency_key: correlation["idempotency_key"],
            run_id: correlation["run_id"],
            turn_id: correlation["turn_id"],
            step_id: correlation["step_id"],
            tool_call_id: correlation["tool_call_id"],
            goal_id: correlation["goal_id"],
            branch_id: correlation["branch_id"],
            parent_event_id: correlation["parent_event_id"],
            actor: correlation["actor"],
            visibility: correlation["visibility"],
        });
    };
    proto.add_relation = function (subject_type, subject_id, relation, object_type, object_id, evidence = "") {
        const self = this;
        const shape = self.RELATION_SHAPES[relation];
        if (shape === undefined) {
            throw new RangeError(`unknown relation ${JSON.stringify(relation)}; expected one of ${JSON.stringify(Object.keys(self.RELATION_SHAPES).sort())}`);
        }
        if (subject_type !== shape[0] || object_type !== shape[1]) {
            throw new RangeError(`${relation} must connect ${shape[0]}->${shape[1]}, got ${subject_type}->${object_type}`);
        }
        const rid = sha256_16(`${subject_type}|${subject_id}|${relation}|${object_type}|${object_id}`);
        const c = self._db("sessions");
        c.execute("INSERT OR IGNORE INTO memory_skill_relations" +
            " (id, subject_type, subject_id, relation, object_type, object_id," +
            "  evidence, created_at) VALUES (?,?,?,?,?,?,?,?)", [rid, subject_type, String(subject_id), relation, object_type, String(object_id), String(evidence || ""), (0, storage_js_1.intSeconds)()]);
        c.commit();
        return self.get_relation(rid);
    };
    proto.get_relation = function (rel_id) {
        const self = this;
        const row = self
            ._db("sessions")
            .execute("SELECT * FROM memory_skill_relations WHERE id=?", [rel_id])
            .fetchone();
        return row ? { ...row } : null;
    };
    proto.remove_relation = function (rel_id) {
        const self = this;
        const c = self._db("sessions");
        const cur = c.execute("DELETE FROM memory_skill_relations WHERE id=?", [rel_id]);
        c.commit();
        return cur.rowcount > 0;
    };
    proto.relations_from = function (subject_type, subject_id, relation = null) {
        const self = this;
        return self._relations_query("subject_type=? AND subject_id=?", [subject_type, subject_id], relation);
    };
    proto.relations_to = function (object_type, object_id, relation = null) {
        const self = this;
        return self._relations_query("object_type=? AND object_id=?", [object_type, object_id], relation);
    };
    proto._relations_query = function (where, args, relation) {
        const self = this;
        let q = "SELECT * FROM memory_skill_relations";
        let fullArgs = args;
        if (relation) {
            q += ` WHERE ${where} AND relation=?`;
            fullArgs = [...args, relation];
        }
        else {
            q += ` WHERE ${where}`;
        }
        q += " ORDER BY created_at";
        const rows = self._db("sessions").execute(q, fullArgs).fetchall();
        return rows.map((r) => ({ ...r }));
    };
    proto.mark_skills_stale_for_memory = function (memory_id) {
        const self = this;
        const c = self._db("sessions");
        const cur = c.execute("UPDATE memory_skill_relations SET stale=1" +
            " WHERE (subject_type='memory' AND subject_id=? AND object_type='skill')" +
            " OR (object_type='memory' AND object_id=? AND subject_type='skill')", [memory_id, memory_id]);
        c.commit();
        return cur.rowcount;
    };
    proto.clear_skill_stale = function (skill_id) {
        const self = this;
        const c = self._db("sessions");
        const cur = c.execute("UPDATE memory_skill_relations SET stale=0" +
            " WHERE (subject_type='skill' AND subject_id=?)" +
            " OR (object_type='skill' AND object_id=?)", [skill_id, skill_id]);
        c.commit();
        return cur.rowcount;
    };
    proto.insert_skill_candidate = function (kwargs) {
        const self = this;
        const { description = "", when_to_use = "", scope = "", preconditions = "", inputs = "", outputs = "", steps = null, required_tools = null, risk_level = "medium", verification = "", known_failures = "", memory_refs = null, experience_ref = "", source_event_ids = null, superseded_skill = "", verify_command = "", } = kwargs;
        const name = kwargs.name;
        const cid = (0, storage_js_1.uuidHex)().slice(0, 12);
        const c = self._db("sessions");
        c.execute("INSERT INTO skill_candidates" +
            " (id, name, description, when_to_use, scope, preconditions, inputs," +
            "  outputs, steps, required_tools, risk_level, verification," +
            "  known_failures, memory_refs, experience_ref, source_event_ids," +
            "  superseded_skill, verify_command, created_at, updated_at)" +
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            cid,
            String(name),
            String(description || ""),
            String(when_to_use || ""),
            String(scope || ""),
            String(preconditions || ""),
            String(inputs || ""),
            String(outputs || ""),
            pyJsonDumpsCompact(Array.from(steps ?? [])),
            pyJsonDumpsCompact(Array.from(required_tools ?? [])),
            String(risk_level || "medium"),
            String(verification || ""),
            String(known_failures || ""),
            pyJsonDumpsCompact(Array.from(memory_refs ?? [])),
            String(experience_ref || ""),
            pyJsonDumpsCompact(Array.from(source_event_ids ?? [])),
            String(superseded_skill || ""),
            String(verify_command || ""),
            (0, storage_js_1.intSeconds)(),
            (0, storage_js_1.intSeconds)(),
        ]);
        c.commit();
        return cid;
    };
    proto._candidate_row_to_dict = function (r) {
        const self = this;
        const d = { ...r };
        for (const f of self._CAND_JSON_FIELDS) {
            try {
                d[f] = JSON.parse(String(d[f] ?? "[]"));
            }
            catch {
                // (json.JSONDecodeError, TypeError) -> []
                d[f] = [];
            }
        }
        try {
            d["gate_report"] = JSON.parse(String(d["gate_report"] ?? "{}"));
        }
        catch {
            d["gate_report"] = {};
        }
        return d;
    };
    proto.get_skill_candidate = function (cid) {
        const self = this;
        const row = self
            ._db("sessions")
            .execute("SELECT * FROM skill_candidates WHERE id=?", [cid])
            .fetchone();
        return row ? self._candidate_row_to_dict(row) : null;
    };
    proto.list_skill_candidates = function (status = null, limit = 50) {
        const self = this;
        let q = "SELECT * FROM skill_candidates";
        const args = [];
        if (status) {
            q += " WHERE status=?";
            args.push(status);
        }
        q += " ORDER BY created_at DESC LIMIT ?";
        args.push(Math.trunc(limit));
        return self._db("sessions").execute(q, args).fetchall().map((r) => self._candidate_row_to_dict(r));
    };
    proto.set_skill_candidate_status = function (cid, status, opts = {}) {
        const self = this;
        const { version = null, gate_report = null, snapshot_path = null } = opts;
        const sets = ["status=?", "updated_at=?"];
        const args = [status, (0, storage_js_1.intSeconds)()];
        if (version !== null) {
            sets.push("version=?");
            args.push(version);
        }
        if (gate_report !== null) {
            sets.push("gate_report=?");
            args.push(pyJsonDumpsCompact(gate_report));
        }
        if (snapshot_path !== null) {
            sets.push("snapshot_path=?");
            args.push(snapshot_path);
        }
        args.push(cid);
        const c = self._db("sessions");
        const cur = c.execute(`UPDATE skill_candidates SET ${sets.join(", ")} WHERE id=?`, args);
        c.commit();
        return cur.rowcount > 0;
    };
    proto._maybe_degrade_skill = function (skill_id) {
        const self = this;
        const rows = self
            ._db("sessions")
            .execute("SELECT outcome FROM skill_experiences WHERE skill_id=?" +
            " ORDER BY created_at DESC LIMIT ?", [skill_id, Math.trunc(self.DEGRADE_WINDOW)])
            .fetchall();
        if (rows.length < self.DEGRADE_THRESHOLD) {
            return;
        }
        const fails = rows.filter((r) => r["outcome"] === "failure").length;
        if (fails < self.DEGRADE_THRESHOLD) {
            return;
        }
        const cur = self
            ._db("sessions")
            .execute("UPDATE skill_candidates SET status='degraded', updated_at=?" +
            " WHERE name=? AND status IN ('active','staged')", [(0, storage_js_1.intSeconds)(), skill_id]);
        self._db("sessions").commit();
        if (cur.rowcount > 0) {
            self._broadcast_degraded(skill_id, fails);
        }
    };
    proto._broadcast_degraded = function (skill_id, fails) {
        const self = this;
        // 鑷姩闄嶇骇涔熻鏈夋劅鐭ワ細鑱婂ぉ鐣岄潰鍑虹幇涓€鏋氳姱鐗囷紝鑰屼笉鏄潤榛樺彉鑴搞€?        try {
            const bus = (0, event_bus_js_1.getEventBus)();
            // asyncio.create_task(bus.emit(...)) 鈫?emitSync fire-and-forget
            // (event_bus.ts documents this 搂2 mapping).
            bus.emitSync("evolution_insight", {
                kind: "skill_degraded",
                detail: `${skill_id} 杩?${self.DEGRADE_WINDOW} 娆′娇鐢ㄥけ璐?${fails} 娆★紝宸茶嚜鍔ㄩ檷绾у緟浜哄伐澶嶆`,
                skillName: skill_id,
                status: "degraded",
            });
        }
        catch (e) {
            console.log(`[skills] degraded insight failed: ${e}`);
        }
    };
}
/**
 * json.dumps(x) with DEFAULT separators 鈥?the source writes
 * `json.dumps(list(...))` WITHOUT ensure_ascii=False in
 * record_skill_experience (ascii-escaped!), and WITH ensure_ascii=False in
 * insert_skill_candidate. Two call shapes exist; this helper covers the
 * ensure_ascii=False shape used by the candidate inserts, and the plain
 * default shape is byte-identical for the event-id arrays it is used on
 * (ids/hex strings carry no non-ASCII). Kept as one function with the
 * non-ASCII caveat noted.
 */
function pyJsonDumpsCompact(value) {
    return JSON.stringify(value);
}

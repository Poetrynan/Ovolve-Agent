"use strict";
/**
 * wiki_store.ts 鈥?declarative knowledge: structured claims with confidence and
 * evidence.
 *
 * Ported from `app/backend/wiki_store.py` (686 lines).
 *
 * The rest of the memory system stores *episodic* memories 鈥?free-text notes
 * with an importance number. That fails at declarative facts: no structure, no
 * provenance, no confidence, no successors.
 *
 * Wiki claims are the declarative counterpart. Each row is a
 * (subject, predicate, object) triple with a confidence in 0..1, an evidence
 * list, a contradictions list, and a status 鈥?active / superseded / disputed /
 * deleted. Only `active` and `disputed` reach the prompt.
 *
 * Contradiction detection runs on insert, in two heuristics:
 *   1. structural 鈥?same normalized (subject, predicate), different object;
 *   2. textual 鈥?same subject/predicate where exactly one side carries a
 *      negation marker.
 * The check is deterministic and cheap, with no LLM in the write path, because
 * a wiki that occasionally hallucinates contradictions would be worse than none.
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/wiki_store.py -> app/engine/wiki_store.ts
 *   搂2  dataclass -> class; asdict -> toDict
 *   搂2  broad swallow: every JSON-parse and missing-column fallback is preserved
 *   搂2  float formatting: `:.2f` -> toFixed(2)
 *   搂2  casefold: see the TODO(port) on `normalize`
 *
 * PORT STATUS: confidence=high todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WikiStore = exports.WikiClaim = exports.LIVE_STATUSES = exports.STATUSES = exports.STATUS_DELETED = exports.STATUS_DISPUTED = exports.STATUS_SUPERSEDED = exports.STATUS_ACTIVE = void 0;
exports.normalize = normalize;
exports.subjectPredicateKey = subjectPredicateKey;
exports.hasNegation = hasNegation;
exports.tripleFromText = tripleFromText;
const node_crypto_1 = require("node:crypto");
// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------
/** `active` is the default; `superseded` means a later claim replaces it (the row is kept for audit); `disputed` means an active contradiction exists and neither side won yet. */
exports.STATUS_ACTIVE = "active";
exports.STATUS_SUPERSEDED = "superseded";
exports.STATUS_DISPUTED = "disputed";
/**
 * Deleting a claim used to be a hard DELETE, while memory's delete is an archive
 * (reversible, leaves a trace). The same "delete" button meaning two different
 * things across two kinds of knowledge is a split that has to go: this adds a
 * tombstone status. Hard delete is still available (`WikiStore.delete`), but the
 * default path is soft.
 */
exports.STATUS_DELETED = "deleted";
/** Every legal status. An unknown status is refused, never written. */
exports.STATUSES = [exports.STATUS_ACTIVE, exports.STATUS_DISPUTED, exports.STATUS_SUPERSEDED, exports.STATUS_DELETED];
/**
 * Statuses that can still reach the prompt. `disputed` is included 鈥?a conflict
 * must be visible to the model so it can adjudicate; hiding it only lets the
 * model keep reasoning from half the facts.
 */
exports.LIVE_STATUSES = [exports.STATUS_ACTIVE, exports.STATUS_DISPUTED];
/**
 * Negation markers used by the textual heuristic. Kept short and literal 鈥? * false negatives are fine (the structural check catches most conflicts), but a
 * false positive here would turn every "not sure" into a contradiction.
 */
const NEGATION_MARKERS = [
    "涓?, "闈?, "娌?, "鏃?, "鍒?,
    "no ", "not ", "never ", "no longer ", "used to ", "isn't ", "aren't ",
    "doesn't ", "don't ", "won't ", "wouldn't ", "cannot ", "can't ",
];
/**
 * A single declarative claim.
 *
 * `subject` + `predicate` form the natural key; `object` may be empty for
 * existential claims, in which case contradiction detection falls back to
 * negation-marker matching.
 */
class WikiClaim {
    id;
    rootDir;
    subject;
    predicate;
    object;
    /** the full human-readable form */
    statement;
    /** 0..1 */
    confidence;
    /** memory ids, urls, refs */
    evidence;
    /** ids of conflicting claims */
    contradicts;
    status;
    /** "user" / "model" / "extraction" */
    source;
    createdAt;
    updatedAt;
    /** why it became the status it is */
    statusReason;
    constructor(f) {
        this.id = f.id;
        this.rootDir = f.rootDir;
        this.subject = f.subject;
        this.predicate = f.predicate;
        this.object = f.object;
        this.statement = f.statement;
        this.confidence = f.confidence;
        this.evidence = f.evidence ?? [];
        this.contradicts = f.contradicts ?? [];
        this.status = f.status ?? exports.STATUS_ACTIVE;
        this.source = f.source ?? "";
        this.createdAt = f.createdAt ?? 0;
        this.updatedAt = f.updatedAt ?? 0;
        this.statusReason = f.statusReason ?? "";
    }
    toDict() {
        return {
            id: this.id,
            root_dir: this.rootDir,
            subject: this.subject,
            predicate: this.predicate,
            object: this.object,
            statement: this.statement,
            confidence: this.confidence,
            evidence: this.evidence,
            contradicts: this.contradicts,
            status: this.status,
            source: this.source,
            created_at: this.createdAt,
            updated_at: this.updatedAt,
            status_reason: this.statusReason,
        };
    }
    /** Build from a database row. Tolerates missing evidence/contradicts. */
    static fromRow(row) {
        const parse = (raw) => {
            if (!raw) {
                return [];
            }
            if (Array.isArray(raw)) {
                return raw.map((x) => String(x));
            }
            try {
                const v = JSON.parse(String(raw));
                return Array.isArray(v) ? v.map((x) => String(x)) : [];
            }
            catch {
                return [];
            }
        };
        /**
         * Read a column that may not exist yet.
         *
         * `status_reason` was added later and `_ensure_schema` only runs when a
         * WikiStore is constructed; if another path already holds rows from this
         * table, this falls back to an empty string rather than taking down the
         * whole read path. Python's sqlite3.Row raises IndexError for a missing key;
         * node:sqlite yields undefined, so both are handled.
         */
        const opt = (key) => {
            try {
                const v = row[key];
                return v === null || v === undefined ? "" : String(v);
            }
            catch {
                return "";
            }
        };
        const str = (key) => {
            const v = row[key];
            return v === null || v === undefined ? "" : String(v);
        };
        return new WikiClaim({
            id: str("id"),
            rootDir: str("root_dir"),
            subject: str("subject"),
            predicate: str("predicate"),
            object: str("object"),
            statement: str("statement"),
            confidence: Number(row["confidence"] ?? 0.0) || 0.0,
            evidence: parse(row["evidence_json"]),
            contradicts: parse(row["contradicts_json"]),
            status: str("status") || exports.STATUS_ACTIVE,
            source: str("source"),
            createdAt: Number(row["created_at"] ?? 0) || 0,
            updatedAt: Number(row["updated_at"] ?? 0) || 0,
            statusReason: opt("status_reason"),
        });
    }
}
exports.WikiClaim = WikiClaim;
// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
const WS = /\s+/g;
/**
 * Case-fold and collapse whitespace. Used for the subject/predicate key.
 *
 * Deliberately does NOT stem or expand synonyms 鈥?"prefers" and "preferred" stay
 * distinct, because merging them silently is worse than a rare missed conflict.
 *
 * TODO(port): Python's `str.casefold()` is not `toLowerCase()`. casefold maps
 * 脽 to ss and a handful of other full-case-folding pairs; toLowerCase does not.
 * The difference only shows on those specific characters, and the key is an
 * internal grouping hash, so it is recorded rather than worked around 鈥?a
 * faithful casefold would need a Unicode case-folding table the target does not
 * ship.
 */
function normalize(text) {
    if (!text) {
        return "";
    }
    return text.trim().toLowerCase().replace(WS, " ");
}
/** Stable hash used as the "same attribute" grouping key. */
function subjectPredicateKey(subject, predicate) {
    const payload = `${normalize(subject)}\x1f${normalize(predicate)}`;
    return (0, node_crypto_1.createHash)("sha1").update(payload, "utf8").digest("hex").slice(0, 16);
}
/**
 * True when `text` contains any of the tracked negation markers.
 *
 * Case-insensitive for ASCII, exact for CJK (CJK negation words rarely change
 * case).
 */
function hasNegation(text) {
    if (!text) {
        return false;
    }
    const low = text.toLowerCase();
    return NEGATION_MARKERS.some((m) => low.includes(m));
}
/**
 * Free text -> SPO triple. Deliberately SINGLE-VALUE predicates only.
 *
 * The structural conflict test is "same subject+predicate, different object is a
 * contradiction". That only holds for single-valued attributes: a person has one
 * name, so "my name is Zhang" and "my name is Li" cannot both be right.
 * Multi-valued attributes would make it cry wolf 鈥?"I like coffee" and "I like
 * tea" share s+p with different objects, and both are true. So `鍋忓ソ` / `浣跨敤`
 * are NOT in this table, even though the patterns could recognise them.
 *
 * To add a predicate, first answer: is having two values at once necessarily a
 * contradiction? If not, don't add it 鈥?one occasionally-wrong conflict view and
 * users will ignore the real ones too.
 *
 * Each entry is (subject, predicate, pattern); the pattern matches the WHOLE
 * string and group 1 is the object. Every pattern leaves room for a negation
 * marker (涓?/ don't), so the object parses out of a negative sentence too.
 */
const TRIPLE_PATTERNS = [
    ["鐢ㄦ埛", "鍚嶅瓧", /\s*my name is(?:n't| not)?\s+(.{1,40}?)\s*[.銆?锛乚?\s*/i],
    ["鐢ㄦ埛", "鍚嶅瓧", /\s*鎴??:鐨勫悕瀛??(?:涓峾骞朵笉)?(?:灏??鍙玕s*(.{1,40}?)\s*[.銆?锛乚?\s*/i],
    ["鐢ㄦ埛", "宸ヤ綔鍗曚綅", /\s*i (?:don't |do not )?work at\s+(.{1,40}?)\s*[.銆?锛乚?\s*/i],
    ["鐢ㄦ埛", "宸ヤ綔鍗曚綅", /\s*鎴??:涓峾娌娌℃湁|宸茬粡涓??鍦╘s*(.{1,40}?)\s*宸ヤ綔\s*[.銆?锛乚?\s*/i],
    ["鐢ㄦ埛", "鏃跺尯", /\s*my timezone is(?:n't| not)?\s+(.{1,40}?)\s*[.銆?锛乚?\s*/i],
    ["鐢ㄦ埛", "鏃跺尯", /\s*鎴??:鐨??鏃跺尯(?:涓??鏄痋s*(.{1,40}?)\s*[.銆?锛乚?\s*/i],
].map(([s, p, re]) => [s, p, re]);
/**
 * If the object contains any of these, the match was only half a sentence.
 * A claim is either a complete sentence or it is not made 鈥?a half sentence
 * injected into the prompt is indistinguishable from a truncated one.
 */
const OBJECT_REJECT = /[锛?銆傦紱;锛?锛?\n銆乚/;
/**
 * Parse a sentence into (subject, predicate, object), or null.
 *
 * Rather miss than cry wolf: whole-string match, object length cap, and no
 * punctuation inside the object. Together those mean "my name is Zhang, and by
 * the way鈥? is passed over rather than having "Zhang, and by the way鈥? written
 * into the wiki as the user's name.
 *
 * A negative sentence MUST still parse its object, and the same one as the
 * affirmative ("I don't work at Byte" yields "Byte"). The raw statement goes to
 * `hasNegation`; same s+p with one positive and one negative is what makes a
 * contradiction. Dropping negatives here would mean "I don't work at X" never
 * meets "I work at X" 鈥?and that is exactly the conflict most worth finding.
 */
function tripleFromText(text) {
    const s = String(text ?? "").trim();
    if (!s) {
        return null;
    }
    for (const [subject, predicate, pat] of TRIPLE_PATTERNS) {
        // RULEBOOK 搂2 (regex): Python's `fullmatch` requires the whole string; JS
        // needs explicit anchors. `$` without `m` matches only at the very end, so
        // this is equivalent.
        const anchored = new RegExp(`^(?:${pat.source})$`, pat.flags.replace("g", ""));
        const m = anchored.exec(s);
        if (!m) {
            continue;
        }
        const obj = (m[1] ?? "").replace(/^[ \t銆侊紝,锛?]+|[ \t銆侊紝,锛?]+$/g, "");
        if (!obj || OBJECT_REJECT.test(obj)) {
            continue;
        }
        return [subject, predicate, obj];
    }
    return null;
}
// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
/**
 * SQLite-backed store for WikiClaim rows.
 *
 * Reuses the storage layer's memory database connection so wiki tables live next
 * to the episodic memory tables 鈥?schema evolution, backup and workspace scoping
 * all work unchanged. This class does not open its own connection; the caller
 * passes the storage in.
 */
class WikiStore {
    storage;
    constructor(storage) {
        this.storage = storage;
        this._ensureSchema();
    }
    // 鈹€鈹€ schema 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    /**
     * Idempotent DDL. Runs on every construction 鈥?cheap, and it lets an old
     * upgrade path pick up the table without a separate migration step.
     */
    _ensureSchema() {
        const db = this.storage._db("memory");
        db.execute("CREATE TABLE IF NOT EXISTS wiki_claims (" +
            "id TEXT PRIMARY KEY, root_dir TEXT, subject TEXT, predicate TEXT, " +
            "object TEXT, statement TEXT, confidence REAL DEFAULT 0.5, " +
            "evidence_json TEXT DEFAULT '[]', contradicts_json TEXT DEFAULT '[]', " +
            "status TEXT DEFAULT 'active', source TEXT DEFAULT '', " +
            "sp_key TEXT, created_at INTEGER, updated_at INTEGER)");
        // Two indexes, both essential to keep contradiction detection proportional
        // to the claims sharing a subject/predicate instead of a full scan per write.
        db.execute("CREATE INDEX IF NOT EXISTS idx_wiki_root ON wiki_claims(root_dir, status)");
        db.execute("CREATE INDEX IF NOT EXISTS idx_wiki_sp   ON wiki_claims(sp_key, root_dir)");
        // Added later. Defaulted and unconstrained, so it cannot fail on historical
        // rows; a repeat run raises "duplicate column", which is the expected path
        // and not an error.
        try {
            db.execute("ALTER TABLE wiki_claims ADD COLUMN status_reason TEXT DEFAULT ''");
        }
        catch {
            /* RULEBOOK 搂2: preserved 鈥?sqlite3.OperationalError("duplicate column") */
        }
        db.commit();
    }
    // 鈹€鈹€ mutation 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    /**
     * Insert a claim and run contradiction detection.
     *
     * Returns (newClaim, conflicts). When conflicts is non-empty the new row is
     * bidirectionally linked to each and BOTH sides become `disputed`. The caller
     * decides what happens next 鈥?the store never auto-supersedes, because that
     * would silently drop a claim the user might have meant to keep.
     */
    add(f) {
        const confidence = Math.max(0.0, Math.min(1.0, Number(f.confidence ?? 0.5)));
        const object = f.object ?? "";
        const statement = f.statement || `${f.subject} ${f.predicate} ${object}`.trim();
        const cid = f.claimId || (0, node_crypto_1.randomUUID)().replace(/-/g, "");
        const now = Math.floor(Date.now() / 1000);
        const spKey = subjectPredicateKey(f.subject, f.predicate);
        const evidenceList = Array.from(f.evidence ?? [], (e) => String(e));
        const db = this.storage._db("memory");
        // Contradiction detection has to see the current state BEFORE we insert;
        // otherwise the new row would count itself as a peer.
        const peers = this._activePeers(f.rootDir, spKey, null);
        const conflicts = this._detectConflicts(object, statement, peers);
        const status = conflicts.length ? exports.STATUS_DISPUTED : exports.STATUS_ACTIVE;
        db.execute("INSERT INTO wiki_claims " +
            "(id, root_dir, subject, predicate, object, statement, confidence, " +
            "evidence_json, contradicts_json, status, source, sp_key, " +
            "created_at, updated_at) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            cid, f.rootDir, f.subject, f.predicate, object, statement,
            confidence,
            JSON.stringify(evidenceList),
            JSON.stringify(conflicts.map((c) => c.id)),
            status, f.source ?? "user", spKey, now, now,
        ]);
        // Link the peer side symmetrically so retrieval from either direction
        // surfaces the disagreement.
        for (const peer of conflicts) {
            const newIds = Array.from(new Set([...peer.contradicts, cid])).sort();
            db.execute("UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?", [JSON.stringify(newIds), exports.STATUS_DISPUTED, now, peer.id]);
        }
        db.commit();
        const created = new WikiClaim({
            id: cid, rootDir: f.rootDir, subject: f.subject, predicate: f.predicate,
            object, statement, confidence, evidence: evidenceList,
            contradicts: conflicts.map((c) => c.id),
            status, source: f.source ?? "user", createdAt: now, updatedAt: now,
        });
        return [created, conflicts];
    }
    /**
     * Explicit resolution: mark `oldId` superseded by `newId`.
     *
     * The caller drives this 鈥?a UI where the user picks which of two disputed
     * claims is right. We do not guess from confidence; a higher-confidence wrong
     * claim would silently silence a lower-confidence correct one.
     */
    supersede(oldId, newId) {
        const db = this.storage._db("memory");
        const now = Math.floor(Date.now() / 1000);
        db.execute("UPDATE wiki_claims SET status = ?, updated_at = ? WHERE id = ?", [
            exports.STATUS_SUPERSEDED, now, oldId,
        ]);
        // If both sides were disputed and only one survives, the survivor goes back
        // to active. Any OTHER contradictions the survivor has stay.
        const row = db.execute("SELECT * FROM wiki_claims WHERE id = ?", [newId]).fetchone();
        if (row !== null) {
            const others = parseJsonArray(row["contradicts_json"]);
            const stillActive = others.filter((x) => x !== oldId);
            const activePeers = stillActive.length
                ? db
                    .execute(`SELECT id FROM wiki_claims WHERE id IN (${stillActive.map(() => "?").join(",")}) AND status = ?`, [...stillActive, exports.STATUS_ACTIVE])
                    .fetchall()
                : [];
            const newStatus = activePeers.length ? exports.STATUS_DISPUTED : exports.STATUS_ACTIVE;
            db.execute("UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?", [JSON.stringify(stillActive), newStatus, now, newId]);
        }
        db.commit();
    }
    /**
     * Change a claim's status. An illegal transition is refused loudly and the
     * return value says whether anything changed.
     *
     * Why not free assignment: `disputed` is DERIVED from contradicts_json, so
     * writing it directly would create a second source of truth for the same fact.
     * Only two intents are accepted:
     *   - to `superseded` / `deleted`: a human decision, allowed at any time;
     *   - back to `active`: only when no live contradicting peer remains,
     *     otherwise the UI would show a claim as "not conflicting" while its peer
     *     still records the conflict.
     * To express `disputed`, go through `add` or `delete` (which recompute it).
     */
    setStatus(claimId, status, reason = "") {
        const want = String(status ?? "");
        if (!exports.STATUSES.includes(want)) {
            console.error(`[wiki] set_status: unknown status ${JSON.stringify(want)} for ${claimId}`);
            return false;
        }
        if (want === exports.STATUS_DISPUTED) {
            console.error(`[wiki] set_status: ${exports.STATUS_DISPUTED} is derived from contradicts, refusing to set it directly on ${claimId}`);
            return false;
        }
        const db = this.storage._db("memory");
        const row = db
            .execute("SELECT root_dir, sp_key, status, contradicts_json FROM wiki_claims WHERE id = ?", [claimId])
            .fetchone();
        if (row === null) {
            console.error(`[wiki] set_status: no such claim ${claimId}`);
            return false;
        }
        const cur = String(row["status"] ?? exports.STATUS_ACTIVE) || exports.STATUS_ACTIVE;
        if (cur === want) {
            return true; // idempotent
        }
        if (want === exports.STATUS_ACTIVE) {
            const peers = this._activePeers(String(row["root_dir"] ?? ""), String(row["sp_key"] ?? ""), claimId);
            if (peers.length) {
                console.error(`[wiki] refused ${cur} -> active on ${claimId}: ${peers.length} live peer(s) still contradict it 鈥?the write did NOT happen`);
                return false;
            }
        }
        db.execute("UPDATE wiki_claims SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?", [
            want, String(reason ?? ""), Math.floor(Date.now() / 1000), claimId,
        ]);
        db.commit();
        return true;
    }
    /**
     * Set a claim's confidence to `value` (clamped to [0,1]); returns the new value.
     *
     * Returns the value rather than a boolean because the caller (a user clicking
     * "more trustworthy") has to show the result. `-1.0` means the claim does not
     * exist. An upper layer may clamp more tightly (memory uses [0.05, 0.95]); this
     * only guarantees [0,1] and does not decide for the layer above.
     */
    setConfidence(claimId, value, reason = "") {
        const db = this.storage._db("memory");
        const row = db.execute("SELECT confidence FROM wiki_claims WHERE id = ?", [claimId]).fetchone();
        if (row === null) {
            console.error(`[wiki] set_confidence: no such claim ${claimId}`);
            return -1.0;
        }
        const next = Math.max(0.0, Math.min(1.0, Number(value)));
        db.execute("UPDATE wiki_claims SET confidence = ?, status_reason = CASE" +
            " WHEN ?<>'' THEN ? ELSE status_reason END, updated_at = ?" +
            " WHERE id = ?", [next, String(reason ?? ""), String(reason ?? ""), Math.floor(Date.now() / 1000), claimId]);
        db.commit();
        return next;
    }
    /**
     * Tombstone delete: the row stays, but it no longer reaches the prompt and no
     * longer takes part in contradiction detection.
     *
     * Aligned with memory's "delete is archive". To actually erase, use `delete` 鈥?     * that is irreversible and should only run on an explicit "remove it
     * completely" from the user.
     */
    softDelete(claimId, reason = "user_deleted") {
        const ok = this.setStatus(claimId, exports.STATUS_DELETED, reason);
        if (!ok) {
            return false;
        }
        // The peer side must drop this id from contradicts, or it would stay
        // disputed forever 鈥?the UI showing "conflict" with no opponent to name.
        this._unlinkPeers(claimId);
        return true;
    }
    /** Remove `claimId` from every peer's contradicts list and recompute their statuses. */
    _unlinkPeers(claimId) {
        const db = this.storage._db("memory");
        const row = db.execute("SELECT contradicts_json FROM wiki_claims WHERE id = ?", [claimId]).fetchone();
        if (row === null) {
            return;
        }
        const peerIds = parseJsonArray(row["contradicts_json"]);
        const now = Math.floor(Date.now() / 1000);
        for (const pid of peerIds) {
            const r = db.execute("SELECT contradicts_json FROM wiki_claims WHERE id = ?", [pid]).fetchone();
            if (r === null) {
                continue;
            }
            const cur = parseJsonArray(r["contradicts_json"]).filter((x) => x !== claimId);
            db.execute("UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?", [
                JSON.stringify(cur), cur.length ? exports.STATUS_DISPUTED : exports.STATUS_ACTIVE, now, pid,
            ]);
        }
        db.commit();
    }
    /** Hard-delete a claim. Also removes it from peers' contradicts lists. */
    delete(claimId) {
        const db = this.storage._db("memory");
        // Load peers first so their lists can be updated after the delete.
        const row = db.execute("SELECT contradicts_json FROM wiki_claims WHERE id = ?", [claimId]).fetchone();
        const peerIds = row === null ? [] : parseJsonArray(row["contradicts_json"]);
        db.execute("DELETE FROM wiki_claims WHERE id = ?", [claimId]);
        const now = Math.floor(Date.now() / 1000);
        for (const pid of peerIds) {
            const r = db.execute("SELECT contradicts_json FROM wiki_claims WHERE id = ?", [pid]).fetchone();
            if (r === null) {
                continue;
            }
            const cur = parseJsonArray(r["contradicts_json"]).filter((x) => x !== claimId);
            const newStatus = cur.length ? exports.STATUS_DISPUTED : exports.STATUS_ACTIVE;
            db.execute("UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?", [
                JSON.stringify(cur), newStatus, now, pid,
            ]);
        }
        db.commit();
    }
    // 鈹€鈹€ queries 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    get(claimId) {
        const row = this.storage._db("memory").execute("SELECT * FROM wiki_claims WHERE id = ?", [claimId]).fetchone();
        return row ? WikiClaim.fromRow(row) : null;
    }
    listClaims(rootDir, opts = {}) {
        const where = ["root_dir = ?"];
        const params = [rootDir];
        if (opts.status) {
            where.push("status = ?");
            params.push(opts.status);
        }
        else if (!opts.includeDeleted) {
            // A tombstone does not appear in the list by default. An explicit
            // status='deleted' still finds them, because "what was it that I deleted"
            // is a reasonable question.
            where.push("COALESCE(status,'active') != ?");
            params.push(exports.STATUS_DELETED);
        }
        if (opts.subject) {
            where.push("subject = ?");
            params.push(opts.subject);
        }
        const rows = this.storage
            ._db("memory")
            .execute(`SELECT * FROM wiki_claims WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`, [...params, Math.trunc(opts.limit ?? 200)])
            .fetchall();
        return rows.map((r) => WikiClaim.fromRow(r));
    }
    /** All claims currently disputed 鈥?feeds the UI adjudication view. */
    disputed(rootDir, limit = 50) {
        return this.listClaims(rootDir, { status: exports.STATUS_DISPUTED, limit });
    }
    /**
     * All active or disputed claims sharing subject+predicate.
     *
     * Superseded rows are excluded 鈥?they exist only for audit and must not cause
     * new contradictions to be re-flagged.
     */
    _activePeers(rootDir, spKey, excludeId) {
        const params = [rootDir, spKey];
        let sql = "SELECT * FROM wiki_claims WHERE root_dir = ? AND sp_key = ? " +
            "AND status IN ('active','disputed')";
        if (excludeId) {
            sql += " AND id != ?";
            params.push(excludeId);
        }
        return this.storage
            ._db("memory")
            .execute(sql, params)
            .fetchall()
            .map((r) => WikiClaim.fromRow(r));
    }
    /** Two-stage contradiction check (structural, then textual). */
    _detectConflicts(newObject, newStatement, peers) {
        const conflicts = [];
        const newObjNorm = normalize(newObject);
        const newNegated = hasNegation(newStatement);
        for (const peer of peers) {
            const peerObjNorm = normalize(peer.object);
            // Structural: same s+p, different object. An empty object is treated as
            // "not asserting an object", so "" vs "Paris" is NOT a conflict 鈥?one side
            // is silent on the object, not disagreeing.
            if (newObjNorm && peerObjNorm && newObjNorm !== peerObjNorm) {
                conflicts.push(peer);
                continue;
            }
            // Textual: same s+p (and either same or blank object), one negated and the
            // other not.
            if (newNegated !== hasNegation(peer.statement)) {
                conflicts.push(peer);
            }
        }
        return conflicts;
    }
    // 鈹€鈹€ rendering 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    /**
     * Format active claims as a compact prompt block.
     *
     * Disputed claims are rendered with an explicit `鈿犲啿绐乣 marker so the model
     * surfaces the disagreement rather than picking one silently.
     */
    renderBlock(rootDir, limit = 20) {
        const rows = this.listClaims(rootDir, { limit });
        if (!rows.length) {
            return "";
        }
        // Sort: disputed first (they need adjudication), then by confidence desc.
        // RULEBOOK 搂2 (sort stability): the source sorts on a two-key tuple; the
        // comparator below is the direct equivalent.
        rows.sort((a, b) => {
            const ka = a.status === exports.STATUS_DISPUTED ? 0 : 1;
            const kb = b.status === exports.STATUS_DISPUTED ? 0 : 1;
            if (ka !== kb) {
                return ka - kb;
            }
            return b.confidence - a.confidence;
        });
        const lines = ["<wiki-claims>"];
        for (const c of rows) {
            if (!exports.LIVE_STATUSES.includes(c.status)) {
                continue;
            }
            const marker = c.status === exports.STATUS_DISPUTED ? "鈿犲啿绐?" : "";
            lines.push(`  <claim id="${c.id.slice(0, 8)}" confidence="${c.confidence.toFixed(2)}" ` +
                `status="${c.status}">${marker}${c.statement}</claim>`);
        }
        lines.push("</wiki-claims>");
        return lines.join("\n");
    }
    /** Counts by status. */
    stats(rootDir) {
        const db = this.storage._db("memory");
        const rows = rootDir
            ? db
                .execute("SELECT status, COUNT(*) AS n FROM wiki_claims WHERE root_dir = ? GROUP BY status", [rootDir])
                .fetchall()
            : db.execute("SELECT status, COUNT(*) AS n FROM wiki_claims GROUP BY status").fetchall();
        const out = {
            [exports.STATUS_ACTIVE]: 0,
            [exports.STATUS_DISPUTED]: 0,
            [exports.STATUS_SUPERSEDED]: 0,
            [exports.STATUS_DELETED]: 0,
        };
        for (const r of rows) {
            const k = String(r["status"] ?? exports.STATUS_ACTIVE) || exports.STATUS_ACTIVE;
            out[k] = Number(r["n"] ?? 0);
        }
        // `total` excludes tombstones: the UI's "N claims" should mean "I have N
        // claims now"; counting deleted ones would only make a delete look ignored.
        out["total"] = Object.entries(out)
            .filter(([k]) => k !== exports.STATUS_DELETED)
            .reduce((sum, [, v]) => sum + v, 0);
        return out;
    }
}
exports.WikiStore = WikiStore;
/**
 * RULEBOOK 搂2 (broad swallow): the source catches (JSONDecodeError, TypeError)
 * and falls back to an empty list. Reproduced once here rather than at each of
 * the five call sites.
 */
function parseJsonArray(raw) {
    if (!raw) {
        return [];
    }
    try {
        const v = JSON.parse(String(raw));
        return Array.isArray(v) ? v.map((x) => String(x)) : [];
    }
    catch {
        return [];
    }
}

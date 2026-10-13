"use strict";
/**
 * storage.ts 鈥?composition root of the storage unit.
 *
 * Ported from `app/backend/storage.py` (5882 lines).
 *
 * ARCHITECTURE (RULEBOOK 搂0 redesign): the Python module's Storage class is
 * split across domain mixins under `storage/` (sessions / effects / skills /
 * goals / memory / recall). This file composes them into the `Storage` class,
 * hosts the `get_storage()` singleton, and re-exports the module-level surface
 * (`split_usage_model_id`, `PROCESS_GENERATION`, `SUBAGENT_TERMINAL_STATUSES`).
 *
 * RULEBOOK CITATIONS
 *   搂2  import-time side effects are behaviour: applying the mixins at module
 *       load mirrors how Python's class body attached its methods 鈥?nothing
 *       else runs here at import time.
 *   搂2  `get_storage()` process-wide singleton, same lazy semantics.
 *   搂4  naming: app/backend/storage.py -> app/engine/storage.ts (this file is
 *       the unit's output; burndown's done-test checks it).
 *   搂4  `__init__.py` re-export rule: the module-level names Python callers
 *       imported from `storage` are re-exported here.
 *
 * PORT STATUS: confidence=medium todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.uuidHex12 = exports.uuidHex = exports.nowMs = exports.intSeconds = exports.StorageBase = exports.MigrationUnrecoverable = exports.SUBAGENT_TERMINAL_STATUSES = exports.PROCESS_GENERATION = exports.split_usage_model_id = exports.Storage = void 0;
exports.get_storage = get_storage;
const storage_js_1 = require("./storage/storage.cjs");
const sessions_js_1 = require("./storage/domains/sessions.cjs");
const effects_js_1 = require("./storage/domains/effects.cjs");
const skills_js_1 = require("./storage/domains/skills.cjs");
const goals_js_1 = require("./storage/domains/goals.cjs");
const memory_js_1 = require("./storage/domains/memory.cjs");
const recall_js_1 = require("./storage/domains/recall.cjs");
// Mixin application order is irrelevant to behaviour (each mounts disjoint
// method names onto the prototype), but is fixed here for reviewability:
// source-method order within storage.py.
(0, sessions_js_1.applySessionsDomain)(storage_js_1.StorageBase);
(0, effects_js_1.applyEffectsDomain)(storage_js_1.StorageBase);
(0, skills_js_1.applySkillsDomain)(storage_js_1.StorageBase);
(0, goals_js_1.applyGoalsDomain)(storage_js_1.StorageBase);
(0, memory_js_1.applyMemoryDomain)(storage_js_1.StorageBase);
(0, recall_js_1.applyRecallDomain)(storage_js_1.StorageBase);
/** The composed Storage: every domain method mounted via prototype mixins. */
class Storage extends storage_js_1.StorageBase {
}
exports.Storage = Storage;
let _storage = null;
/** Process-wide singleton (mirrors storage.py's module-level `_storage`). */
function get_storage() {
    if (_storage === null) {
        _storage = new Storage();
    }
    return _storage;
}
// Module-level surface of storage.py, re-exported for callers.
var storage_js_2 = require("./storage/storage.cjs");
Object.defineProperty(exports, "split_usage_model_id", { enumerable: true, get: function () { return storage_js_2.split_usage_model_id; } });
Object.defineProperty(exports, "PROCESS_GENERATION", { enumerable: true, get: function () { return storage_js_2.PROCESS_GENERATION; } });
Object.defineProperty(exports, "SUBAGENT_TERMINAL_STATUSES", { enumerable: true, get: function () { return storage_js_2.SUBAGENT_TERMINAL_STATUSES; } });
var storage_js_3 = require("./storage/storage.cjs");
Object.defineProperty(exports, "MigrationUnrecoverable", { enumerable: true, get: function () { return storage_js_3.MigrationUnrecoverable; } });
var storage_js_4 = require("./storage/storage.cjs");
Object.defineProperty(exports, "StorageBase", { enumerable: true, get: function () { return storage_js_4.StorageBase; } });
// Shared helpers re-exported at the composition root so domain mixin files
// (which import "../../storage.js") and external callers both resolve them 鈥?// the TS path "../../storage.js" from storage/domains/ IS this file.
var storage_js_5 = require("./storage/storage.cjs");
Object.defineProperty(exports, "intSeconds", { enumerable: true, get: function () { return storage_js_5.intSeconds; } });
Object.defineProperty(exports, "nowMs", { enumerable: true, get: function () { return storage_js_5.nowMs; } });
Object.defineProperty(exports, "uuidHex", { enumerable: true, get: function () { return storage_js_5.uuidHex; } });
Object.defineProperty(exports, "uuidHex12", { enumerable: true, get: function () { return storage_js_5.uuidHex12; } });

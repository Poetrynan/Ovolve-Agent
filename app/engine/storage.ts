/**
 * storage.ts — composition root of the storage unit.
 *
 * Ported from `app/backend/storage.py` (5882 lines).
 *
 * ARCHITECTURE (RULEBOOK §0 redesign): the Python module's Storage class is
 * split across domain mixins under `storage/` (sessions / effects / skills /
 * goals / memory / recall). This file composes them into the `Storage` class,
 * hosts the `get_storage()` singleton, and re-exports the module-level surface
 * (`split_usage_model_id`, `PROCESS_GENERATION`, `SUBAGENT_TERMINAL_STATUSES`).
 *
 * RULEBOOK CITATIONS
 *   §2  import-time side effects are behaviour: applying the mixins at module
 *       load mirrors how Python's class body attached its methods — nothing
 *       else runs here at import time.
 *   §2  `get_storage()` process-wide singleton, same lazy semantics.
 *   §4  naming: app/backend/storage.py -> app/engine/storage.ts (this file is
 *       the unit's output; burndown's done-test checks it).
 *   §4  `__init__.py` re-export rule: the module-level names Python callers
 *       imported from `storage` are re-exported here.
 *
 * PORT STATUS: confidence=medium todos=0
 */

import { StorageBase } from "./storage/storage.js";

import { applySessionsDomain } from "./storage/domains/sessions.js";
import { applyEffectsDomain } from "./storage/domains/effects.js";
import { applySkillsDomain } from "./storage/domains/skills.js";
import { applyGoalsDomain } from "./storage/domains/goals.js";
import { applyMemoryDomain } from "./storage/domains/memory.js";
import { applyRecallDomain } from "./storage/domains/recall.js";
import { applyMigrationsDomain } from "./storage/domains/migrations.js";

// Mixin application order is irrelevant to behaviour (each mounts disjoint
// method names onto the prototype), but is fixed here for reviewability:
// source-method order within storage.py.
applySessionsDomain(StorageBase);
applyEffectsDomain(StorageBase);
applySkillsDomain(StorageBase);
applyGoalsDomain(StorageBase);
applyMemoryDomain(StorageBase);
applyRecallDomain(StorageBase);
applyMigrationsDomain(StorageBase);
/** The composed Storage: every domain method mounted via prototype mixins. */
export class Storage extends StorageBase {}

let _storage: Storage | null = null;

/** Process-wide singleton (mirrors storage.py's module-level `_storage`). */
export function get_storage(): Storage {
  if (_storage === null) {
    _storage = new Storage();
  }
  return _storage;
}

// Module-level surface of storage.py, re-exported for callers.
export { split_usage_model_id, PROCESS_GENERATION, SUBAGENT_TERMINAL_STATUSES } from "./storage/storage.js";
export { MigrationUnrecoverable } from "./storage/storage.js";
export { StorageBase } from "./storage/storage.js";
// Shared helpers re-exported at the composition root so domain mixin files
// (which import "../../storage.js") and external callers both resolve them —
// the TS path "../../storage.js" from storage/domains/ IS this file.
export { intSeconds, nowMs, uuidHex, uuidHex12 } from "./storage/storage.js";

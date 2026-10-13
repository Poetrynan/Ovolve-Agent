"use strict";
/**
 * storage_types.ts 鈥?shared types for the storage subsystem.
 *
 * RULEBOOK CITATIONS
 *   搂4  home module for shared types used across the storage split; the
 *       storage unit is one source module, so its internal shared shapes live
 *       beside it instead of polluting engine/types.ts.
 *   搂2  `dict` payloads are plain Record<string, unknown> unless order is
 *       load-bearing (it is not for any storage payload).
 *
 * PORT STATUS: n/a (support module of the storage unit, not a translated unit)
 */
Object.defineProperty(exports, "__esModule", { value: true });

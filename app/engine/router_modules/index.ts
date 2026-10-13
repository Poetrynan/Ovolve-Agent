// router_modules/index.ts — Modular components extracted from router.py monolith.
// Re-exports all router mixin classes from their respective submodules.
//
// Bug-for-bug port of `app/backend/router_modules/__init__.py` (17 lines). The
// source has two distinct orders and BOTH are observable, so both are preserved
// verbatim:
//   * import / declaration order: admission, dispatch, goal, loop, prompt;
//   * `__all__` (star-export) order: admission, loop, dispatch, prompt, goal —
//     i.e. NOT the declaration order (the source's own inconsistency, kept).
// Parity cases `surface#ns_router_order`, `surface#all_order`,
// `boundary#all_equals_import_order` pin both.
//
// DIVERGENCE(port): CPython exposes `__all__` as a module attribute that drives
//   `from router_modules import *`; ESM has no star-export list, so the same
//   list is exported verbatim as `const __all__`. Equivalence: every observable
//   of the Python attribute (membership, order, duplicate-freeness, every entry
//   actually bound in the package namespace, `sorted(__all__) == star surface`)
//   is reproduced by the const and asserted on both sides; the TS probe removes
//   the `__all__` key itself from the namespace surface, exactly as CPython
//   keeps the dunder out of the star surface.
// DIVERGENCE(port): an ES module namespace object reports its keys in
//   spec-mandated ascending order (ECMAScript 9.4.6.8), while CPython's module
//   `__dict__` reports insertion order. The two coincide here only because the
//   five mixin names are in alphabetical order, which is also the source's
//   import order; `boundary#ns_order_is_sorted` pins the coincidence instead of
//   assuming it.
// DIVERGENCE(port): `from __future__ import annotations` (source line 2) and the
//   implicit `router_modules.admission`/`dispatch`/`goal`/`loop`/`prompt`
//   submodule attributes the import machinery binds onto the package are
//   CPython import-machinery artefacts with no JS analogue (TS annotations are
//   erased at compile time; ESM has no package namespace). Neither changes any
//   value the barrel hands to a consumer, so neither is observable through the
//   shared table; they are recorded here rather than faked.
// DIVERGENCE(port): the five classes themselves are ported by their own units
//   (185-189); this barrel only re-exports them, so the probe compares the
//   re-export identity (same object as the submodule export, constructor name,
//   instance type name) and not the class bodies.

export { RouterAdmissionMixin } from "./admission.js";
export { RouterDispatchMixin } from "./dispatch.js";
export { RouterGoalMixin } from "./goal.js";
export { RouterLoopMixin } from "./loop.js";
export { RouterPromptMixin } from "./prompt.js";

/** Mirrors the Python module attribute `__all__` entry for entry, in order. */
export const __all__: string[] = [
  "RouterAdmissionMixin",
  "RouterLoopMixin",
  "RouterDispatchMixin",
  "RouterPromptMixin",
  "RouterGoalMixin",
];

// PORT STATUS: 本文件无 TODO(port)。

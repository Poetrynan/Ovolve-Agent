/**
 * sqlite.d.ts — minimal type declarations for Node's built-in `node:sqlite`.
 *
 * RULEBOOK §1: no new dependency may be introduced without a row naming it.
 * `node:sqlite` is a Node builtin (verified working on the pinned runtime,
 * v22.22.2, with an experimental warning), so it needs no row — but the pinned
 * `@types/node` is 20.x, which predates it. These declarations cover exactly the
 * surface this migration uses, and no more.
 */

declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

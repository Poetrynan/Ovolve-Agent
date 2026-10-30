/**
 * artifact_index.ts — Session artifact index: one flat, newest-first list of
 * everything a session produced.
 *
 * The union logic lives here rather than in the caller because it spans three
 * stores that know nothing about each other: message metadata carries the image
 * references, the snapshot ledger carries the file pre-images, and the disk
 * decides whether either still exists.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { get_snapshot_store } from "./snapshot_store.js";

export const MAX_ARTIFACTS = 400;

export function _rel(filePath: string, workspace: string): string {
  if (!workspace) {
    return filePath;
  }
  try {
    const rel = path.relative(workspace, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return filePath;
    }
    return rel.split(path.sep).join("/");
  } catch {
    return filePath;
  }
}

export function _turn_map(messages: unknown[]): number[] {
  const out: number[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    if (rec["role"] !== "user") continue;
    out.push(Number(rec["seq"] ?? 0));
  }
  return out;
}

export function _turn_for_seq(user_seqs: number[], seq: number): number {
  let turn = -1;
  for (let i = 0; i < user_seqs.length; i++) {
    if (user_seqs[i]! <= seq) {
      turn = i;
    } else {
      break;
    }
  }
  return turn;
}

export function _image_artifacts(messages: unknown[], user_seqs: number[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const raw = (rec["metadata"] as unknown) ?? "{}";
    let meta: Record<string, unknown> = {};
    try {
      meta = typeof raw === "string" ? JSON.parse(raw) : (raw || {});
    } catch {
      continue;
    }
    const refs = meta["images"];
    if (!Array.isArray(refs)) {
      continue;
    }
    const seq = Number(rec["seq"] ?? 0);
    const created = Number(rec["created_at"] ?? 0);

    for (const ref of refs) {
      if (!ref || typeof ref !== "object" || !(ref as Record<string, unknown>)["id"]) {
        continue;
      }
      const r = ref as Record<string, unknown>;
      out.push({
        id: `img:${r["id"]}`,
        kind: "image",
        name: r["name"] || `${r["id"]}.${r["ext"] || "png"}`,
        path: r["path"] || "",
        url: r["url"] || `/api/images/${r["id"]}`,
        mime: r["mime"] || "image/png",
        bytes: Number(r["bytes"] ?? 0),
        tool: "",
        change: "created",
        revisions: 1,
        exists: true,
        seq,
        turnIndex: _turn_for_seq(user_seqs, seq),
        createdAt: created,
      });
    }
  }
  return out;
}

export function _file_artifacts(
  rows: unknown[],
  workspace: string,
  user_seqs: number[],
): Record<string, unknown>[] {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const r0 of rows || []) {
    if (!r0 || typeof r0 !== "object") continue;
    const r = r0 as Record<string, unknown>;
    const targetPath = String(r["path"] ?? "");
    if (!targetPath || r["kind"] === "dir") {
      continue;
    }
    const seq = Number(r["seq"] ?? 0);
    let entry = byPath.get(targetPath);
    if (!entry) {
      entry = {
        id: `file:${targetPath}`,
        kind: "file",
        name: path.basename(targetPath) || targetPath,
        path: _rel(targetPath, workspace),
        url: "",
        mime: "",
        bytes: 0,
        tool: r["tool_name"] || "",
        change: r["kind"] === "missing" ? "created" : "modified",
        revisions: 1,
        exists: false,
        seq,
        turnIndex: _turn_for_seq(user_seqs, seq),
        createdAt: Number(r["created_at"] ?? 0),
      };
      byPath.set(targetPath, entry);
      continue;
    }

    entry["revisions"] = Number(entry["revisions"] ?? 1) + 1;
    if (seq >= Number(entry["seq"] ?? 0)) {
      entry["seq"] = seq;
      entry["turnIndex"] = _turn_for_seq(user_seqs, seq);
      entry["createdAt"] = Number(r["created_at"] ?? 0);
      entry["tool"] = r["tool_name"] || entry["tool"];
    }
  }

  for (const [targetPath, entry] of byPath.entries()) {
    try {
      const st = fs.statSync(targetPath);
      entry["exists"] = true;
      entry["bytes"] = Number(st.size);
    } catch {
      entry["exists"] = false;
    }
  }

  return Array.from(byPath.values());
}

export function build_index(
  storage: {
    get_messages?: (sid: string, limit: number, offset: number) => unknown[];
    getMessages?: (sid: string, limit: number, offset: number) => unknown[];
  },
  session_id: string,
  workspace = "",
): Record<string, unknown> {
  let messages: unknown[] = [];
  try {
    if (typeof storage.get_messages === "function") {
      messages = storage.get_messages(session_id, 5000, 0) || [];
    } else if (typeof storage.getMessages === "function") {
      messages = storage.getMessages(session_id, 5000, 0) || [];
    }
  } catch {
    messages = [];
  }
  const user_seqs = _turn_map(messages);

  const artifacts: Record<string, unknown>[] = [];
  try {
    artifacts.push(..._image_artifacts(messages, user_seqs));
  } catch {
    // fail-open
  }

  try {
    const rows = get_snapshot_store().list_since(session_id, 0);
    artifacts.push(..._file_artifacts(rows, workspace, user_seqs));
  } catch {
    // fail-open
  }

  // Newest first: createdAt DESC, seq DESC.
  artifacts.sort((a, b) => {
    const ac = Number(a["createdAt"] ?? 0);
    const bc = Number(b["createdAt"] ?? 0);
    if (bc !== ac) {
      return bc - ac;
    }
    return Number(b["seq"] ?? 0) - Number(a["seq"] ?? 0);
  });

  const total = artifacts.length;
  const sliced = artifacts.slice(0, MAX_ARTIFACTS);

  return {
    sessionId: session_id,
    workspace: workspace || "",
    total,
    truncated: total > sliced.length,
    counts: {
      image: sliced.filter((a) => a["kind"] === "image").length,
      file: sliced.filter((a) => a["kind"] === "file").length,
    },
    artifacts: sliced,
  };
}
